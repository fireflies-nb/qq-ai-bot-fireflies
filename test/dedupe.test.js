import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'qqbot-dedupe-'));

const {
  clusterMemories,
  isSameMemory,
  numberDiffers,
  pickDistinct,
  polarityDiffers,
  similarity,
  substitutionDiffers,
} = await import('../src/textsim.js');
const { Store } = await import('../src/store.js');
const { MemoryManager } = await import('../src/memory.js');
const { DEFAULTS, deepMerge } = await import('../src/config.js');

let seq = 0;
function makeStore() {
  seq += 1;
  return new Store(path.join(tmpRoot, `d-${seq}-${Date.now()}.db`), { retentionDays: 1 });
}

function makeMgr({ store = makeStore(), cfgOverrides = {}, llm = null } = {}) {
  const cfg = deepMerge(DEFAULTS, cfgOverrides);
  return { mgr: new MemoryManager({ cfg, store, llm }), store, cfg };
}

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
// 必须拒绝：合并了就是信息损坏（比漏合并严重得多）
// ---------------------------------------------------------------------------

const REJECT = [
  ['阿澈养了一只猫', '阿澈养了一只狗'],
  ['阿澈的生日是三月', '阿澈的生日是八月'],
  ['阿澈喜欢流萤', '阿澈不喜欢流萤'],
  ['阿澈不吃香菜', '阿澈不吃辣'],
  ['阿澈在工作', '阿澈不在工作'],
  ['阿澈打算去北京', '阿澈打算去南京'],
  ['阿澈在下午三点四十下课', '阿澈在下午四点四十下课'],
  ['阿澈喜欢被催着去睡觉', '阿澈不喜欢被催着去睡觉'],
  ['阿澈昨晚熬夜到两点', '阿澈昨晚熬夜到三点'],
  ['阿澈买了一本书', '阿澈买了两本书'],
  ['阿澈喜欢狗', '阿澈的狗叫旺财'],
  ['阿澈问流萤要不要一起吃饭', '流萤问阿澈要不要一起吃饭'],
];

test('isSameMemory：这 12 对必须判为不同（合并了就是把两个事实永久变成一个）', () => {
  for (const [a, b] of REJECT) {
    const r = isSameMemory(a, b);
    assert.equal(r.same, false, `不该合并：「${a}」 vs 「${b}」（reason=${r.reason} shared=${r.metrics.shared} jac=${r.metrics.jaccard.toFixed(2)}）`);
  }
});

test('isSameMemory：光看 Jaccard 会误判 —— "猫/狗"的相似度比真重复对还高', () => {
  const bad = similarity('阿澈养了一只猫', '阿澈养了一只狗');
  const good = similarity('阿澈下午三点四十下课', '阿澈在下午三点四十下课');
  assert.ok(bad.jaccard >= good.jaccard - 0.05, `坏对(${bad.jaccard.toFixed(2)}) 不该比好对(${good.jaccard.toFixed(2)}) 低多少`);
  assert.equal(isSameMemory('阿澈养了一只猫', '阿澈养了一只狗').same, false);
  assert.equal(isSameMemory('阿澈下午三点四十下课', '阿澈在下午三点四十下课').same, true);
});

// ---------------------------------------------------------------------------
// 必须合并：漏了就白占名额
// ---------------------------------------------------------------------------

const MERGE = [
  ['阿澈下午三点四十下课', '阿澈在下午三点四十下课'],
  ['阿澈最近在学吉他', '阿澈最近在学吉他，手指都起茧了'],
  ['阿澈不吃香菜', '阿澈不吃香菜，闻到就难受'],
  ['阿澈五月去过重庆', '阿澈五月的时候去过重庆'],
  ['阿澈喜欢看星星', '阿澈喜欢看星星，尤其是晴天晚上'],
  ['阿澈在调试萤宝的参数', '阿澈正在调试萤宝的参数'],
  ['阿澈为流萤取名为"萤宝"，并表达爱意', '阿澈为流萤取名为"萤宝"'],
  ['阿澈喜欢吃牛肉汤面', '阿澈喜欢吃牛肉汤面，还提到要配橡木蛋糕卷'],
  ['流萤无法正常运行', '流萤就无法正常运行'],
  ['阿澈是个程序员', '阿澈是个程序员，写代码到很晚'],
];

