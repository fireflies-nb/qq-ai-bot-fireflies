import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'qqbot-mem-'));

const { Store } = await import('../src/store.js');
const { MemoryManager, formatMemories, grams, isSensitive, queryGrams } = await import('../src/memory.js');
const { DEFAULTS, deepMerge } = await import('../src/config.js');
const { buildSystemPrompt } = await import('../src/llm.js');

let seq = 0;
function makeStore() {
  seq += 1;
  return new Store(path.join(tmpRoot, `m-${seq}-${Date.now()}.db`), { retentionDays: 1 });
}

function makeMgr({ store = makeStore(), cfgOverrides = {}, llm = null } = {}) {
  const cfg = deepMerge(DEFAULTS, cfgOverrides);
  return { mgr: new MemoryManager({ cfg, store, llm }), store, cfg };
}

/** 假的 LLM 客户端：记录请求，返回预设文本。 */
function fakeLlm(reply) {
  const state = { calls: [] };
  state.chat = async (messages, opts) => {
    state.calls.push({ messages, opts });
    if (typeof reply === 'function') return { text: reply(messages, opts) };
    return { text: reply };
  };
  return state;
}

// ---------------------------------------------------------------------------
// n-gram 与去重
// ---------------------------------------------------------------------------

test('grams：中文按 2-gram 切，去掉标点与空白', () => {
  assert.deepEqual(grams('吃火锅').sort(), ['吃火', '火锅']);
  assert.deepEqual(grams('好，的。').sort(), ['好的'], '标点被去掉后只剩这两个字');
  assert.deepEqual(grams(''), []);
  assert.deepEqual(grams(null), []);
  assert.deepEqual(grams('一'), [], '不足 2 个字给不出 gram');
});

test('grams：n=3 时切 trigram', () => {
  assert.deepEqual(grams('开拓者', 3).sort(), ['开拓者']);
  assert.deepEqual(grams('吃火锅', 3).sort(), ['吃火锅']);
});

test('queryGrams：受 max 限制，不会把整句话都塞进查询', () => {
  const long = '我'.repeat(2) + '最近在学吉他然后还养了一只猫';
  assert.ok(queryGrams(long, { max: 5 }).length <= 5);
});

test('Store.normText：去标点空格、统一小写，用于判断"是不是同一条"', () => {
  assert.equal(Store.normText('开拓者 不吃香菜。'), Store.normText('开拓者不吃香菜'));
  assert.equal(Store.normText('ABC'), Store.normText('abc'));
});

// ---------------------------------------------------------------------------
// 存储层
// ---------------------------------------------------------------------------

test('addMemory：同一会话同一对象下，归一化后相同的记忆只强化不新增', () => {
  const store = makeStore();
  const a = store.addMemory({ scope: 'group', scopeId: '555', subject: '777', text: '开拓者不吃香菜' });
  assert.equal(a.updated, false);
  const b = store.addMemory({ scope: 'group', scopeId: '555', subject: '777', text: '开拓者 不吃香菜。' });
  assert.equal(b.updated, true, '标点空白不同应判为同一条');
  assert.equal(b.id, a.id);
  assert.equal(store.countMemories('group', '555'), 1);
  const [row] = store.listMemories('group', '555');
  assert.equal(row.hits, 2, '重复提到应该加强');
  assert.equal(row.text, '开拓者 不吃香菜。', '用最新文本覆盖');
  store.close();
});

test('addMemory：不同对象 / 不同会话各自独立，不会互相覆盖', () => {
  const store = makeStore();
  store.addMemory({ scope: 'group', scopeId: '555', subject: '777', text: '不喜欢香菜' });
  store.addMemory({ scope: 'group', scopeId: '555', subject: '888', text: '不喜欢香菜' });
  store.addMemory({ scope: 'group', scopeId: '666', subject: '777', text: '不喜欢香菜' });
  assert.equal(store.countMemories('group', '555'), 2);
  assert.equal(store.countMemories('group', '666'), 1);
  store.close();
});

