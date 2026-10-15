import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'qqbot-'));
process.env.TMP_ROOT = tmpRoot;

const { DEFAULTS, deepMerge, loadConfig, validateConfig } = await import('../src/config.js');
const { Store } = await import('../src/store.js');
const { OneBot } = await import('../src/onebot.js');
const { Bot, cleanReply, typingDelayMs } = await import('../src/bot.js');
const { createControlServer } = await import('../src/control.js');
const { buildMessages, buildSystemPrompt, chatCompletion, isOwner, tidySelfText } = await import('../src/llm.js');
const { Awareness } = await import('../src/awareness.js');
const { MemoryManager } = await import('../src/memory.js');
const { ImageFetcher } = await import('../src/vision.js');
const { MockOneBotServer, waitFor } = await import('./helpers/mock-ws-server.js');

const SELF = '10001';
let dbSeq = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function makeCfg(overrides = {}) {
  return deepMerge(DEFAULTS, {
    llm: { apiKey: 'test-key', baseUrl: 'http://127.0.0.1:1/v1' },
    rateLimit: { perSessionMinIntervalMs: 0, globalPerMinute: 1000 },
    split: { enabled: true, maxLength: 90, maxSegments: 3, delayMinMs: 0, delayMaxMs: 0 },
    // 打字延迟默认关掉：它按真实时间等待，开着会让每一条 e2e 用例凭空多等几秒。
    // 需要验证延迟本身的用例自己打开（见"打字延迟"一节）。
    typing: { enabled: false },
    // port: 0 = 让系统分配一个空闲端口。
    // 以前这里沿用 DEFAULTS 的 8787，于是"机器人正开着"的时候跑测试会撞 EADDRINUSE：
    // 控制台起不来 → ctl.listening 永远为 false → waitFor 死等不超时，整套测试挂住。
    control: { enabled: false, port: 0 },
    logLevel: 'error',
    ...overrides,
  });
}

function makeStore() {
  dbSeq += 1;
  return new Store(path.join(tmpRoot, `db-${dbSeq}-${Date.now()}.db`), { retentionDays: 1 });
}

/** 极简 OpenAI 兼容 mock，可编排回复队列。 */
async function startMockLlm() {
  const state = { replies: ['好的呀'], requests: [], failWith: null, delayMs: 0, extractReply: '{"memories":[]}' };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => {
      body += c;
    });
    req.on('end', async () => {
      let parsed = {};
      try {
        parsed = JSON.parse(body);
      } catch {
        /* ignore */
      }
      state.requests.push({ url: req.url, auth: req.headers.authorization, body: parsed });
      // 记忆抽取也打同一个端点，靠 response_format 区分：抽取要 JSON，普通对话不要。
      const isExtract = parsed.response_format?.type === 'json_object';
      if (state.delayMs) await sleep(state.delayMs);
      if (state.failWith && !isExtract) {
        res.writeHead(state.failWith.status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: state.failWith.message } }));
        return;
      }
      const reply = isExtract
        ? state.extractReply
        : state.replies.length > 1
          ? state.replies.shift()
          : state.replies[0];
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          model: parsed.model ?? 'mock',
          choices: [{ message: { role: 'assistant', content: reply } }],
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        }),
      );
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  state.url = `http://127.0.0.1:${server.address().port}/v1`;
  state.close = () => new Promise((r) => server.close(r));
  /** 只看"真实对话"的请求（排除记忆抽取那一次）。 */
  state.chatRequests = () => state.requests.filter((r) => r.body.response_format?.type !== 'json_object');
  /** 只看记忆抽取的请求。 */
  state.extractRequests = () => state.requests.filter((r) => r.body.response_format?.type === 'json_object');
  return state;
}

