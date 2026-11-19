import { createServer } from 'node:http';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { decide, mode } from './model.mjs';

const MAX_ROUNDS = 100;
const MIN_PARTICIPANTS = 2;
const MAX_PARTICIPANTS = 10;
const MAX_NAME_LENGTH = 24;
const ROUND_CONCURRENCY = 3;
const host = process.env.HOST || '127.0.0.1';
const port = Number(process.env.PORT || 3000);
const adminKey = process.env.FORUM_ADMIN_KEY || '';
const loopback = new Set(['127.0.0.1', '::1', 'localhost']);
if (mode === 'codex' && !loopback.has(host)) {
  throw new Error('Codex subscription mode requires a loopback listener.');
}
if ((!loopback.has(host) || mode === 'live') && !adminKey) {
  throw new Error('Set FORUM_ADMIN_KEY for live mode or a non-loopback listener.');
}

const dbPath = process.env.FORUM_DB || 'data/forum.sqlite';
if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true });
const db = new DatabaseSync(dbPath);
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  CREATE TABLE IF NOT EXISTS topics (
    id TEXT PRIMARY KEY, title TEXT NOT NULL, context TEXT NOT NULL,
    roles TEXT NOT NULL, mode TEXT NOT NULL, created_at TEXT NOT NULL,
    rounds INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'running', reason TEXT
  );
  CREATE TABLE IF NOT EXISTS posts (
    id TEXT PRIMARY KEY, topic_id TEXT NOT NULL REFERENCES topics(id),
    role_id TEXT NOT NULL, round INTEGER NOT NULL, text TEXT NOT NULL,
    reply_to TEXT REFERENCES posts(id),
    UNIQUE(topic_id, role_id, round)
  );
  CREATE INDEX IF NOT EXISTS posts_by_topic ON posts(topic_id, round);
`);

const assets = new Map([
  ['/app.js', ['text/javascript; charset=utf-8', readFileSync(new URL('./public/app.js', import.meta.url))]],
  ['/style.css', ['text/css; charset=utf-8', readFileSync(new URL('./public/style.css', import.meta.url))]]
]);
const page = readFileSync(new URL('./public/index.html', import.meta.url));
const topicById = db.prepare('SELECT * FROM topics WHERE id = ?');
const recentPosts = db.prepare(`
  SELECT id, role_id AS roleId, round, text, reply_to AS replyTo
  FROM posts WHERE topic_id = ? AND round >= ? ORDER BY round, rowid