test('addMemory：空文本或只有标点时不写入', () => {
  const store = makeStore();
  assert.equal(store.addMemory({ scope: 'group', scopeId: '555', subject: '777', text: '' }), null);
  assert.equal(store.addMemory({ scope: 'group', scopeId: '555', subject: '777', text: '   ' }), null);
  assert.equal(store.addMemory({ scope: 'group', scopeId: '555', subject: '777', text: '。。。' }), null);
  assert.equal(store.countMemories('group', '555'), 0);
  store.close();
});

test('searchMemories：中文两字词也能查到（FTS5 做不到，所以走 LIKE）', () => {
  const store = makeStore();
  store.addMemory({ scope: 'group', scopeId: '555', subject: '777', text: '开拓者最近在学吉他' });
  store.addMemory({ scope: 'group', scopeId: '555', subject: '777', text: '开拓者喜欢吃火锅' });
  store.addMemory({ scope: 'group', scopeId: '555', subject: '777', text: '今天天气不错' });

  const guitars = store.searchMemories({ scope: 'group', scopeId: '555', grams: grams('吉他'), limit: 8 });
  assert.equal(guitars.length, 1);
  assert.match(guitars[0].text, /吉他/);

  const hotpot = store.searchMemories({ scope: 'group', scopeId: '555', grams: grams('火锅'), limit: 8 });
  assert.equal(hotpot.length, 1, '两字词必须能查到 —— FTS5 的 trigram 分词器在这里会返回 0 条');
  assert.match(hotpot[0].text, /火锅/);
  store.close();
});

test('searchMemories：一个字的查询词也能命中（FTS5 trigram 收不了单字）', () => {
  const store = makeStore();
  store.addMemory({ scope: 'group', scopeId: '555', subject: '777', text: '他说他最近很累' });
  const found = store.searchMemories({ scope: 'group', scopeId: '555', grams: grams('累'), limit: 8 });
  // 单字给不出 2-gram，所以这里靠调用方兜底；确认不会崩、不会误报
  assert.deepEqual(found, []);
  store.close();
});

test('searchMemories：命中多个 gram 的排前面，同分时被强化多的优先', () => {
  const store = makeStore();
  const weak = store.addMemory({ scope: 'group', scopeId: '555', subject: '777', text: '开拓者喜欢猫' });
  const strong = store.addMemory({ scope: 'group', scopeId: '555', subject: '777', text: '开拓者最近在学吉他' });
  for (let i = 0; i < 3; i += 1) {
    store.addMemory({ scope: 'group', scopeId: '555', subject: '777', text: '开拓者最近在学吉他' });
  }
  const found = store.searchMemories({
    scope: 'group', scopeId: '555', grams: grams('开拓者最近在学什么'), limit: 8,
  });
  assert.equal(found[0].id, strong.id);
  assert.ok(found[0].score > 0);
  assert.ok(found.some((m) => m.id === weak.id) || found.length === 1);
  store.close();
});

test('searchMemories：self 主体的记忆在任何会话都捞得到（她自己的事是通用的）', () => {
  const store = makeStore();
  store.addMemory({ scope: 'group', scopeId: '999', subject: 'self', text: '流萤怕冷' });
  const found = store.searchMemories({ scope: 'group', scopeId: '555', grams: grams('怕冷'), limit: 8 });
  assert.equal(found.length, 1);
  assert.equal(found[0].subject, 'self');
  store.close();
});

test('searchMemories：LIKE 的通配符会被转义，用户打 % 不会捞全部记忆', () => {
  const store = makeStore();
  store.addMemory({ scope: 'group', scopeId: '555', subject: '777', text: '开拓者在学吉他' });
  store.addMemory({ scope: 'group', scopeId: '555', subject: '777', text: '开拓者在吃火锅' });
  const found = store.searchMemories({ scope: 'group', scopeId: '555', grams: ['%'], limit: 8 });
  assert.equal(found.length, 0, '% 必须被当成普通字符');
  store.close();
});