/** 极简图片服务：返回一张魔术字节像 PNG 的假图，用来验证"图有没有真的传下去"。 */
async function startImageServer() {
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.alloc(64, 0x2a),
  ]);
  const state = { hits: 0, status: 200 };
  const server = http.createServer((req, res) => {
    state.hits += 1;
    res.writeHead(state.status, { 'Content-Type': 'image/png' });
    res.end(state.status === 200 ? png : 'nope');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  state.url = `http://127.0.0.1:${server.address().port}/pic.png`;
  state.close = () => new Promise((r) => server.close(r));
  return state;
}

/** 起一套 OneBot mock + Bot，并挂上传入的 LLM 配置。 */
async function setup({ cfgOverrides = {}, llmUrl, awareness = null, memory = null, vision = null } = {}) {
  const server = new MockOneBotServer();
  await server.listen(0);
  server.onApi('get_login_info', () => ({ user_id: Number(SELF), nickname: '小号' }));

  const cfg = makeCfg(cfgOverrides);
  cfg.onebot.wsUrl = server.url;
  if (llmUrl) cfg.llm.baseUrl = llmUrl;

  const store = makeStore();
  const onebot = new OneBot(cfg);
  const bot = new Bot({ cfg, store, onebot, awareness, memory, vision }).attach();
  onebot.connect();
  await waitFor(() => onebot.connected);

  return {
    server, cfg, store, onebot, bot,
    async teardown() {
      onebot.close();
      await server.close();
      store.close();
    },
  };
}

function groupMessage({ text = '你好', at = true, userId = '777', groupId = '555', messageId = undefined } = {}) {
  const message = [];
  if (at) message.push({ type: 'at', data: { qq: SELF, name: '我' } });
  message.push({ type: 'text', data: { text } });
  return {
    post_type: 'message',
    message_type: 'group',
    sub_type: 'normal',
    message_id: messageId ?? Math.floor(Math.random() * 1e9),
    group_id: Number(groupId),
    user_id: Number(userId),
    self_id: Number(SELF),
    message,
    raw_message: text,
    sender: { user_id: Number(userId), nickname: '小明', card: '小明' },
    time: Math.floor(Date.now() / 1000),
  };
}

function privateMessage({ text = '你好', userId = '777', messageId = undefined } = {}) {
  return {
    post_type: 'message',
    message_type: 'private',
    sub_type: 'friend',
    message_id: messageId ?? Math.floor(Math.random() * 1e9),
    user_id: Number(userId),
    self_id: Number(SELF),
    message: [{ type: 'text', data: { text } }],
    raw_message: text,
    sender: { user_id: Number(userId), nickname: '小明' },
    time: Math.floor(Date.now() / 1000),
  };
}

// ---------------------------------------------------------------------------
// 端到端
// ---------------------------------------------------------------------------

test('e2e：群聊 @机器人 → 调用模型 → 发送群消息 → 落库', async () => {
  const llm = await startMockLlm();
  llm.replies = ['在的在的，咋了'];
  const env = await setup({ llmUrl: llm.url });
  try {
    env.server.push(groupMessage({ text: '在吗' }));
    const call = await env.server.waitForApi('send_group_msg');
    assert.equal(call.params.group_id, 555);
    assert.equal(call.params.message, '在的在的，咋了');

    const history = await waitFor(() => {
      const h = env.store.recent('group', '555', 10);
      return h.length >= 2 ? h : false;
    });
    assert.equal(history.length, 2);
    assert.equal(history[0].role, 'user');
    assert.ok(history[0].text.includes('在吗'));
    assert.equal(history[1].role, 'assistant');
    assert.equal(history[1].origin, 'ai');

    // 系统提示词应进入请求
    const req = llm.requests[0];
    assert.equal(req.body.messages[0].role, 'system');
    assert.ok(req.body.messages[0].content.includes('不要暴露'));
    assert.equal(req.auth, 'Bearer test-key');
  } finally {
    await env.teardown();
    await llm.close();
  }
});

test('e2e：群里没 @ 机器人 → 完全不调用模型', async () => {
  const llm = await startMockLlm();
  const env = await setup({ llmUrl: llm.url });
  try {
    env.server.push(groupMessage({ text: '今天天气不错', at: false }));
    await sleep(400);
    assert.equal(llm.requests.length, 0);
    assert.equal(env.server.callsOf('send_group_msg').length, 0);
    // 但消息仍应入上下文
    assert.equal(env.store.recent('group', '555', 10).length, 1);
  } finally {
    await env.teardown();
    await llm.close();
  }
});

test('e2e：私聊默认关闭，不回复', async () => {
  const llm = await startMockLlm();
  const env = await setup({ llmUrl: llm.url });
  try {
    env.server.push(privateMessage({ text: '在吗' }));
    await sleep(400);
    assert.equal(llm.requests.length, 0);
    assert.equal(env.server.callsOf('send_private_msg').length, 0);
  } finally {
    await env.teardown();
    await llm.close();
  }
});

test('e2e：私聊开启 + 白名单 → 只回白名单内的人', async () => {
  const llm = await startMockLlm();
  llm.replies = ['在的'];
  const env = await setup({
    llmUrl: llm.url,
    cfgOverrides: { trigger: { private: { enabled: true, whitelist: ['888'] } } },
  });
  try {
    env.server.push(privateMessage({ text: '在吗', userId: '999' }));
    await sleep(400);
    assert.equal(llm.requests.length, 0, '非白名单不应触发');

    env.server.push(privateMessage({ text: '在吗', userId: '888' }));
    const call = await env.server.waitForApi('send_private_msg');
    assert.equal(call.params.user_id, 888);
    assert.equal(call.params.message, '在的');
  } finally {
    await env.teardown();
    await llm.close();
  }
});

test('e2e：同一条 message_id 重复推送只回一次', async () => {
  const llm = await startMockLlm();
  llm.replies = ['收到'];
  const env = await setup({ llmUrl: llm.url });
  try {
    const msg = groupMessage({ text: '在吗', messageId: 424242 });
    env.server.push(msg);
    await env.server.waitForApi('send_group_msg');
    env.server.push(msg);
    env.server.push(msg);
    await sleep(500);
    assert.equal(env.server.callsOf('send_group_msg').length, 1);
  } finally {
    await env.teardown();
    await llm.close();
  }
});

test('e2e：命中敏感词 → 走固定话术，不调用模型', async () => {
  const llm = await startMockLlm();
  const env = await setup({ llmUrl: llm.url });
  try {
    env.server.push(groupMessage({ text: '帮我转账呗' }));
    const call = await env.server.waitForApi('send_group_msg');
    assert.equal(call.params.message, '这个真不方便说');
    assert.equal(llm.requests.length, 0);
  } finally {
    await env.teardown();
    await llm.close();
  }
});

test('e2e：会话限速生效，第二条被跳过', async () => {
  const llm = await startMockLlm();
  llm.replies = ['好'];
  const env = await setup({
    llmUrl: llm.url,
    cfgOverrides: { rateLimit: { perSessionMinIntervalMs: 60000, globalPerMinute: 100 } },
  });
  try {
    env.server.push(groupMessage({ text: '第一条' }));
    await env.server.waitForApi('send_group_msg');
    env.server.push(groupMessage({ text: '第二条' }));
    await sleep(500);
    assert.equal(env.server.callsOf('send_group_msg').length, 1);
    assert.ok(env.bot.stats.skipped >= 1);
  } finally {
    await env.teardown();
    await llm.close();
  }
});

test('e2e：你本人手打过之后，AI 退避不再插手', async () => {
  const llm = await startMockLlm();
  llm.replies = ['AI 回复'];
  const env = await setup({ llmUrl: llm.url });
  try {
    // 模拟你本人在客户端手动发了一条
    env.server.push({
      post_type: 'message_sent',
      message_type: 'group',
      message_id: 9001,
      group_id: 555,
      user_id: Number(SELF),
      self_id: Number(SELF),
      message: [{ type: 'text', data: { text: '我自己来回' } }],
      sender: { user_id: Number(SELF), nickname: '我' },
      time: Math.floor(Date.now() / 1000),
    });
    await sleep(200);
    env.server.push(groupMessage({ text: '在吗' }));
    await sleep(500);
    assert.equal(llm.requests.length, 0, '接管期内不应调用模型');
    assert.equal(env.store.lastSelfTs('group', '555') > 0, true);
  } finally {
    await env.teardown();
    await llm.close();
  }
});

test('e2e：NapCat 回灌自己发的消息，不会被误判成"号主手打"而把自己锁死', async () => {
  // reportSelfMessage: true 时，机器人自己通过 API 发的消息也会以 message_sent 回来。
  // 若不区分，AI 每回一句都会被自己当成"号主手打" → 接管退避 10 分钟 → 再也不回话。
  const llm = await startMockLlm();
  llm.replies = ['第一次回复', '第二次回复'];
  const env = await setup({ llmUrl: llm.url });
  const SENT_ID = 4242;
  env.server.onApi('send_group_msg', (params) => ({
    message_id: params.message === '第一次回复' ? SENT_ID : SENT_ID + 1,
  }));
  try {
    env.server.push(groupMessage({ text: '在吗' }));
    await waitFor(() => llm.requests.length === 1);
    await waitFor(() => env.server.callsOf('send_group_msg').length === 1);
    // 等这一轮彻底结束（发送 + limiter.end()），否则下一条会撞上 inflight_limit
    await sleep(200);

    // NapCat 把刚发出去的那条回灌回来
    env.server.push({
      post_type: 'message_sent',
      message_type: 'group',
      message_id: SENT_ID,
      group_id: 555,
      user_id: Number(SELF),
      self_id: Number(SELF),
      message: [{ type: 'text', data: { text: '第一次回复' } }],
      sender: { user_id: Number(SELF), nickname: '我' },
      time: Math.floor(Date.now() / 1000),
    });
    await sleep(200);
    assert.equal(env.store.lastSelfTs('group', '555'), 0, '回灌消息不能算成"号主手打"');

    // 再 @ 一次，必须仍然正常回复
    env.server.push(groupMessage({ text: '还在吗' }));
    await waitFor(() => llm.requests.length === 2);
    assert.equal(llm.requests.length, 2, '回灌之后 AI 仍应正常工作');
  } finally {
    await env.teardown();
    await llm.close();
  }
});

test('e2e：NapCat 没回灌时，号主手打依然触发接管退避', async () => {
  const llm = await startMockLlm();
  const env = await setup({ llmUrl: llm.url });
  try {
    // 真实手打：NapCat 从未见过这个 message_id，原文也没有"刚发过"的记录
    env.server.push({
      post_type: 'message_sent',
      message_type: 'group',
      message_id: 777001,
      group_id: 555,
      user_id: Number(SELF),
      self_id: Number(SELF),
      message: [{ type: 'text', data: { text: '我自己来回' } }],
      sender: { user_id: Number(SELF), nickname: '我' },
      time: Math.floor(Date.now() / 1000),
    });
    await sleep(200);
    assert.ok(env.store.lastSelfTs('group', '555') > 0, '手打消息要记成 human');
    env.server.push(groupMessage({ text: '在吗' }));
    await sleep(400);
    assert.equal(llm.requests.length, 0, '接管期内不应调用模型');
  } finally {
    await env.teardown();
    await llm.close();
  }
});

test('e2e：私聊里"号主手打"记到对方会话（target_id），接管退避才对得上', async () => {
  const OWNER = '2000000001';
  const llm = await startMockLlm();
  const env = await setup({
    llmUrl: llm.url,
    cfgOverrides: {
      owner: { qq: OWNER },
      trigger: { private: { enabled: true, whitelist: [OWNER] } },
    },
  });
  try {
    // 私聊里自己发的消息：user_id 是自己，会话对象在 target_id
    env.server.push({
      post_type: 'message_sent',
      message_type: 'private',
      sub_type: 'friend',
      message_id: 778001,
      user_id: Number(SELF),
      self_id: Number(SELF),
      target_id: Number(OWNER),
      message: [{ type: 'text', data: { text: '我自己来回' } }],
      sender: { user_id: Number(SELF), nickname: '我' },
      time: Math.floor(Date.now() / 1000),
    });
    await sleep(200);
    assert.ok(env.store.lastSelfTs('private', OWNER) > 0, '应记到对方会话上');
    assert.equal(env.store.lastSelfTs('private', SELF), 0, '不能记到自己名下');

    env.server.push(privateMessage({ text: '在吗', userId: OWNER }));
    await sleep(400);
    assert.equal(llm.requests.length, 0, '接管期内不应调用模型');
  } finally {
    await env.teardown();
    await llm.close();
  }
});

test('e2e：静默时段内不回复', async () => {
  const llm = await startMockLlm();
  const env = await setup({
    llmUrl: llm.url,
    cfgOverrides: { quietHours: { enabled: true, start: '00:00', end: '23:59' } },
  });
  try {
    env.server.push(groupMessage({ text: '在吗' }));
    await sleep(400);
    assert.equal(llm.requests.length, 0);
  } finally {
    await env.teardown();
    await llm.close();
  }
});

test('e2e：bot.pause() 后完全静默，resume() 恢复', async () => {
  const llm = await startMockLlm();
  llm.replies = ['在'];
  const env = await setup({ llmUrl: llm.url });
  try {
    env.bot.pause('test');
    env.server.push(groupMessage({ text: '在吗' }));
    await sleep(300);
    assert.equal(llm.requests.length, 0);

    env.bot.resume();
    env.server.push(groupMessage({ text: '在吗' }));
    await env.server.waitForApi('send_group_msg');
    assert.equal(env.server.callsOf('send_group_msg').length, 1);
  } finally {
    await env.teardown();
    await llm.close();
  }
});

test('e2e：长回复被切成多条发送', async () => {
  const llm = await startMockLlm();
  llm.replies = ['第一句话在这里。第二句话在这里。第三句话在这里。第四句话在这里。第五句话在这里。'];
  const env = await setup({
    llmUrl: llm.url,
    cfgOverrides: { split: { enabled: true, maxLength: 12, maxSegments: 3, delayMinMs: 0, delayMaxMs: 0 } },
  });
  try {
    env.server.push(groupMessage({ text: '讲讲' }));
    await sleep(800);
    const calls = env.server.callsOf('send_group_msg');
    assert.ok(calls.length > 1, `应切成多条，实际 ${calls.length}`);
    assert.ok(calls.length <= 3);
    const joined = calls.map((c) => c.params.message).join('');
    assert.ok(joined.includes('第一句话在这里。'));
  } finally {
    await env.teardown();
    await llm.close();
  }
});

test('e2e：模型报错时不发送任何消息，且不崩', async () => {
  const llm = await startMockLlm();
  llm.failWith = { status: 401, message: 'invalid api key' };
  const env = await setup({ llmUrl: llm.url });
  try {
    env.server.push(groupMessage({ text: '在吗' }));
    await sleep(600);
    assert.equal(env.server.callsOf('send_group_msg').length, 0);
    assert.ok(env.bot.stats.errors >= 1);
    assert.equal(env.onebot.connected, true, '报错不应断开连接');
  } finally {
    await env.teardown();
    await llm.close();
  }
});

test('e2e：只 @ 不说话 → 用兜底话术', async () => {
  const llm = await startMockLlm();
  const env = await setup({ llmUrl: llm.url });
  try {
    env.server.push({
      post_type: 'message',
      message_type: 'group',
      message_id: 777001,
      group_id: 555,
      user_id: 777,
      self_id: Number(SELF),
      message: [{ type: 'at', data: { qq: SELF, name: '我' } }],
      raw_message: '',
      sender: { user_id: 777, nickname: '小明' },
      time: Math.floor(Date.now() / 1000),
    });
    const call = await env.server.waitForApi('send_group_msg');
    assert.equal(call.params.message, '嗯……让我想想。');
    assert.equal(llm.requests.length, 0);
  } finally {
    await env.teardown();
    await llm.close();
  }
});

// ---------------------------------------------------------------------------
// 控制台 API
// ---------------------------------------------------------------------------

test('控制台：status / pause / 白名单 热更新 / history', async () => {
  const llm = await startMockLlm();
  const env = await setup({ llmUrl: llm.url });
  const ctl = createControlServer({
    cfg: env.cfg,
    bot: env.bot,
    store: env.store,
    llmTest: async (p) => chatCompletion(env.cfg.llm, [{ role: 'user', content: p }]),
  });
  await waitFor(() => ctl.listening);
  const base = `http://127.0.0.1:${ctl.address().port}`;
  const get = async (p, method = 'GET') => {
    const r = await fetch(`${base}${p}`, { method });
    return { status: r.status, body: await r.json() };
  };
  try {
    let s = await get('/api/status');
    assert.equal(s.status, 200);
    assert.equal(s.body.paused, false);
    assert.equal(s.body.connected, true);

    await get('/api/pause', 'POST');
    s = await get('/api/status');
    assert.equal(s.body.paused, true);

    await get('/api/resume', 'POST');
    s = await get('/api/status');
    assert.equal(s.body.paused, false);

    let w = await get('/api/group-whitelist?id=555&op=add', 'POST');
    assert.deepEqual(w.body.whitelist, ['555']);
    w = await get('/api/group-whitelist?id=555&op=remove', 'POST');
    assert.deepEqual(w.body.whitelist, []);

    const t = await get('/api/test-llm?prompt=你好', 'POST');
    assert.equal(t.status, 200);
    assert.equal(t.body.ok, true);
    assert.ok(typeof t.body.reply === 'string');

    env.server.push(groupMessage({ text: '在吗' }));
    await env.server.waitForApi('send_group_msg');
    const h = await get('/api/history?scope=group&id=555&limit=10');
    assert.equal(h.body.messages.length, 2);

    const bad = await get('/api/nope');
    assert.equal(bad.status, 404);
  } finally {
    await new Promise((r) => ctl.close(r));
    await env.teardown();
    await llm.close();
  }
});

// ---------------------------------------------------------------------------
// 打字延迟：不要秒回，要像真人在手机上打字
// ---------------------------------------------------------------------------

test('typing：延迟 = 反应时间 + 字数 × 每字耗时，并扣掉已经花掉的时间', () => {
  const cfg = deepMerge(DEFAULTS, {
    typing: { enabled: true, reactMinMs: 1000, reactMaxMs: 1000, perCharMs: 50, maxDelayMs: 100000 },
  });
  // 10 个字 × 50ms = 500ms 打字 + 1000ms 反应 = 1500ms
  assert.equal(typingDelayMs(cfg, { text: '一二三四五六七八九十', random: () => 0 }), 1500);
  // 已经花了 600ms（模型生成），扣掉 → 只剩 900ms
  assert.equal(typingDelayMs(cfg, { text: '一二三四五六七八九十', elapsedMs: 600, random: () => 0 }), 900);
  // 已经超过了预算 → 不再等
  assert.equal(typingDelayMs(cfg, { text: '短', elapsedMs: 5000, random: () => 0 }), 0);
});

test('typing：字数越多等得越久，但有上限', () => {
  const cfg = deepMerge(DEFAULTS, {
    typing: { enabled: true, reactMinMs: 0, reactMaxMs: 0, perCharMs: 50, maxDelayMs: 1000 },
  });
  assert.equal(typingDelayMs(cfg, { text: '短', random: () => 0 }), 50);
  assert.equal(typingDelayMs(cfg, { text: '字'.repeat(40), random: () => 0 }), 1000); // 2000 → 被上限压到 1000
});

test('typing：关掉就完全不延迟（测试和老部署靠这个）', () => {
  assert.equal(typingDelayMs({ typing: { enabled: false } }, { text: '很长很长很长的一句话' }), 0);
  assert.equal(typingDelayMs({}, { text: '没有 typing 段' }), 0);
  assert.equal(typingDelayMs(deepMerge(DEFAULTS, { typing: { enabled: true, reactMinMs: 0, reactMaxMs: 0, perCharMs: 0 } }), { text: '零耗时' }), 0);
});

test('typing：配置写成怪值也不会算出负数或 NaN（失败要偏向"不等"）', () => {
  const bad = { typing: { enabled: true, reactMinMs: -100, reactMaxMs: 'x', perCharMs: 'y', maxDelayMs: -50 } };
  const ms = typingDelayMs(bad, { text: '随便说点什么' });
  assert.ok(Number.isFinite(ms) && ms >= 0, `应返回非负有限数，实际 ${ms}`);
});

test('e2e：打字延迟真的会推迟发送，且长回复等得更久', async () => {
  // 真实等待，所以把量级压到几十毫秒，避免测试变慢。
  const typing = { enabled: true, reactMinMs: 120, reactMaxMs: 120, perCharMs: 3, maxDelayMs: 300 };
  const env = await setup({ cfgOverrides: { typing } });
  const llm = await startMockLlm();
  env.cfg.llm.baseUrl = llm.url;
  llm.replies = ['一二三四五六七八九十'];
  try {
    const t0 = Date.now();
    env.server.push(groupMessage({ text: '在吗' }));
    await env.server.waitForApi('send_group_msg');
    const elapsed = Date.now() - t0;
    // 反应 120ms + 10 字 × 3ms = 150ms，扣掉生成耗时后仍应明显大于纯生成时间。
    assert.ok(elapsed >= 120, `应至少等一次反应时间，实际 ${elapsed}ms`);
    assert.equal(env.server.callsOf('send_group_msg')[0].params.message, '一二三四五六七八九十');
  } finally {
    await env.teardown();
    await llm.close();
  }
});

test('e2e：兜底回复（只 @ 不说话）也走打字延迟，不再秒回', async () => {
  const typing = { enabled: true, reactMinMs: 150, reactMaxMs: 150, perCharMs: 0, maxDelayMs: 0 };
  const env = await setup({ cfgOverrides: { typing } });
  const llm = await startMockLlm();
  env.cfg.llm.baseUrl = llm.url;
  try {
    const t0 = Date.now();
    env.server.push(groupMessage({ text: '' }));
    await env.server.waitForApi('send_group_msg');
    const elapsed = Date.now() - t0;
    assert.ok(elapsed >= 150, `兜底路径也应等反应时间，实际 ${elapsed}ms`);
    assert.equal(env.server.callsOf('send_group_msg')[0].params.message, DEFAULTS.persona.fallback);
    assert.equal(llm.requests.length, 0, '没说话就不该调模型');
  } finally {
    await env.teardown();
    await llm.close();
  }
});

// ---------------------------------------------------------------------------
// 「对方正在输入…」提示（NapCat 扩展动作，只在私聊有效）
// ---------------------------------------------------------------------------

test('e2e：私聊打字时先发「正在输入」提示，再发消息', async () => {
  const llm = await startMockLlm();
  llm.replies = ['在的呀'];
  const env = await setup({
    llmUrl: llm.url,
    cfgOverrides: {
      typing: { enabled: true, reactMinMs: 200, reactMaxMs: 200, perCharMs: 0, maxDelayMs: 0 },
      inputStatus: { enabled: true, minDelayMs: 0 },
      trigger: { private: { enabled: true, whitelist: ['888'] } },
    },
  });
  try {
    env.server.push(privateMessage({ text: '在吗', userId: '888' }));
    const call = await env.server.waitForApi('send_private_msg');
    assert.equal(call.params.message, '在的呀');

    const signals = env.server.callsOf('set_input_status');
    assert.equal(signals.length, 1, '私聊应该发一次「正在输入」');
    assert.equal(signals[0].params.user_id, '888');
    assert.equal(signals[0].params.event_type, 1);

    // 顺序很关键：提示必须出现在消息之前，否则毫无意义。
    const all = env.server.apiCalls;
    assert.ok(
      all.findIndex((c) => c.action === 'set_input_status') < all.findIndex((c) => c.action === 'send_private_msg'),
      '「正在输入」应先于消息发出',
    );
  } finally {
    await env.teardown();
    await llm.close();
  }
});

test('e2e：群聊不发「正在输入」（NapCat 的协议层只支持私聊）', async () => {
  const llm = await startMockLlm();
  llm.replies = ['在的'];
  const env = await setup({
    llmUrl: llm.url,
    cfgOverrides: {
      typing: { enabled: true, reactMinMs: 150, reactMaxMs: 150, perCharMs: 0, maxDelayMs: 0 },
      inputStatus: { enabled: true, minDelayMs: 0 },
    },
  });
  try {
    env.server.push(groupMessage({ text: '在吗' }));
    await env.server.waitForApi('send_group_msg');
    await sleep(50);
    assert.equal(env.server.callsOf('set_input_status').length, 0);
  } finally {
    await env.teardown();
    await llm.close();
  }
});

test('e2e：「正在输入」发失败也不影响回复（老版本 NapCat 没这个动作）', async () => {
  const llm = await startMockLlm();
  llm.replies = ['没事的'];
  const env = await setup({
    llmUrl: llm.url,
    cfgOverrides: {
      typing: { enabled: true, reactMinMs: 150, reactMaxMs: 150, perCharMs: 0, maxDelayMs: 0 },
      inputStatus: { enabled: true, minDelayMs: 0 },
      trigger: { private: { enabled: true, whitelist: ['888'] } },
    },
  });
  env.server.onApi('set_input_status', () => {
    throw new Error('不支持的 action');
  });
  try {
    env.server.push(privateMessage({ text: '在吗', userId: '888' }));
    const call = await env.server.waitForApi('send_private_msg');
    assert.equal(call.params.message, '没事的', '提示失败不能拦住这条回复');
  } finally {
    await env.teardown();
    await llm.close();
  }
});

test('e2e：停顿太短就别发「正在输入」（一闪而过比不发还假）', async () => {
  const llm = await startMockLlm();
  llm.replies = ['嗯'];
  const env = await setup({
    llmUrl: llm.url,
    cfgOverrides: {
      typing: { enabled: true, reactMinMs: 100, reactMaxMs: 100, perCharMs: 0, maxDelayMs: 0 },
      inputStatus: { enabled: true, minDelayMs: 5000 },
      trigger: { private: { enabled: true, whitelist: ['888'] } },
    },
  });
  try {
    env.server.push(privateMessage({ text: '在吗', userId: '888' }));
    await env.server.waitForApi('send_private_msg');
    await sleep(50);
    assert.equal(env.server.callsOf('set_input_status').length, 0);
  } finally {
    await env.teardown();
    await llm.close();
  }
});

test('e2e：inputStatus.enabled=false 时完全不发提示', async () => {
  const llm = await startMockLlm();
  llm.replies = ['嗯'];
  const env = await setup({
    llmUrl: llm.url,
    cfgOverrides: {
      typing: { enabled: true, reactMinMs: 100, reactMaxMs: 100, perCharMs: 0, maxDelayMs: 0 },
      inputStatus: { enabled: false, minDelayMs: 0 },
      trigger: { private: { enabled: true, whitelist: ['888'] } },
    },
  });
  try {
    env.server.push(privateMessage({ text: '在吗', userId: '888' }));
    await env.server.waitForApi('send_private_msg');
    await sleep(50);
    assert.equal(env.server.callsOf('set_input_status').length, 0);
  } finally {
    await env.teardown();
    await llm.close();
  }
});

test('onebot：setInputStatus 把 QQ 号和事件类型原样传给 NapCat', async () => {
  const env = await setup();
  try {
    await env.onebot.setInputStatus('2000000001', 1);
    const call = env.server.callsOf('set_input_status')[0];
    assert.equal(call.params.user_id, '2000000001');
    assert.equal(call.params.event_type, 1);
  } finally {
    await env.teardown();
  }
});

// ---------------------------------------------------------------------------
// LLM 层
// ---------------------------------------------------------------------------

test('llm：buildMessages 控制字数预算并保留最近对话', () => {
  const cfg = makeCfg();
  const history = [
    { role: 'user', sender: 'A', senderId: '1', text: '很早以前的话'.repeat(50) },
    { role: 'user', sender: 'B', senderId: '2', text: '最近一句' },
  ];
  const msgs = buildMessages(buildSystemPrompt(cfg, { isGroup: true, groupId: '555' }), history, { maxChars: 20 });
  assert.equal(msgs[0].role, 'system');
  assert.ok(msgs.some((m) => m.content.includes('最近一句')));
});

test('llm：buildMessages 合并连续 assistant 且不以 assistant 开头', () => {
  const msgs = buildMessages('sys', [
    { role: 'assistant', text: '我先说的' },
    { role: 'assistant', text: '又一句' },
    { role: 'user', sender: 'A', text: '嗯' },
  ]);
  assert.equal(msgs[1].role, 'user');
  assert.equal(msgs[1].content, 'A：嗯');
});

// 图片只能挂在 user 消息上（DeepSeek：system/assistant 带图会 400），
// 而且只挂"刚发的这条" —— 历史里的图不重复携带，否则每轮都为老图再付一次 token。
test('llm：buildMessages 把图片挂到最后一条 user 消息，并带上"看不清别猜"的提示', () => {
  const imgs = ['data:image/png;base64,AAAA'];
  const msgs = buildMessages('sys', [
    { role: 'user', sender: 'A', senderId: '1', text: '第一句' },
    { role: 'assistant', text: '回一句' },
    { role: 'user', sender: 'A', senderId: '1', text: '看我发的图' },
  ], { images: imgs });

  assert.equal(msgs[0].role, 'system');
  const last = msgs[msgs.length - 1];
  assert.equal(last.role, 'user');
  assert.ok(Array.isArray(last.content), '带图的消息 content 应该是数组');
  assert.match(last.content[0].text, /看我发的图/);
  assert.match(last.content[0].text, /千万不要猜/);
  const parts = last.content.filter((c) => c.type === 'image_url');
  assert.equal(parts.length, 1);
  assert.equal(parts[0].image_url.url, imgs[0]);

  // 前面的历史消息必须原样是字符串，绝不能也挂上图
  for (const m of msgs.slice(1, -1)) {
    assert.equal(typeof m.content, 'string');
  }
});

test('llm：没有图片时 buildMessages 结构完全不变（老行为不破）', () => {
  const msgs = buildMessages('sys', [{ role: 'user', sender: 'A', text: '嗯' }]);
  assert.equal(msgs.length, 2);
  assert.equal(typeof msgs[1].content, 'string');
});

test('llm：buildMessages 收到空图片数组时也不改变结构', () => {
  const msgs = buildMessages('sys', [{ role: 'user', sender: 'A', text: '嗯' }], { images: [] });
  assert.equal(typeof msgs[1].content, 'string');
});

test('llm：群聊 system prompt 包含群号和 @ 语境', () => {
  const p = buildSystemPrompt(makeCfg(), { isGroup: true, groupId: '555' });
  assert.ok(p.includes('555'));
  assert.ok(p.includes('@'));
});

test('llm：chatCompletion 处理非 200 响应并抛出可读错误', async () => {
  const llm = await startMockLlm();
  llm.failWith = { status: 500, message: 'boom' };
  try {
    await assert.rejects(
      () => chatCompletion(makeCfg({ llm: { baseUrl: llm.url, apiKey: 'k', timeoutMs: 3000 } }).llm, [
        { role: 'user', content: 'hi' },
      ]),
      /LLM HTTP 500/,
    );
  } finally {
    await llm.close();
  }
});

test('llm：baseUrl 末尾斜杠不会产生双斜杠', async () => {
  const llm = await startMockLlm();
  try {
    await chatCompletion(makeCfg({ llm: { baseUrl: `${llm.url}/`, apiKey: 'k' } }).llm, [
      { role: 'user', content: 'hi' },
    ]);
    assert.equal(llm.requests[0].url, '/v1/chat/completions');
  } finally {
    await llm.close();
  }
});

// ---------------------------------------------------------------------------
// 人设文件（persona.systemPromptFile）
// ---------------------------------------------------------------------------

/** 在临时目录造一份 config.json，指向给定的人设文件。 */
function writeCfgWithPersona(personaRel, extra = {}) {
  const dir = fs.mkdtempSync(path.join(tmpRoot, 'persona-'));
  const file = path.join(dir, 'config.json');
  // apiKey 填上：否则 validateConfig 会额外报"apiKey 为空"，干扰"有没有人设告警"的判断。
  fs.writeFileSync(
    file,
    JSON.stringify({ llm: { apiKey: 'test-key' }, persona: { systemPromptFile: personaRel, ...extra } }),
    'utf8',
  );
  return file;
}

test('人设文件：整段进 system prompt，注释与简版人设都不参与', () => {
  const dir = fs.mkdtempSync(path.join(tmpRoot, 'persona-'));
  const personaFile = path.join(dir, 'persona.md');
  fs.writeFileSync(
    personaFile,
    '<!-- 这段使用说明是写给用户看的，不该进模型 -->\n\n你将扮演流萤。称呼对方为"开拓者"。\n',
    'utf8',
  );
  const cfg = loadConfig(writeCfgWithPersona(personaFile));
  assert.ok(cfg.persona.systemPromptText.includes('开拓者'));
  assert.ok(!cfg.persona.systemPromptText.includes('写给用户看的'), 'HTML 注释必须被剥掉');

  const p = buildSystemPrompt(cfg, { isGroup: true, groupId: '555' });
  assert.ok(p.startsWith('你将扮演流萤'), '文件人设应排在 prompt 最前面');
  assert.ok(!p.includes(DEFAULTS.persona.description), '文件人设生效时不叠加简版 description');
  assert.ok(!p.includes('硬性要求：'), '文件人设生效时不叠加简版 rules');
  assert.ok(p.includes('555'), '运行时语境仍要保留');

  const { warnings } = validateConfig(cfg);
  assert.deepEqual(warnings, []);
});

test('人设文件：缺失时退回简版并给出警告，而不是启动失败', () => {
  const dir = fs.mkdtempSync(path.join(tmpRoot, 'persona-'));
  const cfg = loadConfig(writeCfgWithPersona(path.join(dir, '不存在.md')));
  assert.equal(cfg.persona.systemPromptText, '');

  const p = buildSystemPrompt(cfg, { isGroup: false });
  assert.ok(p.includes(DEFAULTS.persona.description), '应退回简版 description');
  assert.ok(p.includes('硬性要求：'), '应退回简版 rules');

  const { errors, warnings } = validateConfig(cfg);
  assert.deepEqual(errors, []);
  assert.ok(warnings.some((w) => w.includes('人设文件不存在')), '要给警告，不能静默');
});

test('人设文件：不设置 systemPromptFile 时走简版且无警告', () => {
  const configFile = writeCfgWithPersona('');
  const cfg = loadConfig(configFile);
  assert.equal(cfg.persona.systemPromptText, '');
  assert.deepEqual(validateConfig(cfg).warnings, []);
});

// ---------------------------------------------------------------------------
// 开拓者身份区分（owner.qq）
// ---------------------------------------------------------------------------

test('isOwner：只有 owner.qq 那一个号是开拓者，没配就谁都不是', () => {
  const cfg = makeCfg({ owner: { qq: '2000000001' } });
  assert.equal(isOwner(cfg, '2000000001'), true);
  assert.equal(isOwner(cfg, 2000000001), true, '数字和字符串都应认出');
  assert.equal(isOwner(cfg, '2000000002'), false);
  assert.equal(isOwner(cfg, ''), false);

  // 默认没配 owner.qq → 恒为 false。宁可对号主生分，也不能把陌生人当号主。
  assert.equal(isOwner(makeCfg(), '2000000001'), false);
  assert.equal(isOwner(makeCfg({ owner: { qq: '   ' } }), '2000000001'), false);
});

test('llm：群里 @ 的是开拓者 → prompt 走"对开拓者"语境', () => {
  const cfg = makeCfg({ owner: { qq: '2000000001' } });
  const p = buildSystemPrompt(cfg, { isGroup: true, groupId: '555', isOwner: true });
  assert.ok(p.includes('开拓者'));
  assert.ok(p.includes('他是这个 QQ 号的主人本人'), '应点明主人身份');
  assert.ok(!p.includes('不是开拓者'), '不该出现"别人"分支的措辞');
  assert.ok(p.includes('555'), '群号仍要保留');
});

test('llm：群里 @ 的是普通群友 → prompt 走"普通群友"语境，不认开拓者', () => {
  const cfg = makeCfg({ owner: { qq: '2000000001' } });
  const p = buildSystemPrompt(cfg, { isGroup: true, groupId: '555', isOwner: false });
  assert.ok(p.includes('这个人是群里的普通成员'), '应点明是普通群友');
  assert.ok(p.includes('不是开拓者'));
  assert.ok(p.includes('不要称他为"开拓者"'), '要显式禁止套用称呼');
  assert.ok(!p.includes('他是这个 QQ 号的主人本人'), '不该出现开拓者分支的措辞');
  assert.ok(p.includes('555'));
});

test('llm：私聊开拓者更亲近但不放开长度，私聊陌生人要守距离', () => {
  const cfg = makeCfg({ owner: { qq: '2000000001' } });
  const ownerP = buildSystemPrompt(cfg, { isGroup: false, isOwner: true });
  assert.ok(ownerP.includes('这里没有外人'));
  assert.ok(ownerP.includes('更亲近'), '私聊开拓者仍要更亲近');
  // 曾经的措辞是"多说几句"，实测把私聊推成了长回复（中位 83 字、48% 超 90），故收掉。
  assert.ok(!ownerP.includes('多说几句'), '不该再放开长度');
  assert.ok(ownerP.includes('一次只讲一件事'), '要改成"短句、一次一件事"');

  const strangerP = buildSystemPrompt(cfg, { isGroup: false, isOwner: false });
  assert.ok(strangerP.includes('不认识的人私聊'));
  assert.ok(strangerP.includes('保持礼貌和距离'));
  assert.ok(!strangerP.includes('这里没有外人'));
});

// ---------------------------------------------------------------------------
// 短期自身话记忆（selfMemory）+ 历史按「轮」取（context.*Turns）
// 背景：实测私聊最近 20 行里她自己占 13 行（65%），窗口边界常落在一轮中间，
// 开头那半条助手消息会被 buildMessages 丢掉；而她的多气泡被合并成一条 assistant，
// 滑出窗口后就"不知道自己答应过什么"，会把同一件事又郑重答应一遍。
// ---------------------------------------------------------------------------

test('store.recentTurns：按轮取历史，开头不会剩半条助手消息', () => {
  const store = makeStore();
  try {
    const add = (role, text, origin, ts) =>
      store.addMessage({ scope: 'private', scopeId: '888', senderId: role === 'assistant' ? SELF : '888', sender: role === 'assistant' ? '我' : '他', role, origin, text, ts });

    add('user', '第一轮我说的话', 'user', 1000);
    add('assistant', '第一轮她的回复之一', 'ai', 1001);
    // 第二轮：她连发 3 条气泡（在模型眼里这 3 条会被合并成一条 assistant）。
    add('user', '第二轮我说的话', 'user', 2000);
    add('assistant', '第二轮她的回复之一', 'ai', 2001);
    add('assistant', '第二轮她的回复之二', 'ai', 2002);
    add('assistant', '第二轮她的回复之三', 'ai', 2003);
    add('user', '第三轮我说的话', 'user', 3000);
    add('assistant', '第三轮她的回复', 'ai', 3001);

    // 取最近 2 轮 = 第三轮 + 第二轮（含第二轮那条 user 开场），第一轮整轮被挤出。
    const two = store.recentTurns('private', '888', 2);
    assert.deepEqual(
      two.map((r) => r.text),
      ['第二轮我说的话', '第二轮她的回复之一', '第二轮她的回复之二', '第二轮她的回复之三', '第三轮我说的话', '第三轮她的回复'],
    );
    assert.equal(two[0].text, '第二轮我说的话', '起点必须落在一轮的"对方发言"上，不能是半条助手消息');

    const one = store.recentTurns('private', '888', 1);
    assert.deepEqual(one.map((r) => r.text), ['第三轮我说的话', '第三轮她的回复']);

    // 轮数超过实际拥有的轮数时，全部返回，交给上层字数预算裁剪。
    assert.equal(store.recentTurns('private', '888', 99).length, 8);
    // 空会话不能崩。
    assert.deepEqual(store.recentTurns('private', 'nobody', 3), []);
  } finally {
    store.close();
  }
});

test('store.recentSelfTexts：只收她 AI 说的话，不收号主手打的', () => {
  const store = makeStore();
  try {
    const add = (role, text, origin) =>
      store.addMessage({ scope: 'private', scopeId: '888', senderId: 'x', sender: 'x', role, origin, text, ts: Date.now() });

    add('user', '在吗', 'user');
    add('assistant', '在的，怎么啦', 'ai');
    add('assistant', '我刚从外面回来', 'ai');
    // 号主本人在客户端手打的，不算"她说过的话"。
    add('assistant', '我自己来回', 'human');
    add('user', '哦哦', 'user');
    add('assistant', '嗯嗯', 'ai');

    const texts = store.recentSelfTexts('private', '888', 8);
    assert.deepEqual(texts, ['在的，怎么啦', '我刚从外面回来', '嗯嗯']);
    assert.ok(!texts.includes('我自己来回'), 'origin=human 是号主手打的，不能算她说的');
    // 时间正序（旧 → 新），上层据此从后往前塞预算。
    assert.equal(texts[0], '在的，怎么啦');
  } finally {
    store.close();
  }
});

test('llm：注入"你方才自己说过的话"并明确要求不要重复说', () => {
  const cfg = makeCfg();
  const withSelf = buildSystemPrompt(cfg, {
    isGroup: false,
    selfTexts: ['我待会儿给你看窗外的样子', '记得吃饭哦'],
  });
  assert.ok(withSelf.includes('你方才自己说过的话'));
  assert.ok(withSelf.includes('我待会儿给你看窗外的样子'));
  assert.ok(withSelf.includes('记得吃饭哦'));
  assert.ok(withSelf.includes('同一件事不要重复说'), '必须点明"别再说一遍"');
  assert.ok(withSelf.includes('不要念出来'), '提醒不能被当成台词复述');

  // 没传 / 传空数组时，结构与从前完全一致（不能凭空多出一段）。
  const none = buildSystemPrompt(cfg, { isGroup: false });
  assert.ok(!none.includes('你方才自己说过的话'));
  assert.equal(buildSystemPrompt(cfg, { isGroup: false, selfTexts: [] }), none);

  // 动态内容仍排在最后：selfTexts 段必须在人设之后（前缀缓存要求）。
  assert.ok(withSelf.indexOf('你方才自己说过的话') > withSelf.indexOf(cfg.persona.description));
});

test('e2e：连续两轮时，第二轮能看到自己上一轮说过的话', async () => {
  const llm = await startMockLlm();
  llm.replies = ['我待会儿给你看窗外的样子'];
  const env = await setup({
    llmUrl: llm.url,
    cfgOverrides: {
      trigger: { private: { enabled: true, whitelist: ['888'] } },
      selfMemory: { enabled: true, turns: 8, limit: 8, maxChars: 400, maxItemChars: 60 },
    },
  });
  try {
    env.server.push(privateMessage({ text: '在干嘛', userId: '888' }));
    await waitFor(() => env.server.callsOf('send_private_msg').length === 1);
    await sleep(200);

    llm.replies = ['好呀'];
    env.server.push(privateMessage({ text: '好', userId: '888' }));
    await waitFor(() => env.server.callsOf('send_private_msg').length === 2);

    const second = llm.requests[1].body.messages[0].content;
    assert.ok(second.includes('你方才自己说过的话'), '第二轮就该带上自己说过的话');
    assert.ok(second.includes('我待会儿给你看窗外的样子'), '要能看到上一轮的具体内容');
  } finally {
    await env.teardown();
    await llm.close();
  }
});

test('e2e：selfMemory.enabled=false 时不注入（老配置行为不变）', async () => {
  const llm = await startMockLlm();
  llm.replies = ['我待会儿给你看窗外的样子'];
  const env = await setup({
    llmUrl: llm.url,
    cfgOverrides: {
      trigger: { private: { enabled: true, whitelist: ['888'] } },
      selfMemory: { enabled: false },
    },
  });
  try {
    env.server.push(privateMessage({ text: '在干嘛', userId: '888' }));
    await waitFor(() => env.server.callsOf('send_private_msg').length === 1);
    await sleep(200);

    llm.replies = ['好呀'];
    env.server.push(privateMessage({ text: '好', userId: '888' }));
    await waitFor(() => env.server.callsOf('send_private_msg').length === 2);

    const second = llm.requests[1].body.messages[0].content;
    assert.ok(!second.includes('你方才自己说过的话'), '关掉后一个字都不该注入');
  } finally {
    await env.teardown();
    await llm.close();
  }
});

test('e2e：私聊窗口按 privateTurns 截断，对方说过的话不会被她的气泡挤光', async () => {
  const llm = await startMockLlm();
  const env = await setup({
    llmUrl: llm.url,
    cfgOverrides: {
      trigger: { private: { enabled: true, whitelist: ['888'] } },
      // 只留 2 轮，验证轮数真的生效。
      context: { privateTurns: 2, maxChars: 100000 },
      selfMemory: { enabled: false },
    },
  });
  try {
    // 三轮：第一轮的内容应当被挤出窗口。
    for (const t of ['第一轮的话', '第二轮的话', '第三轮的话']) {
      llm.replies = [`回应${t}`];
      env.server.push(privateMessage({ text: t, userId: '888' }));
      await waitFor(() => env.server.callsOf('send_private_msg').length >= 1);
      await waitFor(() => llm.requests.length >= 1);
      await sleep(250);
    }

    const last = llm.requests[llm.requests.length - 1].body.messages;
    const sent = last[last.length - 1].content;
    const all = typeof sent === 'string' ? sent : JSON.stringify(sent);
    assert.ok(all.includes('第三轮的话'), '最近一轮必须在');
    assert.ok(!all.includes('第一轮的话'), 'privateTurns=2 时应已挤出更早的轮次');
  } finally {
    await env.teardown();
    await llm.close();
  }
});

test('e2e：群里大号(owner) @ 与普通群友 @ 拿到的 prompt 不同', async () => {
  const llm = await startMockLlm();
  llm.replies = ['在的'];
  const env = await setup({ llmUrl: llm.url, cfgOverrides: { owner: { qq: '2000000001' } } });
  try {
    env.server.push(groupMessage({ text: '在吗', userId: '2000000001' }));
    await env.server.waitForApi('send_group_msg');
    const ownerPrompt = llm.requests[0].body.messages[0].content;
    assert.ok(ownerPrompt.includes('他是这个 QQ 号的主人本人'), '大号应被当成开拓者');

    // 等上一条流水线彻底结束（发送 + limiter.end），否则第二条会撞 inflight_limit 被跳过。
    await waitFor(() => env.server.callsOf('send_group_msg').length === 1 && llm.requests.length === 1);
    await sleep(200);

    env.server.push(groupMessage({ text: '在吗', userId: '777' }));
    await waitFor(() => llm.requests.length >= 2);
    const strangerPrompt = llm.requests[1].body.messages[0].content;
    assert.ok(strangerPrompt.includes('这个人是群里的普通成员'), '其他群友应是普通群友');
    assert.ok(!strangerPrompt.includes('他是这个 QQ 号的主人本人'));
  } finally {
    await env.teardown();
    await llm.close();
  }
});

test('e2e：私聊气泡比群聊更短（split.privateMaxLength），群聊不受影响', async () => {
  const longReply = '第一句话在这里。第二句话在这里。第三句话在这里。第四句话在这里。第五句话在这里。';
  const splitCfg = {
    enabled: true, maxLength: 90, privateMaxLength: 12, maxSegments: 3, privateMaxSegments: 5,
    delayMinMs: 0, delayMaxMs: 0,
  };

  // 私聊：按 privateMaxLength=12 切 → 35 字会切成多段
  const llm = await startMockLlm();
  llm.replies = [longReply];
  const env = await setup({
    llmUrl: llm.url,
    cfgOverrides: { split: splitCfg, trigger: { private: { enabled: true, whitelist: [] } } },
  });
  try {
    env.server.push(privateMessage({ text: '讲讲', userId: '2000000001' }));
    const calls = await waitFor(() => {
      const c = env.server.callsOf('send_private_msg');
      return c.length >= 2 ? c : false;
    });
    assert.ok(calls.length > 1, '私聊应按 privateMaxLength 收紧成多条短气泡');
    for (const c of calls) {
      assert.ok(String(c.params.message).length <= 12, `每条不应超过 privateMaxLength：${c.params.message}`);
    }
  } finally {
    await env.teardown();
    await llm.close();
  }

  // 群聊：只认 maxLength=90，同一条 35 字回复不该被切
  const llm2 = await startMockLlm();
  llm2.replies = [longReply];
  const env2 = await setup({ llmUrl: llm2.url, cfgOverrides: { split: splitCfg } });
  try {
    env2.server.push(groupMessage({ text: '讲讲' }));
    await sleep(600);
    const calls = env2.server.callsOf('send_group_msg');
    assert.equal(calls.length, 1, '群聊仍用 maxLength，不该被私聊的收紧影响');
  } finally {
    await env2.teardown();
    await llm2.close();
  }
});

test('e2e：换行 = 多条气泡（bubbleOnNewline 接线到配置）', async () => {
  // 人设教她"想分两句就用换行"，这条验证那句教导真的兑现了：
  // 一条含换行的回复在网上应该变成多个气泡，而不是被压成一条。
  const replyWithNewlines = '我也想你\n刚才还在想，你今晚会不会来';
  const splitCfg = {
    enabled: true, maxLength: 90, privateMaxLength: 45, maxSegments: 3, privateMaxSegments: 5,
    delayMinMs: 0, delayMaxMs: 0, bubbleOnNewline: true,
  };

  const llm = await startMockLlm();
  llm.replies = [replyWithNewlines];
  const env = await setup({
    llmUrl: llm.url,
    cfgOverrides: { split: splitCfg, trigger: { private: { enabled: true, whitelist: [] } } },
  });
  try {
    env.server.push(privateMessage({ text: '在吗', userId: '2000000001' }));
    const calls = await waitFor(() => {
      const c = env.server.callsOf('send_private_msg');
      return c.length >= 2 ? c : false;
    });
    assert.equal(calls.length, 2, '一个换行 = 一条消息');
    assert.equal(calls[0].params.message, '我也想你');
    assert.equal(calls[1].params.message, '刚才还在想，你今晚会不会来');
  } finally {
    await env.teardown();
    await llm.close();
  }

  // 关掉开关 → 退回旧行为：换行被压成空格，整条发出去
  const llm2 = await startMockLlm();
  llm2.replies = [replyWithNewlines];
  const env2 = await setup({
    llmUrl: llm2.url,
    cfgOverrides: {
      split: { ...splitCfg, bubbleOnNewline: false },
      trigger: { private: { enabled: true, whitelist: [] } },
    },
  });
  try {
    env2.server.push(privateMessage({ text: '在吗', userId: '2000000001' }));
    const calls = await waitFor(() => {
      const c = env2.server.callsOf('send_private_msg');
      return c.length >= 1 ? c : false;
    });
    assert.equal(calls.length, 1, '关掉后不该按换行切');
    assert.equal(calls[0].params.message, '我也想你 刚才还在想，你今晚会不会来');
  } finally {
    await env2.teardown();
    await llm2.close();
  }
});

test('e2e：私聊比群聊允许更多分段（split.privateMaxSegments）', async () => {
  const longReply = '第一句话在这里。第二句话在这里。第三句话在这里。第四句话在这里。第五句话在这里。';
  const splitCfg = {
    enabled: true, maxLength: 12, privateMaxLength: 12, maxSegments: 3, privateMaxSegments: 5,
    delayMinMs: 0, delayMaxMs: 0,
  };

  const llm = await startMockLlm();
  llm.replies = [longReply];
  const env = await setup({
    llmUrl: llm.url,
    cfgOverrides: { split: splitCfg, trigger: { private: { enabled: true, whitelist: [] } } },
  });
  try {
    env.server.push(privateMessage({ text: '讲讲', userId: '2000000001' }));
    const calls = await waitFor(() => {
      const c = env.server.callsOf('send_private_msg');
      return c.length >= 5 ? c : false;
    });
    assert.equal(calls.length, 5, '私聊应放行到 5 段');
  } finally {
    await env.teardown();
    await llm.close();
  }

  // 同样的回复放群里 → 仍受 maxSegments=3 限制，不刷屏
  const llm2 = await startMockLlm();
  llm2.replies = [longReply];
  const env2 = await setup({ llmUrl: llm2.url, cfgOverrides: { split: splitCfg } });
  try {
    env2.server.push(groupMessage({ text: '讲讲' }));
    await sleep(600);
    const calls = env2.server.callsOf('send_group_msg');
    assert.equal(calls.length, 3, '群聊仍应限制在 3 段');
  } finally {
    await env2.teardown();
    await llm2.close();
  }
});

// ---------------------------------------------------------------------------
// 实时感知 + 长期记忆（接线到主链路）
// ---------------------------------------------------------------------------
/** 造一个已经缓存好天气的 Awareness，测试里不碰真实网络。 */
async function readyAwareness(cfgOverrides = {}) {
  const awareness = new Awareness(makeCfg(cfgOverrides));
  const real = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      current: { temperature_2m: 23.8, apparent_temperature: 23.8, relative_humidity_2m: 59, weather_code: 0, wind_speed_10m: 12.3 },
      daily: { temperature_2m_max: [29], temperature_2m_min: [21.6], weather_code: [2] },
    }),
  });
  try {
    await awareness.refreshWeather();
  } finally {
    globalThis.fetch = real;
  }
  return awareness;
}