test('isSameMemory：这 10 对必须判为同一件事（换了说法 / 多了个从句）', () => {
  for (const [a, b] of MERGE) {
    const r = isSameMemory(a, b);
    assert.equal(r.same, true, `该合并却没合并：「${a}」 vs 「${b}」（cont=${r.metrics.containment.toFixed(2)} jac=${r.metrics.jaccard.toFixed(2)} minSize=${r.metrics.minSize}）`);
  }
});

// ---------------------------------------------------------------------------
// 三道守卫各自的行为
// ---------------------------------------------------------------------------

test('polarityDiffers：修饰了共同内容的否定才算"极性不同"', () => {
  assert.equal(polarityDiffers('阿澈喜欢流萤', '阿澈不喜欢流萤'), true);
  assert.equal(polarityDiffers('阿澈在工作', '阿澈不在工作'), true);
  // 否定修饰的是另一条没提过的内容 → 不算极性不同（只是加了个从句）
  assert.equal(polarityDiffers('阿澈喜欢打游戏', '阿澈喜欢打游戏，但方向还不确定'), false);
  // 两边都有同一个否定 → 不算
  assert.equal(polarityDiffers('流萤无法运行', '流萤就无法运行'), false);
});

test('numberDiffers：数量词不一致就不是同一件事（"三点"和"四点"字面很像）', () => {
  assert.equal(numberDiffers('阿澈下午三点四十下课', '阿澈下午四点四十下课'), true);
  assert.equal(numberDiffers('阿澈生日是三月', '阿澈生日是八月'), true);
  assert.equal(numberDiffers('阿澈买了一本书', '阿澈买了两本书'), true);
  // 「这本书」里根本没有数量词 → 不算冲突（这条最初写错过：以为"一"在"这本书"里）
  assert.equal(numberDiffers('阿澈买了这本书', '阿澈买了两本书'), false);
  // 一边有数量、一边没有 → 不算冲突，否则正常改写会被挡掉
  assert.equal(numberDiffers('阿澈打算接入记忆功能', '阿澈打算接一个记忆功能'), false);
  // 同一个数字出现顺序不同 → 不算冲突
  assert.equal(numberDiffers('下午三点四十下课', '三点四十就下课了'), false);
});

test('substitutionDiffers：同长度、逐位只差一两个字的是"换了内容"，不是"换了说法"', () => {
  assert.equal(substitutionDiffers('阿澈养了一只猫', '阿澈养了一只狗'), true);
  assert.equal(substitutionDiffers('阿澈打算去北京', '阿澈打算去南京'), true);
  // 长度不同（加长版）不算替换
  assert.equal(substitutionDiffers('阿澈很累', '阿澈今天很累'), false);
  // 差太多字不算替换
  assert.equal(substitutionDiffers('阿澈喜欢看星星', '阿澈喜欢看大海和日落'), false);
});

test('substitutionDiffers：只差"了/过"这类虚词不算换了内容（真库实测的假阳性）', () => {
  // 这一对最初被判成两件事，导致重庆那件事清理完还剩 3 条变体。
  assert.equal(substitutionDiffers('阿澈在五月份去过重庆玩，并拍了照片', '阿澈在五月份去过重庆玩，并拍过照片。'), false);
  assert.equal(
    isSameMemory('阿澈在五月份去过重庆玩，并拍了照片', '阿澈在五月份去过重庆玩，并拍过照片。').same,
    true,
  );
  // 实词不同仍然要拦
  assert.equal(substitutionDiffers('阿澈养了一只猫', '阿澈养了一只狗'), true);
});