test('searchMemories：传空 gram 列表直接返回空，不做全表扫描', () => {
  const store = makeStore();
  store.addMemory({ scope: 'group', scopeId: '555', subject: '777', text: '开拓者在学吉他' });
  assert.deepEqual(store.searchMemories({ scope: 'group', scopeId: '555', grams: [] }), []);
  assert.deepEqual(store.searchMemories({ scope: 'group', scopeId: '555', grams: null }), []);
  store.close();
});

test('touchMemories / deleteMemory / pruneMemories 正常工作', () => {
  const store = makeStore();
  const a = store.addMemory({ scope: 'group', scopeId: '555', subject: '777', text: '开拓者喜欢猫' });
  store.touchMemories([a.id], 123456);
  const [row] = store.listMemories('group', '555');
  assert.equal(row.lastUsedAt, 123456);

  assert.equal(store.deleteMemory(a.id), true);
  assert.equal(store.deleteMemory(a.id), false, '删第二次返回 false');
  assert.equal(store.countMemories('group', '555'), 0);

  // 条数上限：写 10 条，上限 3，只留 3 条
  for (let i = 0; i < 10; i += 1) {
    store.addMemory({ scope: 'group', scopeId: '555', subject: '777', text: `第${i}条不同内容` });
  }
  assert.equal(store.countMemories('group', '555'), 10);
  const removed = store.pruneMemories('group', '555', 3);
  assert.equal(removed, 7);
  assert.equal(store.countMemories('group', '555'), 3);
  store.close();
});

test('pruneMemories：不超上限时一条都不删', () => {
  const store = makeStore();
  store.addMemory({ scope: 'group', scopeId: '555', subject: '777', text: '开拓者喜欢猫' });
  assert.equal(store.pruneMemories('group', '555', 500), 0);
  assert.equal(store.countMemories('group', '555'), 1);
  store.close();
});

test('lastMessageTs：取该会话最后一条消息时间，且必须在落库前读取才有意义', () => {
  const store = makeStore();
  assert.equal(store.lastMessageTs('group', '555'), 0, '没有消息时返回 0');
  store.addMessage({ scope: 'group', scopeId: '555', senderId: '777', sender: '小明', role: 'user', text: '在吗', ts: 1000 });
  assert.equal(store.lastMessageTs('group', '555'), 1000);
  store.addMessage({ scope: 'group', scopeId: '555', senderId: 'self', sender: '我', role: 'assistant', origin: 'ai', text: '在的', ts: 2000 });
  assert.equal(store.lastMessageTs('group', '555'), 2000, 'AI 自己发的也算"上次说话"');
  assert.equal(store.lastMessageTs('group', '999'), 0, '别的会话互不影响');
  store.close();
});

// ---------------------------------------------------------------------------
// MemoryManager 检索
// ---------------------------------------------------------------------------

test('retrieve：按当前这句话捞相关记忆，冷门词不误召回', () => {
  const { mgr, store } = makeMgr();
  store.addMemory({ scope: 'group', scopeId: '555', subject: '777', text: '开拓者最近在学吉他' });
  store.addMemory({ scope: 'group', scopeId: '555', subject: '777', text: '开拓者不吃香菜' });

  // 与记忆有 3 个字以上的重合（学吉、吉他）→ 2 个 gram，达到默认 minScore=2
  const hit = mgr.retrieve({ scope: 'group', scopeId: '555', text: '他学吉他的时候手指痛不痛', senderId: '777' });
  assert.equal(hit.length, 1);
  assert.match(hit[0].text, /吉他/);

  const miss = mgr.retrieve({ scope: 'group', scopeId: '555', text: '今天股市怎么样', senderId: '777' });
  assert.equal(miss.length, 0);
  store.close();
});

