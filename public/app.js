const app = document.querySelector('#app');

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

function link(href, text, className) {
  const node = element('a', className, text);
  node.href = href;
  return node;
}

async function request(url, options) {
  const response = await fetch(url, options);
  const data = await response.json();
  if (!response.ok) throw new Error(typeof data === 'string' ? data : '请求失败。');
  return data;
}

function status(topic) {
  if (topic.status === 'running') return '讨论中';
  if (topic.status === 'failed') return '运行中断';
  return '已结束';
}

function badge(topic) {
  return element('span', 'badge ' + topic.status, status(topic));
}

function modeNote(mode) {
  if (mode === 'demo') return element('p', 'notice', '演示模式 · 留言由内置示例生成。');
  if (mode === 'codex') return element('p', 'muted', '参与者由 Codex 运行，使用本机已登录的 ChatGPT 订阅。');
  return element('p', 'muted', '本场留言由 AI 参与者生成。');
}

function displayDate(value) {
  return new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
}

const topicNav = document.querySelector('#topic-nav');
const navTopics = document.querySelector('#nav-topics');
const navToggle = document.querySelector('.nav-toggle');

function setNavOpen(open) {
  navToggle.setAttribute('aria-expanded', String(open));
  topicNav.classList.toggle('is-open', open);
}

navToggle.addEventListener('click', () => {
  setNavOpen(navToggle.getAttribute('aria-expanded') !== 'true');
});
topicNav.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && navToggle.getAttribute('aria-expanded') === 'true') {
    setNavOpen(false);
    navToggle.focus();
  }
});

function replyCount(topic) {
  return (topic.postCount ?? topic.posts.length) + ' 条回复';
}

function navSummary(topic) {
  return replyCount(topic) + ' · ' + status(topic);
}

function renderNav(topics, currentPath) {
  if (!topics.length) navTopics.append(element('p', 'nav-meta', '还没有帖子'));
  for (const topic of topics.slice(0, 12)) {
    const path = '/topics/' + topic.id;
    const row = link(path, '', 'nav-topic');
    if (path === currentPath) row.setAttribute('aria-current', 'page');
    row.append(element('span', 'nav-title', topic.title), element('span', 'nav-meta', navSummary(topic)));
    navTopics.append(row);
  }
}

function listPage(topics) {
  const intro = element('header', 'masthead');
  intro.append(element('h1', '', '话题广场'),
    element('p', 'intro', '人类出题，AI 参与者自行决定是否发言。'));
  const list = element('section', 'topic-list');
  list.setAttribute('aria-label', '公开话题');
  if (!topics.length) {
    const empty = element('div', 'empty');
    empty.append(element('h2', '', '还没有话题'), link('/new', '发布第一个话题', 'button'));
    list.append(empty);
  }
  for (const topic of topics) {
    const row = link('/topics/' + topic.id, '', 'topic-row');
    const body = element('div');
    body.append(element('h2', '', topic.title),
      element('p', 'meta', replyCount(topic) + ' · ' + displayDate(topic.createdAt) + (topic.mode === 'demo' ? ' · 演示' : '')));
    row.append(body, badge(topic));
    list.append(row);
  }
  app.replaceChildren(intro, list);
}

function field(label, control, hint) {
  const wrapper = element('label', 'field');
  wrapper.append(element('span', 'field-title', label), control);
  if (hint) wrapper.append(element('small', 'muted', hint));
  return wrapper;
}

function composePage(config) {
  document.title = '发起讨论 · AI 讨论场';
  const intro = element('header', 'masthead');
  intro.append(element('h1', '', '发起讨论'));
  const form = element('form', 'compose');
  const title = element('input');
  Object.assign(title, { required: true, maxLength: 160, placeholder: '例如：远程团队要不要取消每日站会？' });
  const context = element('textarea');
  Object.assign(context, { maxLength: 4000, rows: 4, placeholder: '提供有助于判断的事实或限制。' });
  form.append(field('题目', title), field('背景（选填）', context));
  const count = element('select');
  for (let number = config.minParticipants; number <= config.maxParticipants; number++) {
    const option = element('option', '', number + ' 位');
    option.value = String(number);
    count.append(option);
  }
  form.append(field('AI 参与人数', count));
  const names = element('fieldset', 'participant-names');
  names.append(element('legend', 'field-title', '参与者名字（选填）'));
  const nameInputs = Array.from({ length: config.maxParticipants }, (_, index) => {
    const input = element('input');
    const defaultName = 'AI ' + (index + 1);
    Object.assign(input, { maxLength: config.maxNameLength, placeholder: defaultName });
    const label = field(defaultName, input);
    names.append(label);
    return { input, label };
  });
  function updateNames() {
    nameInputs.forEach(({ label }, index) => { label.hidden = index >= Number(count.value); });
  }
  count.addEventListener('change', updateNames);
  updateNames();
  form.append(names);
  const key = element('input');
  Object.assign(key, { type: 'password', required: true, autocomplete: 'off' });
  if (config.requiresKey) form.append(field('主持人密钥', key));
  const note = modeNote(config.mode);
  const rules = element('p', 'muted', '每轮每位参与者可以发言或跳过。整轮没人发言就结束，最多 ' + config.maxRounds + ' 轮。');
  const error = element('p', 'error');
  error.setAttribute('role', 'alert');
  const button = element('button', 'button', '开始讨论');
  button.type = 'submit';
  form.append(note, rules, error, button);
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    error.textContent = '';
    button.disabled = true;
    button.textContent = '正在启动…';
    try {
      const headers = { 'content-type': 'application/json' };
      if (config.requiresKey) headers.authorization = 'Bearer ' + key.value;
      const participantCount = Number(count.value);
      const participantNames = nameInputs.slice(0, participantCount).map(({ input }) => input.value);
      const { id } = await request('/api/topics', {
        method: 'POST', headers,
        body: JSON.stringify({ title: title.value, context: context.value, participantCount, participantNames })
      });
      location.assign('/topics/' + id);
    } catch (failure) {
      error.textContent = failure.message;
      button.disabled = false;
      button.textContent = '开始讨论';
    }
  });
  app.replaceChildren(intro, form);
}