// ---------------------------------------------------------------------------
// 检索端：多样性去重（锚点式，不跨事实串联）
// ---------------------------------------------------------------------------

test('pickDistinct：同一件事的多个说法只留一条，不同的事各自保留', () => {
  const mems = [
    { id: 1, text: '阿澈称呼流萤为"萤宝"', hits: 9 },
    { id: 2, text: '阿澈称呼流萤为"萤宝"，并表达爱意', hits: 1 },
    { id: 3, text: '阿澈称呼流萤为"萤宝"，并说会慢慢治疗流萤', hits: 1 },
    { id: 4, text: '阿澈喜欢吃牛肉汤面', hits: 7 },
  ];
  const kept = pickDistinct(mems);
  assert.equal(kept.length, 2, `应只留 2 条，实际 ${kept.length}：${kept.map((m) => m.text).join(' | ')}`);
  assert.equal(kept[0].id, 1, '先来的那条留下');
  assert.equal(kept[1].id, 4);
});

test('pickDistinct：复合条目当代表时，被收走的事实必须还在它的正文里（不丢信息）', () => {
  // 真机数据上的实际案例：一条同时提到「萤宝」和「治疗」的复合记忆 #55
  // 跟 #1、#54 都相似。让它当代表没问题 —— 前提是 #55 的正文确实带了这两件事。
  const mems = [
    { id: 1, text: '阿澈称呼流萤为"萤宝"', hits: 9 },
    { id: 55, text: '阿澈称呼流萤为"萤宝"，并说会慢慢"治疗"流萤，想和流萤一起加油', hits: 1 },
    { id: 54, text: '阿澈表示会慢慢"治疗"流萤，想和她一起加油', hits: 1 },
  ];
  const kept = pickDistinct(mems);
  const joined = kept.map((m) => m.text).join(' | ');
  assert.match(joined, /萤宝/, '「称呼萤宝」这件事不能被丢掉');
  assert.match(joined, /治疗/, '「一起治疗」这件事不能被丢掉');
  assert.ok(kept.length <= 3);
});

test('clusterMemories：破坏性合并时不串联 —— 复合条目不会把两个不同事实并成一条删掉', () => {
  // 这是真正危险的那条路径（dedupeMemories 会删行），必须锚在 hits 最高的那条上，
  // 而 #1 和 #54 互相不同义 → 必须留在两个簇里。
  const clusters = clusterMemories([
    { id: 1, text: '阿澈称呼流萤为"萤宝"', hits: 9 },
    { id: 55, text: '阿澈称呼流萤为"萤宝"，并说会慢慢"治疗"流萤，想和流萤一起加油', hits: 1 },
    { id: 54, text: '阿澈表示会慢慢"治疗"流萤，想和她一起加油', hits: 1 },
  ]);
  const groups = clusters.filter((c) => c.members.length > 1);
  assert.equal(groups.length, 1, '只有 #1/#55 能合并');
  assert.equal(groups[0].anchor.id, 1, '锚点是 hits 最高的那个');
  const survivors = clusters.map((c) => c.anchor.id).sort((a, b) => a - b);
  assert.deepEqual(survivors, [1, 54], '两个事实都要留下一个代表');
});

test('clusterMemories：锚点取 hits 最高的那个说法', () => {
  const clusters = clusterMemories([
    { id: 61, text: '阿澈会调试流萤的参数', hits: 1 },
    { id: 63, text: '阿澈会调试流萤的参数，并称之为给流萤做体检', hits: 5 },
  ]);
  assert.equal(clusters.length, 1);
  assert.equal(clusters[0].anchor.id, 63, 'hits 高的当锚点');
  assert.equal(clusters[0].members.length, 2);
});

// ---------------------------------------------------------------------------
// 第②层：入库时的保守近似合并
// ---------------------------------------------------------------------------