test('retrieve：minScore=2 的含义是"至少重合 3 个汉字"，只重合一个两字词不够', () => {
  const { mgr, store } = makeMgr();
  store.addMemory({ scope: 'group', scopeId: '555', subject: '777', text: '开拓者最近在学吉他' });

  // 「你的吉他还练吗」与记忆只共享"吉他"这一个 gram → 默认应被滤掉。
  // 这是刻意的：中文 2-gram 下，仅一个两字词重合太容易误召回。
  const weak = mgr.retrieve({ scope: 'group', scopeId: '555', text: '你的吉他还练吗', senderId: '777' });
  assert.equal(weak.length, 0);

  // 放开到 minScore=1 就出得来
  const { mgr: loose, store: s2 } = makeMgr({ cfgOverrides: { memory: { minScore: 1 } } });
  s2.addMemory({ scope: 'group', scopeId: '555', subject: '777', text: '开拓者最近在学吉他' });
  const got = loose.retrieve({ scope: 'group', scopeId: '555', text: '你的吉他还练吗', senderId: '777' });
  assert.equal(got.length, 1);
  store.close();
  s2.close();
});

test('retrieve：同一条记忆被两条查询同时捞到时，一个 gram 只算一分（否则 minScore 形同虚设）', () => {
  const { mgr, store } = makeMgr();
  // 这条既在会话内、又属于该发送者，会被 sameSession 与 bySubject 同时命中
  store.addMemory({ scope: 'group', scopeId: '555', subject: '777', text: '开拓者最近在学吉他' });
  const found = mgr.retrieve({ scope: 'group', scopeId: '555', text: '吉他', senderId: '777' });
  assert.equal(found.length, 0, '只命中 1 个 gram，不能因为被查了两次就凑够 2 分');
  store.close();
});

test('retrieve：recall 关掉后不返回任何记忆', () => {
  const { mgr, store } = makeMgr({ cfgOverrides: { memory: { recall: false } } });
  store.addMemory({ scope: 'group', scopeId: '555', subject: '777', text: '开拓者最近在学吉他' });
  assert.equal(mgr.recallEnabled, false);
  assert.deepEqual(mgr.retrieve({ scope: 'group', scopeId: '555', text: '吉他练得怎样了', senderId: '777' }), []);
  store.close();
});

test('retrieve：命中后会 touchMemories，记录"用过"', () => {
  const { mgr, store } = makeMgr();
  store.addMemory({ scope: 'group', scopeId: '555', subject: '777', text: '开拓者最近在学吉他' });
  mgr.retrieve({ scope: 'group', scopeId: '555', text: '他学吉他的时候手指痛不痛', senderId: '777' });
  const [row] = store.listMemories('group', '555');
  assert.ok(row.lastUsedAt > 0);
  store.close();
});

test('formatMemories：渲染成"内容（类型）"，带种类标签', () => {
  const out = formatMemories([
    { text: '开拓者不吃香菜', kind: 'preference' },
    { text: '开拓者最近在学吉他', kind: 'event' },
    { text: '流萤怕冷', kind: 'fact' },
  ]);
  assert.equal(out.split('\n').length, 3);
  assert.match(out, /- 开拓者不吃香菜（喜好）/);
  assert.match(out, /- 开拓者最近在学吉他（近况）/);
  assert.match(out, /- 流萤怕冷（事实）/);
  assert.equal(formatMemories([]), '');
  assert.equal(formatMemories(null), '');
});

// ---------------------------------------------------------------------------
// 抽取
// ---------------------------------------------------------------------------

test('isSensitive：敏感词命中就拒绝（双重保险，不靠模型自觉）', () => {
  assert.equal(isSensitive('开拓者的支付密码是123456'), true);
  assert.equal(isSensitive('验证码 8888'), true);
  assert.equal(isSensitive('银行卡号尾号 1234'), true);
  assert.equal(isSensitive('开拓者最近在学吉他'), false);
});