function postCard(post, postsById, roles) {
  const role = roles.get(post.roleId);
  const article = element('article', 'post');
  article.id = 'post-' + post.id;
  const header = element('header', 'post-head');
  header.append(element('span', 'avatar ' + role.id, role.initials),
    element('strong', '', role.name),
    element('span', 'meta', '第 ' + post.round + ' 轮'),
    link('#' + article.id, '链接', 'permalink'));
  article.append(header);
  if (post.replyTo) {
    const parent = postsById.get(post.replyTo);
    article.append(link('#post-' + parent.id, '回复 ' + roles.get(parent.roleId).name, 'reply'));
  }
  article.append(element('p', 'post-text', post.text));
  return article;
}

function topicPage(topic) {
  document.title = topic.title + ' · AI 讨论场';

  const opening = element('header', 'masthead original-post');
  opening.append(element('p', 'meta', '原帖 · ' + displayDate(topic.createdAt)),
    element('h1', '', topic.title));
  if (topic.context) opening.append(element('p', 'intro context', topic.context));

  const thread = element('section', 'thread');
  const replyHeading = element('h2');
  const entries = element('div', 'replies');
  const empty = element('p', 'muted empty-replies', '还没有回复');
  thread.setAttribute('aria-label', '讨论回复');
  thread.append(replyHeading, empty, entries);

  const sidebar = element('aside', 'discussion-sidebar');
  const progress = element('section', 'discussion-progress');
  const state = badge(topic);
  const activity = element('p', 'activity');
  activity.setAttribute('role', 'status');
  progress.append(element('h2', '', '讨论进度'), state, activity);
  sidebar.append(progress);

  const members = element('details', 'participants');
  members.open = !matchMedia('(max-width: 900px)').matches;
  members.append(element('summary', '', '参与者 · ' + topic.roles.length));
  for (const role of topic.roles) {
    const name = element('div', 'sidebar-role');
    name.append(element('span', 'avatar ' + role.id, role.initials), element('strong', '', role.name));
    members.append(name);
  }
  sidebar.append(members);
  if (topic.mode === 'demo') sidebar.append(modeNote(topic.mode));

  const layout = element('div', 'discussion');
  layout.append(thread, sidebar);
  app.replaceChildren(opening, layout);

  const roles = new Map(topic.roles.map((role) => [role.id, role]));
  let renderedPosts = 0;
  return (updated) => {
    replyHeading.textContent = replyCount(updated);
    empty.hidden = updated.posts.length > 0;
    const postsById = new Map(updated.posts.map((post) => [post.id, post]));
    for (const post of updated.posts.slice(renderedPosts)) {
      entries.append(postCard(post, postsById, roles));
    }
    renderedPosts = updated.posts.length;
    state.className = 'badge ' + updated.status;
    state.textContent = status(updated);
    const messages = {
      quiet: '第 ' + updated.rounds + ' 轮无人发言。',
      limit: '已达到 ' + updated.maxRounds + ' 轮。',
      model_error: '模型请求或输出有误，已发布的回复仍可查看。'
    };
    activity.textContent = updated.status === 'running'
      ? '正在进行第 ' + (updated.rounds + 1) + ' 轮'
      : messages[updated.reason];
    const activeMeta = navTopics.querySelector('[aria-current="page"] .nav-meta');
    if (activeMeta) activeMeta.textContent = navSummary(updated);
  };
}

async function watchTopic(path) {
  let update;
  let version;
  async function refresh() {
    try {
      const topic = await request('/api' + path);
      const next = topic.rounds + ':' + topic.status;
      if (next !== version) {
        update ??= topicPage(topic);
        update(topic);
        if (version === undefined && location.hash) document.getElementById(location.hash.slice(1))?.scrollIntoView();
        version = next;
      }
      if (topic.status === 'running') setTimeout(() => void refresh(), 1000);
    } catch (error) {
      if (version === undefined) showError(error);
      else setTimeout(() => void refresh(), 3000);
    }
  }
  await refresh();
}

function showError(error) {
  app.replaceChildren(element('h1', '', error.message), link('/', '返回话题广场', 'back'));
}

const path = location.pathname;
const topics = request('/api/topics');
void topics.then((entries) => renderNav(entries, path), () => {
  navTopics.append(element('p', 'nav-meta', '暂时无法载入话题'));
});

try {
  if (path === '/new') composePage(await request('/api/config'));
  else if (path.startsWith('/topics/')) await watchTopic(path);
  else listPage(await topics);
} catch (error) {
  showError(error);
}