test('addMemory：不传 merge 时保持老行为 —— 只有精确匹配才算同一条', () => {
  const store = makeStore();
  store.addMemory({ scope: 'group', scopeId: '555', subject: '777', text: '阿澈下午三点四十下课' });
  const r = store.addMemory({ scope: 'group', scopeId: '555', subject: '777', text: '阿澈在下午三点四十下课' });
  assert.equal(r.updated, false, '没开近似合并就该新增');
  assert.equal(store.countMemories('group', '555'), 2);
  store.close();
});

test('addMemory：开了 merge 后，换种说法的同一条只强化不新增', () => {
  const store = makeStore();
  const a = store.addMemory({ scope: 'group', scopeId: '555', subject: '777', text: '阿澈下午三点四十下课' });
  const b = store.addMemory(
    { scope: 'group', scopeId: '555', subject: '777', text: '阿澈在下午三点四十下课' },
    { merge: { enabled: true } },
  );
  assert.equal(b.updated, true, '该判为同一件事');
  assert.equal(b.id, a.id);
  assert.equal(b.similarTo, a.id);
  assert.equal(store.countMemories('group', '555'), 1);
  const [row] = store.listMemories('group', '555');
  assert.equal(row.hits, 2);
  assert.equal(row.text, '阿澈下午三点四十下课', '保留已有那条的文本，不用新说法覆盖');
  store.close();
});

test('addMemory：merge 只在同一 subject 内比较，不会把两个人的事并成一条', () => {
  const store = makeStore();
  store.addMemory({ scope: 'group', scopeId: '555', subject: '777', text: '阿澈下午三点四十下课' });
  const r = store.addMemory(
    { scope: 'group', scopeId: '555', subject: '888', text: '阿澈在下午三点四十下课' },
    { merge: { enabled: true } },
  );
  assert.equal(r.updated, false);
  assert.equal(store.countMemories('group', '555'), 2);
  store.close();
});

test('addMemory：merge 也不会把"猫"和"狗"并成一条', () => {
  const store = makeStore();
  store.addMemory({ scope: 'group', scopeId: '555', subject: '777', text: '阿澈养了一只猫' });
  const r = store.addMemory(
    { scope: 'group', scopeId: '555', subject: '777', text: '阿澈养了一只狗' },
    { merge: { enabled: true } },
  );
  assert.equal(r.updated, false, '这是两件事');
  assert.equal(store.countMemories('group', '555'), 2);
  store.close();
});

// ---------------------------------------------------------------------------
// 存量清理
// ---------------------------------------------------------------------------

test('dedupeMemories：dryRun 只报告不落库', () => {
  const store = makeStore();
  store.addMemory({ scope: 'group', scopeId: '555', subject: '777', text: '阿澈称呼流萤为"萤宝"' });
  store.addMemory({ scope: 'group', scopeId: '555', subject: '777', text: '阿澈称呼流萤为"萤宝"，并表达爱意' });
  const r = store.dedupeMemories('group', '555', { dryRun: true });
  assert.equal(r.total, 2);
  assert.equal(r.merged, 1);
  assert.equal(r.kept, 1);
  assert.equal(store.countMemories('group', '555'), 2, 'dryRun 不该真的删');
  store.close();
});

test('dedupeMemories：真合并时把 hits 累加到保留的那条，并删掉其余', () => {
  const store = makeStore();
  const a = store.addMemory({ scope: 'group', scopeId: '555', subject: '777', text: '阿澈称呼流萤为"萤宝"' });
  store.addMemory({ scope: 'group', scopeId: '555', subject: '777', text: '阿澈称呼流萤为"萤宝"，并表达爱意' });
  store.addMemory({ scope: 'group', scopeId: '555', subject: '777', text: '阿澈叫流萤"萤宝"' }); // 不该被并
  const r = store.dedupeMemories('group', '555');
  assert.equal(r.merged, 1);
  assert.equal(store.countMemories('group', '555'), 2);
  const rows = store.listMemories('group', '555');
  const anchor = rows.find((m) => m.id === a.id);
  assert.equal(anchor.hits, 2, '被合并的那条的 hits 要累加过来，不能丢');
  store.close();
});