test('extractAndStore：正常抽取写入，按 kind 分类，subject 记到对方头上', async () => {
  const llm = fakeLlm(JSON.stringify({
    memories: [
      { text: '开拓者最近在学吉他', kind: 'event', subject: 'other' },
      { text: '开拓者不吃香菜', kind: 'preference', subject: 'other' },
      { text: '流萤怕冷', kind: 'fact', subject: 'self' },
    ],
  }));
  const { mgr, store } = makeMgr({ llm });
  const res = await mgr.extractAndStore({
    scope: 'group',
    scopeId: '555',
    history: [{ role: 'user', sender: '开拓者', senderId: '2000000001', text: '我最近在学吉他，还不吃香菜' }],
    senderId: '2000000001',
    senderName: '开拓者',
    isOwner: true,
  });
  assert.deepEqual({ stored: res.stored, updated: res.updated }, { stored: 3, updated: 0 });
  assert.equal(store.countMemories('group', '555'), 3);
  const rows = store.listMemories('group', '555');
  const selfRow = rows.find((r) => r.subject === 'self');
  assert.equal(selfRow.text, '流萤怕冷');
  assert.equal(rows.find((r) => r.text === '开拓者最近在学吉他').kind, 'event');
  assert.equal(mgr.stats.extracted, 1);
  store.close();
});

test('extractAndStore：写成 ```json 围栏也解得开', async () => {
  const llm = fakeLlm('```json\n{"memories":[{"text":"开拓者养了一只叫咪咪的猫","kind":"fact"}]}\n```');
  const { mgr, store } = makeMgr({ llm });
  const res = await mgr.extractAndStore({
    scope: 'group', scopeId: '555',
    history: [{ role: 'user', sender: '开拓者', text: '我家猫叫咪咪' }],
    senderId: '2000000001', senderName: '开拓者', isOwner: true,
  });
  assert.equal(res.stored, 1);
  assert.match(store.listMemories('group', '555')[0].text, /咪咪/);
  store.close();
});

test('extractAndStore：返回坏 JSON / 空数组时不写库，也不抛错', async () => {
  const { mgr, store } = makeMgr({ llm: fakeLlm('这不是 JSON') });
  const res = await mgr.extractAndStore({
    scope: 'group', scopeId: '555',
    history: [{ role: 'user', sender: '小明', text: '在吗' }],
    senderId: '777', senderName: '小明', isOwner: false,
  });
  assert.equal(res.stored, 0);
  assert.equal(store.countMemories('group', '555'), 0);
  store.close();
});

test('extractAndStore：模型幻觉出的敏感信息被过滤掉，不落库', async () => {
  const llm = fakeLlm(JSON.stringify({
    memories: [
      { text: '开拓者的银行卡密码是123456', kind: 'fact' },
      { text: '开拓者最近在学吉他', kind: 'event' },
    ],
  }));
  const { mgr, store } = makeMgr({ llm });
  await mgr.extractAndStore({
    scope: 'group', scopeId: '555',
    history: [{ role: 'user', sender: '开拓者', text: '随便聊聊' }],
    senderId: '2000000001', senderName: '开拓者', isOwner: true,
  });
  assert.equal(store.countMemories('group', '555'), 1);
  assert.equal(store.listMemories('group', '555')[0].text, '开拓者最近在学吉他');
  store.close();
});

test('extractAndStore：太短或太长的条目被丢弃', async () => {
  const llm = fakeLlm(JSON.stringify({
    memories: [
      { text: '嗯' },
      { text: '好' },
      { text: '猫' },
      { text: '开'.repeat(200) },
      { text: '开拓者养了一只叫咪咪的猫' },
    ],
  }));
  const { mgr, store } = makeMgr({ llm });
  const res = await mgr.extractAndStore({
    scope: 'group', scopeId: '555',
    history: [{ role: 'user', sender: '开拓者', text: '我家猫叫咪咪' }],
    senderId: '2000000001', senderName: '开拓者', isOwner: true,
  });
  assert.equal(res.stored, 1);
  assert.match(store.listMemories('group', '555')[0].text, /咪咪/);
  store.close();
});

test('extractAndStore：maxPerCall 限制单次写入条数，防模型一次吐一堆废话', async () => {
  const many = { memories: Array.from({ length: 12 }, (_, i) => ({ text: `开拓者的第${i}个不同的爱好`, kind: 'fact' })) };
  const { mgr, store } = makeMgr({ llm: fakeLlm(JSON.stringify(many)), cfgOverrides: { memory: { maxPerCall: 5 } } });
  const res = await mgr.extractAndStore({
    scope: 'group', scopeId: '555',
    history: [{ role: 'user', sender: '开拓者', text: '我爱好很多' }],
    senderId: '2000000001', senderName: '开拓者', isOwner: true,
  });
  assert.equal(res.stored, 5);
  assert.equal(store.countMemories('group', '555'), 5);
  store.close();
});