test('e2e：感知与记忆都接进 system prompt，且都排在最后（前缀缓存不破）', async () => {
  const llm = await startMockLlm();
  llm.replies = ['记得呀，你的吉他还练着吗'];
  const awareness = await readyAwareness();
  const cfg = makeCfg();
  const store = makeStore();
  // 手动预置一条记忆，模拟"以前聊过"
  store.addMemory({ scope: 'group', scopeId: '555', subject: '777', text: '开拓者最近在学吉他', kind: 'event' });
  const memory = new MemoryManager({ cfg, store, llm: { chat: async () => ({ text: '{"memories":[]}' }) } });

  const env = await setup({ llmUrl: llm.url, awareness, memory });
  try {
    // 先攒一条历史消息，好让"距上次说话"有得算
    env.store.addMessage({ scope: 'group', scopeId: '555', senderId: '777', sender: '小明', role: 'user', text: '在吗', ts: Date.now() - 3600_000 });
    env.server.push(groupMessage({ text: '你还记得我最近在干嘛吗' }));
    await waitFor(() => llm.chatRequests().length >= 1);

    const system = llm.chatRequests()[0].body.messages[0].content;
    assert.match(system, /你此刻的感知（真实信息，可以自然地说到）：/);
    assert.match(system, /- 现在是 \d{4}年\d{1,2}月\d{1,2}日/);
    assert.match(system, /天气：杭州 现在 23\.8°C/);
    assert.match(system, /距上次说话：1 小时前/);
    assert.match(system, /你记得关于对方的事：/);
    assert.match(system, /- 开拓者最近在学吉他（近况）/);
    // 动态内容必须排在最后那句输出要求之前，但人设与场合仍在最前面
    const lastLine = system.slice(system.lastIndexOf('\n') + 1);
    assert.match(lastLine, /^只输出你要发出去的消息正文/);
    assert.ok(system.indexOf('你此刻的感知') < system.indexOf(lastLine));
    assert.ok(system.indexOf('你记得关于对方的事') < system.indexOf(lastLine));
    assert.ok(system.indexOf('你此刻的感知') > system.indexOf('当前场合'));
  } finally {
    await env.teardown();
    await llm.close();
  }
});