test('dedupeMemories：不同 subject 之间绝不互相合并', () => {
  const store = makeStore();
  store.addMemory({ scope: 'group', scopeId: '555', subject: '777', text: '阿澈下午三点四十下课' });
  store.addMemory({ scope: 'group', scopeId: '555', subject: '888', text: '阿澈在下午三点四十下课' });
  const r = store.dedupeMemories('group', '555');
  assert.equal(r.merged, 0);
  assert.equal(store.countMemories('group', '555'), 2);
  store.close();
});

// ---------------------------------------------------------------------------
// 第③层：检索端
// ---------------------------------------------------------------------------

test('retrieve：命中同义变体时只留一条，不把 6 个名额浪费在同一件事上', () => {
  const { mgr, store } = makeMgr();
  store.addMemory({ scope: 'private', scopeId: '2000000001', subject: '2000000001', text: '阿澈称呼流萤为"萤宝"' });
  store.addMemory({ scope: 'private', scopeId: '2000000001', subject: '2000000001', text: '阿澈称呼流萤为"萤宝"，并表达爱意' });
  store.addMemory({ scope: 'private', scopeId: '2000000001', subject: '2000000001', text: '阿澈称呼流萤为"萤宝"，并说会慢慢治疗流萤' });
  const got = mgr.retrieve({
    scope: 'private',
    scopeId: '2000000001',
    text: '阿澈称呼流萤为萤宝',
    senderId: '2000000001',
  });
  assert.equal(got.length, 1, `应只召回 1 条，实际 ${got.length}：${got.map((m) => m.text).join(' | ')}`);
  store.close();
});

test('retrieve：dedupeOnRetrieve=false 时退回老行为（变体全给）', () => {
  const { mgr, store } = makeMgr({ cfgOverrides: { memory: { dedupeOnRetrieve: false, minScore: 1 } } });
  store.addMemory({ scope: 'private', scopeId: '2000000001', subject: '2000000001', text: '阿澈称呼流萤为"萤宝"' });
  store.addMemory({ scope: 'private', scopeId: '2000000001', subject: '2000000001', text: '阿澈称呼流萤为"萤宝"，并表达爱意' });
  const got = mgr.retrieve({ scope: 'private', scopeId: '2000000001', text: '萤宝', senderId: '2000000001' });
  assert.equal(got.length, 2);
  store.close();
});

test('retrieve：候选数要放大，否则去重后名额会不够用', () => {
  const { mgr, store } = makeMgr({ cfgOverrides: { memory: { recallLimit: 2, minScore: 1 } } });
  // 同一件事的 4 个说法把前排占满，后面才是另一件事
  for (const t of ['萤宝', '萤宝啊', '叫萤宝', '是"萤宝"']) {
    store.addMemory({ scope: 'p', scopeId: 'u', subject: 'u', text: `阿澈称呼流萤为${t}` });
  }
  store.addMemory({ scope: 'p', scopeId: 'u', subject: 'u', text: '阿澈的萤宝这个名字，流萤很喜欢' });
  const got = mgr.retrieve({ scope: 'p', scopeId: 'u', text: '萤宝名字', senderId: 'u' });
  assert.ok(got.length >= 1);
  for (const m of got) assert.match(m.text, /萤宝/);
  store.close();
});

// ---------------------------------------------------------------------------
// 第①层：抽取器带上「已有记忆」
// ---------------------------------------------------------------------------