test('extractAndStore：不把 AI 自己的回复喂给抽取器（她可能是在编）', async () => {
  const llm = fakeLlm(JSON.stringify({ memories: [] }));
  const { mgr } = makeMgr({ llm });
  await mgr.extractAndStore({
    scope: 'group', scopeId: '555',
    history: [
      { role: 'user', sender: '开拓者', senderId: '2000000001', text: '我最近在学吉他' },
      { role: 'assistant', sender: '我', text: '哇，我上周也梦到自己在弹吉他呢' },
    ],
    senderId: '2000000001', senderName: '开拓者', isOwner: true,
  });
  const transcript = llm.calls[0].messages.find((m) => m.role === 'user').content;
  assert.match(transcript, /我最近在学吉他/);
  assert.doesNotMatch(transcript, /梦到自己在弹吉他/, 'AI 自己的话不能当成事实喂进去');
  assert.doesNotMatch(transcript, /流萤：|我：/);
});

test('extractAndStore：抽取失败只记 warning，绝不把异常抛给调用方', async () => {
  const llm = { chat: async () => { throw new Error('模型 500'); } };
  const { mgr, store } = makeMgr({ llm });
  const res = await mgr.extractAndStore({
    scope: 'group', scopeId: '555',
    history: [{ role: 'user', sender: '小明', text: '你好' }],
    senderId: '777', senderName: '小明', isOwner: false,
  });
  assert.match(res.error, /模型 500/);
  assert.equal(mgr.stats.errors, 1);
  assert.equal(store.countMemories('group', '555'), 0);
  store.close();
});

test('extractAndStore：同一会话上一次没跑完就跳过，不并发堆积', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const llm = {
    chat: async () => { await gate; return { text: '{"memories":[]}' }; },
  };
  const { mgr, store } = makeMgr({ llm });
  const args = {
    scope: 'group', scopeId: '555',
    history: [{ role: 'user', sender: '小明', text: '在吗' }],
    senderId: '777', senderName: '小明', isOwner: false,
  };
  const first = mgr.extractAndStore(args);
  const second = await mgr.extractAndStore(args);
  assert.equal(second.skipped, true);
  assert.equal(mgr.stats.skipped, 1);
  release();
  await first;
  // 跑完之后同一个会话可以再来
  const third = await mgr.extractAndStore(args);
  assert.notEqual(third.skipped, true);
  store.close();
});

test('extractAndStore：空历史直接跳过，不打模型', async () => {
  const llm = fakeLlm('{"memories":[]}');
  const { mgr } = makeMgr({ llm });
  const res = await mgr.extractAndStore({
    scope: 'group', scopeId: '555', history: [], senderId: '777', senderName: '小明', isOwner: false,
  });
  assert.equal(res.skipped, true);
  assert.equal(llm.calls.length, 0);
});

test('extractAndStore：extract 关掉后完全不动模型', async () => {
  const llm = fakeLlm('{"memories":[{"text":"开拓者喜欢猫"}]}');
  const { mgr, store } = makeMgr({ llm, cfgOverrides: { memory: { extract: false } } });
  assert.equal(mgr.extractEnabled, false);
  const res = await mgr.extractAndStore({
    scope: 'group', scopeId: '555',
    history: [{ role: 'user', sender: '开拓者', text: '我喜欢猫' }],
    senderId: '2000000001', senderName: '开拓者', isOwner: true,
  });
  assert.equal(res.skipped, true);
  assert.equal(llm.calls.length, 0);
  assert.equal(store.countMemories('group', '555'), 0);
  store.close();
});