test('e2e：没配感知与记忆时，prompt 里不出现这两段（老行为不变）', async () => {
  const llm = await startMockLlm();
  const env = await setup({ llmUrl: llm.url });
  try {
    env.server.push(groupMessage({ text: '在吗' }));
    await waitFor(() => llm.chatRequests().length >= 1);
    const system = llm.chatRequests()[0].body.messages[0].content;
    assert.doesNotMatch(system, /你此刻的感知/);
    assert.doesNotMatch(system, /你记得关于对方的事/);
  } finally {
    await env.teardown();
    await llm.close();
  }
});

test('e2e：回复发出后异步抽记忆，写入库，且不需要等它', async () => {
  const llm = await startMockLlm();
  llm.replies = ['好呀，学吉他挺好的'];
  llm.extractReply = JSON.stringify({
    memories: [
      { text: '开拓者最近在学吉他', kind: 'event', subject: 'other' },
      { text: '开拓者不吃香菜', kind: 'preference', subject: 'other' },
    ],
  });
  const cfg = makeCfg();
  const store = makeStore();
  const memory = new MemoryManager({
    cfg,
    store,
    // 抽取走同一个 mock 端点，所以 baseUrl 要指向它，不能用 makeCfg 里那个占位地址。
    llm: { chat: (m, o) => chatCompletion({ ...cfg.llm, baseUrl: llm.url }, m, o) },
  });
  const env = await setup({ llmUrl: llm.url, memory });
  try {
    env.server.push(groupMessage({ text: '我最近在学吉他，还不吃香菜' }));
    await env.server.waitForApi('send_group_msg');
    // 抽取是后台跑的，等它落库
    await waitFor(() => store.countMemories('group', '555') >= 2, { timeoutMs: 5000 });
    const rows = store.listMemories('group', '555');
    assert.equal(rows.length, 2);
    assert.ok(rows.some((r) => r.text.includes('吉他')));
    assert.ok(rows.some((r) => r.text.includes('香菜')));
    assert.equal(memory.stats.extracted, 1);
    // 抽取器收到的是"当前这句话 + 历史"，否则刚说的话永远抽不到
    const extractBody = llm.extractRequests()[0].body.messages.find((m) => m.role === 'user').content;
    assert.match(extractBody, /我最近在学吉他/);
  } finally {
    await env.teardown();
    await llm.close();
  }
});