test('extractAndStore：把「已经记住的事」喂给抽取器，让它别再换个说法重记', async () => {
  const llm = fakeLlm('{"memories":[]}');
  const { mgr, store } = makeMgr({ llm });
  store.addMemory({ scope: 'private', scopeId: 'u', subject: 'u', text: '阿澈不吃香菜，闻到就难受' });
  await mgr.extractAndStore({
    scope: 'private',
    scopeId: 'u',
    senderId: 'u',
    senderName: '阿澈',
    isOwner: true,
    history: [{ role: 'user', sender: '阿澈', senderId: 'u', text: '我不吃香菜' }],
  });
  const system = llm.calls[0].messages[0].content;
  assert.match(system, /已经记住的事/);
  assert.match(system, /阿澈不吃香菜，闻到就难受/, '已有记忆的正文要出现');
  assert.match(system, /再输出一条/, '要明确要求它别重复记');
  assert.match(system, /同一件事/);  store.close();
});

test('extractAndStore：dedupeExtract=false 时不带已知清单', async () => {
  const llm = fakeLlm('{"memories":[]}');
  const { mgr, store } = makeMgr({ llm, cfgOverrides: { memory: { dedupeExtract: false } } });
  store.addMemory({ scope: 'private', scopeId: 'u', subject: 'u', text: '阿澈不吃香菜' });
  await mgr.extractAndStore({
    scope: 'private',
    scopeId: 'u',
    senderId: 'u',
    senderName: '阿澈',
    history: [{ role: 'user', sender: '阿澈', senderId: 'u', text: '我不吃香菜' }],
  });
  const system = llm.calls[0].messages[0].content;
  assert.doesNotMatch(system, /已经记住的事/);
  store.close();
});

test('extractAndStore：已知清单为空时不加那一段（省 token）', async () => {
  const llm = fakeLlm('{"memories":[]}');
  const { mgr, store } = makeMgr({ llm });
  await mgr.extractAndStore({
    scope: 'private',
    scopeId: 'u',
    senderId: 'u',
    senderName: '阿澈',
    history: [{ role: 'user', sender: '阿澈', senderId: 'u', text: '你好' }],
  });
  assert.doesNotMatch(llm.calls[0].messages[0].content, /已经记住的事/);
  store.close();
});

test('extractAndStore：抽取器换个说法吐同一条 → 走近似合并记成「强化」而不是「新增」', async () => {
  const llm = fakeLlm('{"memories":[{"text":"阿澈在下午三点四十下课","kind":"fact","subject":"other"}]}');
  const { mgr, store } = makeMgr({ llm });
  store.addMemory({ scope: 'private', scopeId: 'u', subject: 'u', text: '阿澈下午三点四十下课' });
  const r = await mgr.extractAndStore({
    scope: 'private',
    scopeId: 'u',
    senderId: 'u',
    senderName: '阿澈',
    history: [{ role: 'user', sender: '阿澈', senderId: 'u', text: '我三点四十才下课' }],
  });
  assert.equal(r.stored, 0, '不该新增');
  assert.equal(r.updated, 1, '该记成强化');
  assert.equal(store.countMemories('private', 'u'), 1);
  store.close();
});

test('extractAndStore：确实的新信息照常入库（不能因为去重把新事也吞掉）', async () => {
  const llm = fakeLlm('{"memories":[{"text":"阿澈养了一只叫咪咪的猫","kind":"fact","subject":"other"}]}');
  const { mgr, store } = makeMgr({ llm });
  store.addMemory({ scope: 'private', scopeId: 'u', subject: 'u', text: '阿澈不吃香菜' });
  const r = await mgr.extractAndStore({
    scope: 'private',
    scopeId: 'u',
    senderId: 'u',
    senderName: '阿澈',
    history: [{ role: 'user', sender: '阿澈', senderId: 'u', text: '我养了只猫叫咪咪' }],
  });
  assert.equal(r.stored, 1);
  assert.equal(store.countMemories('private', 'u'), 2);
  store.close();
});