`);
const addPost = db.prepare('INSERT INTO posts (id, topic_id, role_id, round, text, reply_to) VALUES (?, ?, ?, ?, ?, ?)');
const updateTopic = db.prepare('UPDATE topics SET rounds = ?, status = ?, reason = ? WHERE id = ?');
const canReplyTo = db.prepare('SELECT 1 FROM posts WHERE id = ? AND topic_id = ?');

function serializeTopic(row) {
  const { created_at: createdAt, roles, ...rest } = row;
  return { ...rest, createdAt, roles: JSON.parse(roles), maxRounds: MAX_ROUNDS };
}

function resultToPost(result, role, topic) {
  if (result?.decision === 'pass') return null;
  if (result?.decision !== 'post' || typeof result.text !== 'string' ||
      !result.text.trim() || result.text.length > 2400 ||
      (result.replyTo !== null && (typeof result.replyTo !== 'string' || !canReplyTo.get(result.replyTo, topic.id)))) {
    throw new Error('Invalid decision for ' + role.id);
  }
  return { roleId: role.id, text: result.text.trim(), replyTo: result.replyTo };
}

function commitRound(topic, round, posts) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const latest = topicById.get(topic.id);
    if (latest?.status === 'running' && latest.rounds === topic.rounds) {
      for (const post of posts) {
        addPost.run(randomUUID(), topic.id, post.roleId, round, post.text, post.replyTo);
      }
      const reason = posts.length === 0 ? 'quiet' : round === MAX_ROUNDS ? 'limit' : null;
      updateTopic.run(round, reason ? 'finished' : 'running', reason, topic.id);
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

let processing = false;
async function processQueue() {
  if (processing) return;
  processing = true;
  try {
    while (true) {
      const row = db.prepare("SELECT * FROM topics WHERE status = 'running' ORDER BY rounds, created_at, id LIMIT 1").get();
      if (!row) break;
      const topic = serializeTopic(row);
      try {
        const round = topic.rounds + 1;
        const posts = recentPosts.all(topic.id, Math.max(1, round - 8));
        const newPosts = [];
        for (let offset = 0; offset < topic.roles.length; offset += ROUND_CONCURRENCY) {
          const batch = topic.roles.slice(offset, offset + ROUND_CONCURRENCY);
          const decisions = await Promise.allSettled(batch.map((role) => decide(topic, role, round, posts)));
          for (const [index, decision] of decisions.entries()) {
            if (decision.status === 'rejected') throw decision.reason;
            const post = resultToPost(decision.value, batch[index], topic);
            if (post) newPosts.push(post);
          }
        }
        commitRound(topic, round, newPosts);
      } catch (error) {
        console.error('Discussion failed:', topic.id, error.message);
        db.prepare("UPDATE topics SET status = 'failed', reason = 'model_error' WHERE id = ? AND status = 'running' AND rounds = ?")
          .run(topic.id, row.rounds);
      }
    }
  } finally {
    processing = false;
  }
}

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function authorized(req) {
  if (!adminKey) {
    const endpoint = new URL('http://' + req.headers.host);
    const hostname = endpoint.hostname.replace(/^\[|\]$/g, '');
    return loopback.has(hostname) &&
      (!req.headers.origin || req.headers.origin === endpoint.origin);
  }
  const expected = Buffer.from('Bearer ' + adminKey);
  const actual = Buffer.from(req.headers.authorization || '');
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

async function readInput(req) {
  if (req.headers['content-type']?.split(';')[0] !== 'application/json') {
    throw new HttpError(415, '需要 JSON 请求。');
  }
  const chunks = [];
  let length = 0;
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    length += chunk.length;
    if (length > 24_576) throw new HttpError(413, '请求内容过长。');
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, '请求格式无效。');
  }
}

function createTopic(input) {
  const title = typeof input?.title === 'string' ? input.title.trim() : '';
  const context = typeof input?.context === 'string' ? input.context.trim() : '';
  if (!title || title.length > 160 || context.length > 4000) {
    throw new HttpError(400, '请输入 1–160 字的题目，背景最多 4000 字。');
  }
  const { participantCount, participantNames } = input;
  if (!Number.isInteger(participantCount) || participantCount < MIN_PARTICIPANTS || participantCount > MAX_PARTICIPANTS) {
    throw new HttpError(400, '请选择 ' + MIN_PARTICIPANTS + '–' + MAX_PARTICIPANTS + ' 位 AI 参与者。');
  }
  if (participantNames !== undefined && (!Array.isArray(participantNames) ||
      participantNames.length !== participantCount ||
      participantNames.some((name) => typeof name !== 'string' || name.trim().length > MAX_NAME_LENGTH || /[\r\n]/.test(name)))) {
    throw new HttpError(400, '名字最多 ' + MAX_NAME_LENGTH + ' 个字符，并且必须与参与人数对应。');
  }
  const roles = Array.from({ length: participantCount }, (_, index) => {
    const number = index + 1;
    return {
      id: 'ai-' + number,
      name: participantNames?.[index].trim() || 'AI ' + number,
      initials: String(number)
    };
  });
  if (new Set(roles.map(({ name }) => name.normalize('NFKC').toLowerCase())).size !== roles.length) {
    throw new HttpError(400, '同一帖子里的 AI 名字不能重复。');
  }
  const id = randomUUID();
  db.prepare('INSERT INTO topics (id, title, context, roles, mode, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(id, title, context, JSON.stringify(roles), mode, new Date().toISOString());
  setImmediate(() => void processQueue().catch(console.error));
  return id;
}

function send(res, status, contentType, body) {
  res.writeHead(status, {
    'content-type': contentType, 'cache-control': 'no-store',
    'x-content-type-options': 'nosniff', 'referrer-policy': 'same-origin',
    'content-security-policy': "default-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"
  });
  res.end(body);
}

function json(res, status, value) {
  send(res, status, 'application/json; charset=utf-8', JSON.stringify(value));
}

const topicRoute = /^\/topics\/([a-f0-9-]{36})$/;
const server = createServer(async (req, res) => {
  try {
    const path = new URL(req.url, 'http://localhost').pathname;
    if (req.method === 'GET') {
      if (assets.has(path)) return send(res, 200, ...assets.get(path));
      if (path === '/' || path === '/new' || topicRoute.test(path)) {
        const topic = path.match(topicRoute);
        return send(res, topic && !topicById.get(topic[1]) ? 404 : 200, 'text/html; charset=utf-8', page);
      }
      if (path === '/api/config') {
        return json(res, 200, {
          mode, maxRounds: MAX_ROUNDS, requiresKey: !!adminKey,
          minParticipants: MIN_PARTICIPANTS, maxParticipants: MAX_PARTICIPANTS,
          maxNameLength: MAX_NAME_LENGTH
        });
      }
      if (path === '/api/topics') {
        const topics = db.prepare(`
          SELECT topics.*, (SELECT count(*) FROM posts WHERE topic_id = topics.id) AS postCount
          FROM topics ORDER BY created_at DESC, id DESC LIMIT 100
        `).all().map(serializeTopic);
        return json(res, 200, topics);
      }
      const match = path.startsWith('/api/') && path.slice(4).match(topicRoute);
      if (match) {
        const row = topicById.get(match[1]);
        if (!row) throw new HttpError(404, '找不到这个话题。');
        return json(res, 200, { ...serializeTopic(row), posts: recentPosts.all(row.id, 1) });
      }
    }
    if (req.method === 'POST' && path === '/api/topics') {
      if (!authorized(req)) throw new HttpError(401, '请输入有效的主持人密钥。');
      return json(res, 201, { id: createTopic(await readInput(req)) });
    }
    throw new HttpError(404, '页面不存在。');
  } catch (error) {
    if (!(error instanceof HttpError)) console.error(error);
    json(res, error.status || 500, error.status ? error.message : '服务器暂时无法处理请求。');
  }
});

server.listen(port, host, () => {
  const address = host.includes(':') ? '[' + host + ']' : host;
  console.log('Local: http://' + address + ':' + server.address().port + ' (' + mode + ')');
  void processQueue().catch(console.error);
});