test('e2e：记忆抽取失败不影响回复已经发出去（发射后不管）', async () => {
  const llm = await startMockLlm();
  llm.replies = ['收到啦'];
  llm.extractReply = '这不是 JSON，模型抽风了';
  const cfg = makeCfg();
  const store = makeStore();
  const memory = new MemoryManager({
    cfg,
    store,
    llm: { chat: (m, o) => chatCompletion({ ...cfg.llm, baseUrl: llm.url }, m, o) },
  });
  const env = await setup({ llmUrl: llm.url, memory });
  try {
    env.server.push(groupMessage({ text: '你好' }));
    const calls = await env.server.waitForApi('send_group_msg');
    assert.equal(calls.params.message, '收到啦');
    await sleep(400);
    assert.equal(store.countMemories('group', '555'), 0);
  } finally {
    await env.teardown();
    await llm.close();
  }
});

test('e2e：收回来的记忆下一轮就能用上（跨两轮）', async () => {
  const llm = await startMockLlm();
  llm.replies = ['好呀，学吉他手指会痛吧'];
  llm.extractReply = JSON.stringify({ memories: [{ text: '开拓者最近在学吉他', kind: 'event', subject: 'other' }] });
  const cfg = makeCfg();
  const store = makeStore();
  const memory = new MemoryManager({
    cfg,
    store,
    llm: { chat: (m, o) => chatCompletion({ ...cfg.llm, baseUrl: llm.url }, m, o) },
  });
  const env = await setup({ llmUrl: llm.url, memory });
  try {
    // 第一轮：说出偏好，后台记下来
    env.server.push(groupMessage({ text: '我最近在学吉他', messageId: 9001 }));
    await waitFor(() => store.countMemories('group', '555') >= 1, { timeoutMs: 5000 });
    await waitFor(() => env.server.callsOf('send_group_msg').length === 1);
    await sleep(200);

    // 第二轮：说一句和"吉他"有词面重合的话，prompt 里应该带上那条记忆。
    // 注意检索是 n-gram 词面匹配（不是语义）：必须真的有几个字重合才召得回。
    llm.replies = ['手指痛就先歇一歇呀'];
    env.server.push(groupMessage({ text: '我最近学吉他，手指好痛', messageId: 9002 }));
    await waitFor(() => llm.chatRequests().length >= 2, { timeoutMs: 5000 });
    const system = llm.chatRequests()[1].body.messages[0].content;
    assert.match(system, /- 开拓者最近在学吉他（近况）/, '上一轮记下的事，这一轮该想起来了');
  } finally {
    await env.teardown();
    await llm.close();
  }
});

