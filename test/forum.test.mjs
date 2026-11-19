import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
import assert from 'node:assert/strict';
import test from 'node:test';

async function start(t, env) {
  const child = spawn(process.execPath, ['server.mjs'], {
    env: { ...process.env, HOST: '127.0.0.1', PORT: '0', FORUM_DB: ':memory:',
      OPENAI_API_KEY: '', FORUM_ADMIN_KEY: '', FORUM_PROVIDER: 'demo', ...env },
    stdio: ['ignore', 'pipe', 'inherit']
  });
  const exited = once(child, 'exit');
  t.after(async () => {
    child.kill();
    await exited;
  });
  const lines = createInterface({ input: child.stdout });
  const [line] = await Promise.race([
    once(lines, 'line'),
    exited.then(([code]) => { throw new Error('Server exited with ' + code); })
  ]);
  return line.split(' ')[1];
}

async function create(base, title, key) {
  const response = await fetch(base + '/api/topics', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(key && { authorization: 'Bearer ' + key }) },
    body: JSON.stringify({ title, participantCount: 2 })
  });
  assert.equal(response.status, 201);
  const { id } = await response.json();
  return '/topics/' + id;
}

async function finished(base, path) {
  for (let i = 0; i < 500; i++) {
    const response = await fetch(base + '/api' + path);
    assert.equal(response.status, 200);
    const topic = await response.json();
    if (topic.status !== 'running') return topic;
    await delay(20);
  }
  throw new Error('Discussion did not finish');
}

test('local demo creates a public discussion and links a reply', { timeout: 12000 }, async (t) => {
  const base = await start(t, {});
  const page = await fetch(base + '/new');
  assert.equal(page.status, 200);
  assert.match(await page.text(), /AI 讨论场/);
  const path = await create(base, '要不要试四天工作制？');
  assert.equal((await fetch(base + path)).status, 200);
  const topic = await finished(base, path);
  assert.equal(topic.mode, 'demo');
  assert.deepEqual(topic.roles.map(({ name }) => name), ['AI 1', 'AI 2']);
  assert.equal(topic.reason, 'quiet');
  assert.equal(topic.rounds, 3);
  assert.equal(topic.posts[2].replyTo, topic.posts[0].id);
});

test('model decisions can resume after a pass, end quietly, hit 100, or fail', { timeout: 15000 }, async (t) => {
  const mock = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const request = JSON.parse(Buffer.concat(chunks));
    const { participant, round, title, recentPosts } = JSON.parse(request.input);
    if (title === '出错') return res.writeHead(502).end();
    if (Object.keys(participant).join() !== 'id' || request.text.format.type !== 'json_schema') {
      return res.writeHead(400).end();
    }
    const speak = title === '持续' || (title === '接着讨论' &&
      ((round === 1 && participant.id === 'ai-1') || (round === 2 && participant.id === 'ai-2')));
    const result = {
      decision: speak ? 'post' : 'pass',
      text: speak ? '第 ' + round + ' 轮的意见。' : '',
      replyTo: speak ? recentPosts.at(-1)?.id ?? null : null
    };
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ status: 'completed', output: [{ content: [{ type: 'output_text', text: JSON.stringify(result) }] }] }));
  });
  mock.listen(0, '127.0.0.1');
  await once(mock, 'listening');
  t.after(() => new Promise((resolve) => mock.close(resolve)));
  const base = await start(t, {
    FORUM_PROVIDER: 'live', OPENAI_API_KEY: 'test-only', FORUM_ADMIN_KEY: 'test-admin',
    OPENAI_RESPONSES_URL: 'http://127.0.0.1:' + mock.address().port
  });
  const blocked = await fetch(base + '/api/topics', { method: 'POST' });
  assert.equal(blocked.status, 401);

  const run = async (title) => finished(base, await create(base, title, 'test-admin'));
  const quiet = await run('都跳过');
  assert.equal(quiet.reason, 'quiet');
  assert.equal(quiet.rounds, 1);
  assert.deepEqual(quiet.posts, []);

  const resumed = await run('接着讨论');
  assert.equal(resumed.rounds, 3);
  assert.deepEqual(resumed.posts.map((post) => post.roleId), ['ai-1', 'ai-2']);
  assert.equal(resumed.posts[1].replyTo, resumed.posts[0].id);

  const sustained = await run('持续');
  assert.equal(sustained.rounds, 100);
  assert.equal(sustained.reason, 'limit');
  assert.equal(sustained.posts.length, 200);

  const failed = await run('出错');
  assert.equal(failed.status, 'failed');
  assert.equal(failed.rounds, 0);
});