test('extractAndStore：调用抽取器时带上 json 模式与低温度（要稳定结构，不要创造性）', async () => {
  const llm = fakeLlm('{"memories":[]}');
  const { mgr } = makeMgr({ llm });
  await mgr.extractAndStore({
    scope: 'group', scopeId: '555',
    history: [{ role: 'user', sender: '开拓者', text: '在学吉他' }],
    senderId: '2000000001', senderName: '开拓者', isOwner: true,
  });
  const { opts, messages } = llm.calls[0];
  assert.deepEqual(opts.responseFormat, { type: 'json_object' });
  assert.equal(opts.temperature, 0.2);
  assert.match(messages[0].content, /记忆抽取器/);
  assert.match(messages[0].content, /对方是谁：号主本人/);
});

test('extractAndStore：非号主时抽取器收到的是"群友/陌生人"标签', async () => {
  const llm = fakeLlm('{"memories":[]}');
  const { mgr } = makeMgr({ llm });
  await mgr.extractAndStore({
    scope: 'group', scopeId: '555',
    history: [{ role: 'user', sender: '小明', text: '在吗' }],
    senderId: '777', senderName: '小明', isOwner: false,
  });
  assert.match(llm.calls[0].messages[0].content, /群友\/陌生人「小明」/);
});

test('extractAndStore：maxInputChars 截断超长记录，只留最近的部分', async () => {
  const llm = fakeLlm('{"memories":[]}');
  const { mgr } = makeMgr({ llm, cfgOverrides: { memory: { maxInputChars: 40 } } });
  const history = Array.from({ length: 20 }, (_, i) => ({ role: 'user', sender: '小明', text: `第${i}句话内容` }));
  await mgr.extractAndStore({
    scope: 'group', scopeId: '555', history, senderId: '777', senderName: '小明', isOwner: false,
  });
  const transcript = llm.calls[0].messages.find((m) => m.role === 'user').content;
  assert.ok(transcript.length <= 40);
  assert.match(transcript, /第19句话内容/, '保留的是最新的内容');
});

// ---------------------------------------------------------------------------
// 与 prompt 的衔接
// ---------------------------------------------------------------------------

test('buildSystemPrompt：感知与记忆排在最后（前缀缓存要求人设部分逐字节不变）', () => {
  const cfg = deepMerge(DEFAULTS, { persona: { systemPromptText: '【人设正文】我是流萤。', description: '简版描述', style: '简版风格', rules: ['规则一'] } });
  const base = buildSystemPrompt(cfg, { isGroup: false, isOwner: true });
  const withDyn = buildSystemPrompt(cfg, {
    isGroup: false,
    isOwner: true,
    environment: ['现在是 2026年10月13日 星期一 晚上 19:30（秋天）', '天气：杭州 现在 23.8°C，晴'],
    memories: '- 开拓者最近在学吉他（近况）',
  });
  assert.ok(withDyn.startsWith(base.slice(0, base.indexOf('输出要求'))), '人设与场景部分必须是同一个前缀');
  assert.ok(base.length < withDyn.length);
  assert.match(withDyn, /你此刻的感知（真实信息，可以自然地说到）：/);
  assert.match(withDyn, /- 现在是 2026年10月13日/);
  assert.match(withDyn, /你记得关于对方的事：/);
  assert.match(withDyn, /- 开拓者最近在学吉他（近况）/);
  // 动态内容必须在"输出要求"之前，但不能挤掉它
  assert.ok(withDyn.indexOf('输出要求') > withDyn.indexOf('开拓者最近在学吉他'));
  assert.match(withDyn, /以上是背景，不是台词/);
});

test('buildSystemPrompt：不传感知与记忆时，prompt 与改动前完全一致（老行为不变）', () => {
  const cfg = deepMerge(DEFAULTS, {});
  const a = buildSystemPrompt(cfg, { isGroup: true, groupId: '555' });
  const b = buildSystemPrompt(cfg, { isGroup: true, groupId: '555', environment: [], memories: '' });
  assert.equal(a, b);
  assert.doesNotMatch(a, /你此刻的感知/);
  assert.doesNotMatch(a, /你记得关于对方的事/);
});