test('e2e：记忆检索是词面匹配 —— 字面完全不重合的话想不起来（这是已知边界）', async () => {
  const llm = await startMockLlm();
  llm.replies = ['嗯嗯'];
  const cfg = makeCfg();
  const store = makeStore();
  store.addMemory({ scope: 'group', scopeId: '555', subject: '777', text: '开拓者最近在学吉他', kind: 'event' });
  const memory = new MemoryManager({ cfg, store, llm: { chat: async () => ({ text: '{}' }) } });
  const env = await setup({ llmUrl: llm.url, memory });
  try {
    // 「我的手指好痛」与「开拓者最近在学吉他」没有一个 2-gram 重合 → 捞不回来
    env.server.push(groupMessage({ text: '我的手指好痛', messageId: 9101 }));
    await waitFor(() => llm.chatRequests().length >= 1, { timeoutMs: 5000 });
    const system = llm.chatRequests()[0].body.messages[0].content;
    assert.doesNotMatch(system, /你记得关于对方的事：/);
  } finally {
    await env.teardown();
    await llm.close();
  }
});

test('e2e：记忆检索异常时照常回复（记忆不能拖垮主链路）', async () => {
  const llm = await startMockLlm();
  llm.replies = ['在的'];
  const broken = {
    recallEnabled: true,
    extractEnabled: false,
    retrieve() {
      throw new Error('数据库炸了');
    },
  };
  const env = await setup({ llmUrl: llm.url, memory: broken });
  try {
    env.server.push(groupMessage({ text: '在吗' }));
    const calls = await env.server.waitForApi('send_group_msg');
    assert.equal(calls.params.message, '在的', '记忆检索失败也要把话回出去');
  } finally {
    await env.teardown();
    await llm.close();
  }
});

// ---------------------------------------------------------------------------
// 看图：图片真的送到模型眼前了吗
// ---------------------------------------------------------------------------

test('e2e：群里发图 @机器人 → 图片以 data URL 送进模型', async () => {
  const llm = await startMockLlm();
  llm.replies = ['这张图里有一只猫呀'];
  const img = await startImageServer();
  const vision = new ImageFetcher(deepMerge(DEFAULTS, {}).vision);
  const env = await setup({ llmUrl: llm.url, vision });
  try {
    const base = groupMessage({ text: '看这个', messageId: 9501 });
    base.message.splice(1, 0, { type: 'image', data: { url: img.url, file: 'cat.png' } });
    env.server.push(base);

    await waitFor(() => llm.chatRequests().length >= 1, { timeoutMs: 5000 });
    const msgs = llm.chatRequests()[0].body.messages;
    const last = msgs[msgs.length - 1];
    assert.equal(last.role, 'user');
    assert.ok(Array.isArray(last.content), '带图的消息 content 必须是数组，否则模型收不到图');
    const imgs = last.content.filter((c) => c.type === 'image_url');
    assert.equal(imgs.length, 1);
    assert.match(imgs[0].image_url.url, /^data:image\/png;base64,/);
    // 图片地址只给模型 data URL，不该把 QQ 的临时链接漏出去
    assert.doesNotMatch(JSON.stringify(last.content), new RegExp(img.url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.equal(img.hits, 1);

    const call = await env.server.waitForApi('send_group_msg');
    assert.equal(call.params.message, '这张图里有一只猫呀');
  } finally {
    await env.teardown();
    await img.close();
    await llm.close();
  }
});

test('e2e：图片下载失败时照常回复，只是没有图（一张图不能拦整条回复）', async () => {
  const llm = await startMockLlm();
  llm.replies = ['我没看到图呀'];
  const img = await startImageServer();
  img.status = 500;
  const vision = new ImageFetcher(deepMerge(DEFAULTS, {}).vision);
  const env = await setup({ llmUrl: llm.url, vision });
  try {
    const base = groupMessage({ text: '看这个', messageId: 9502 });
    base.message.splice(1, 0, { type: 'image', data: { url: img.url } });
    env.server.push(base);

    const call = await env.server.waitForApi('send_group_msg');
    assert.equal(call.params.message, '我没看到图呀');
    const msgs = llm.chatRequests()[0].body.messages;
    const last = msgs[msgs.length - 1];
    assert.equal(typeof last.content, 'string', '取不到图时应退回纯文本，不能挂一个空图片数组');
    assert.ok(vision.stats().errors >= 1);
  } finally {
    await env.teardown();
    await img.close();
    await llm.close();
  }
});

test('e2e：纯文字消息不会触发任何图片下载', async () => {
  const llm = await startMockLlm();
  llm.replies = ['嗯嗯'];
  const img = await startImageServer();
  const vision = new ImageFetcher(deepMerge(DEFAULTS, {}).vision);
  const env = await setup({ llmUrl: llm.url, vision });
  try {
    env.server.push(groupMessage({ text: '在吗', messageId: 9503 }));
    await env.server.waitForApi('send_group_msg');
    assert.equal(img.hits, 0);
  } finally {
    await env.teardown();
    await img.close();
    await llm.close();
  }
});

test('e2e：不装 vision 时行为与从前完全一致（老部署不受影响）', async () => {
  const llm = await startMockLlm();
  llm.replies = ['在的'];
  const env = await setup({ llmUrl: llm.url });
  try {
    env.server.push(groupMessage({ text: '在吗', messageId: 9504 }));
    const call = await env.server.waitForApi('send_group_msg');
    assert.equal(call.params.message, '在的');
    const last = llm.chatRequests()[0].body.messages.at(-1);
    assert.equal(typeof last.content, 'string');
  } finally {
    await env.teardown();
    await llm.close();
  }
});

// ---------------------------------------------------------------------------
// 控制台：感知与记忆接口
// ---------------------------------------------------------------------------

test('控制台：status 带感知/记忆信息，记忆可列可搜可增可删', async () => {
  const llm = await startMockLlm();
  const awareness = await readyAwareness();
  const env = await setup({ llmUrl: llm.url, awareness });
  const memory = new MemoryManager({ cfg: env.cfg, store: env.store, llm: { chat: async () => ({ text: '{}' }) } });
  const ctl = createControlServer({
    cfg: env.cfg,
    bot: env.bot,
    store: env.store,
    awareness,
    memory,
    llmTest: async (p) => chatCompletion(env.cfg.llm, [{ role: 'user', content: p }]),
  });
  await waitFor(() => ctl.listening);
  const base = `http://127.0.0.1:${ctl.address().port}`;
  const get = async (p, method = 'GET') => {
    const r = await fetch(`${base}${p}`, { method });
    return { status: r.status, body: await r.json() };
  };
  try {
    // status 里能看到"现在几点""什么天气"
    const s = await get('/api/status');
    assert.equal(s.status, 200);
    assert.equal(s.body.awareness.enabled, true);
    assert.equal(s.body.awareness.location, '杭州');
    assert.match(s.body.awareness.weather, /杭州 现在 23\.8°C/);
    assert.match(s.body.awareness.now, /^现在是 /);
    assert.equal(s.body.memory.recall, true);

    // 空的时候是 0 条
    let list = await get('/api/memories?scope=group&id=555');
    assert.equal(list.body.total, 0);
    assert.deepEqual(list.body.memories, []);

    // 手动加两条
    const added = await get('/api/memories?scope=group&id=555&text=开拓者最近在学吉他&kind=event', 'POST');
    assert.equal(added.status, 200);
    assert.equal(added.body.updated, false);
    await get('/api/memories?scope=group&id=555&text=开拓者不吃香菜&kind=preference&subject=777', 'POST');

    list = await get('/api/memories?scope=group&id=555');
    assert.equal(list.body.total, 2);
    assert.equal(list.body.memories.length, 2);

    // 搜索走的是回复时的同一套逻辑：要多字重合才召回
    const search = await get('/api/memories/search?scope=group&id=555&q=他学吉他的时候手指痛&sender=777');
    assert.equal(search.body.count, 1);
    assert.match(search.body.memories[0].text, /吉他/);

    const miss = await get('/api/memories/search?scope=group&id=555&q=今天股市怎么样&sender=777');
    assert.equal(miss.body.count, 0);

    // 删掉一条
    const mid = added.body.id;
    const del = await get(`/api/memories?memory_id=${mid}`, 'DELETE');
    assert.equal(del.body.removed, true);
    list = await get('/api/memories?scope=group&id=555');
    assert.equal(list.body.total, 1);

    // 参数校验
    assert.equal((await get('/api/memories?scope=group')).status, 400);
    assert.equal((await get('/api/memories?scope=group&id=555', 'POST')).status, 400);
    assert.equal((await get('/api/memories?scope=group&id=555', 'DELETE')).status, 400);
    assert.equal((await get('/api/memories/search?scope=group&id=555')).status, 400);

    // 清理重复记忆：默认只预览，apply=1 才真的删
    await get('/api/memories?scope=group&id=555&text=开拓者不吃香菜，闻到就烦&kind=preference&subject=777', 'POST');
    await get('/api/memories?scope=group&id=555&text=开拓者不吃香菜&kind=preference&subject=777', 'POST');
    const before = (await get('/api/memories?scope=group&id=555')).body.total;

    const dry = await get('/api/memories/dedupe?scope=group&id=555', 'POST');
    assert.equal(dry.status, 200);
    assert.equal(dry.body.applied, false);
    assert.ok(dry.body.merged >= 1, '两条香菜记忆应该能被认出是同一件事');
    assert.equal((await get('/api/memories?scope=group&id=555')).body.total, before, '预览不能改库');

    const applied = await get('/api/memories/dedupe?scope=group&id=555&apply=1', 'POST');
    assert.equal(applied.body.applied, true);
    const after = (await get('/api/memories?scope=group&id=555')).body.total;
    assert.equal(after, before - applied.body.merged);
    // 幂等：再跑一次没有可合并的
    assert.equal((await get('/api/memories/dedupe?scope=group&id=555&apply=1', 'POST')).body.merged, 0);
    assert.equal((await get('/api/memories/dedupe?scope=group', 'POST')).status, 400);

    // 感知刷新接口
    const wr = await get('/api/weather-refresh', 'POST');
    assert.equal(wr.status, 200);
  } finally {
    await new Promise((r) => ctl.close(r));
    await env.teardown();
    await llm.close();
  }
});

// ---------------------------------------------------------------------------
// 说话风格：句号 → 换行（实测出来的自我强化回路）
// ---------------------------------------------------------------------------

test('tidySelfText：把句号换成换行，末尾不留空段', () => {
  // 用空格连接，不引入 " / " 这类新符号 —— 这段文本本身在给她示范怎么说话。
  assert.equal(tidySelfText('午好呀。刚回来，外面风挺凉的。'), '午好呀 刚回来，外面风挺凉的');
  // 本来就带换行的：换行保留，句号也换成换行
  assert.equal(tidySelfText('嗯，我在呢\n那就好。'), '嗯，我在呢 那就好');
  assert.ok(!tidySelfText('午好呀。刚回来。').includes('/'), '不能引入斜杠分隔符');
  // 空值/非字符串不能抛
  assert.equal(tidySelfText(''), '');
  assert.equal(tidySelfText(null), '');
  assert.equal(tidySelfText(undefined), '');
});

test('buildMessages：tidyAssistant 默认把 assistant 历史里的句号换成换行', () => {
  const history = [
    { role: 'user', sender: '阿澈', text: '在干嘛。' },
    { role: 'assistant', text: '刚回来。有点累。' },
    { role: 'user', sender: '阿澈', text: '辛苦了' },
  ];
  const on = buildMessages('SYS', history, { maxChars: 1000 });
  const a = on.find((m) => m.role === 'assistant');
  assert.equal(a.content, '刚回来\n有点累');
  // 对方说的话不能被改：那是他的原话，模型要看到真实的标点
  const u = on.find((m) => m.role === 'user' && String(m.content).startsWith('阿澈：在干嘛'));
  assert.equal(u.content, '阿澈：在干嘛。');

  // 关掉就完全保持旧行为（老部署/对比脚本靠这个）
  const off = buildMessages('SYS', history, { maxChars: 1000, tidyAssistant: false });
  assert.equal(off.find((m) => m.role === 'assistant').content, '刚回来。有点累。');
});

test('e2e：自身话清单也要清洗句号 —— 否则她照着自己旧句号继续写', async () => {
  const llm = await startMockLlm();
  // 带句号的回复（模拟早期版本留下的库文本）会被存进历史
  llm.replies = ['刚回来。有点累。'];
  const env = await setup({
    llmUrl: llm.url,
    cfgOverrides: {
      trigger: { private: { enabled: true, whitelist: ['888'] } },
      selfMemory: { enabled: true, turns: 8, limit: 8, maxChars: 400, maxItemChars: 60 },
    },
  });
  try {
    env.server.push(privateMessage({ text: '在干嘛', userId: '888' }));
    await waitFor(() => env.server.callsOf('send_private_msg').length === 1);
    await sleep(200);

    llm.replies = ['好呀'];
    env.server.push(privateMessage({ text: '好', userId: '888' }));
    await waitFor(() => env.server.callsOf('send_private_msg').length === 2);

    const second = llm.requests[1].body.messages[0].content;
    const idx = second.indexOf('你方才自己说过的话');
    assert.ok(idx > 0, '这一轮该带上自身话清单');
    const block = second.slice(idx, second.indexOf('\n\n', idx) === -1 ? undefined : idx + 400);
    // 清单条目里不能再出现句号
    assert.ok(!block.includes('刚回来。'), `自身话清单不该带句号：${block.slice(0, 160)}`);
    assert.ok(block.includes('刚回来'), '内容本身要在，只是标点换了');
  } finally {
    await env.teardown();
    await llm.close();
  }
});

test('控制台：/api/status 能看到最近几次回复的耗时构成', async () => {
  const llm = await startMockLlm();
  llm.replies = ['在的在的'];
  const env = await setup({
    llmUrl: llm.url,
    cfgOverrides: {
      // 关掉真实等待，只验记账
      typing: { enabled: false },
    },
  });
  const ctl = createControlServer({
    cfg: env.cfg,
    bot: env.bot,
    store: env.store,
    llmTest: async (p) => chatCompletion(env.cfg.llm, [{ role: 'user', content: p }]),
  });
  await waitFor(() => ctl.listening);
  const base = `http://127.0.0.1:${ctl.address().port}`;
  const get = async (p) => (await fetch(`${base}${p}`)).json();
  try {
    // 还没回过话：字段存在但是空的 —— 调用方不用判 undefined
    const before = await get('/api/status');
    assert.ok(Array.isArray(before.latency.recent));
    assert.equal(before.latency.recent.length, 0);
    assert.equal(before.latency.last, null);

    env.server.push(groupMessage({ text: '在吗' }));
    await env.server.waitForApi('send_group_msg');
    // waitFor 的 predicate 是同步判定 —— 别在这里传 async（Promise 恒为真，等于没等）。
    let last = null;
    for (let i = 0; i < 60; i += 1) {
      const s = await get('/api/status');
      if (s.latency.recent.length >= 1) {
        last = s.latency.last;
        break;
      }
      await sleep(50);
    }
    assert.ok(last, '回完话之后该有一条耗时记录');
    assert.ok(typeof last.modelMs === 'number', 'modelMs 是模型耗时');
    assert.ok(typeof last.thinkMs === 'number', 'thinkMs 是打字延迟');
    assert.ok(typeof last.chars === 'number');
    assert.ok(last.chars > 0);
    // typing.enabled=false → 程序侧等待为 0，全部耗时都在模型那边
    assert.equal(last.thinkMs, 0);
  } finally {
    await new Promise((r) => ctl.close(r));
    await env.teardown();
    await llm.close();
  }
});

