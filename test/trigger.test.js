import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULTS, deepMerge, validateConfig } from '../src/config.js';
import { checkSafety, decideTrigger, inQuietHours } from '../src/trigger.js';

const SELF = '10001';
function cfg(overrides = {}) {
  return deepMerge(DEFAULTS, overrides);
}
function groupEvt(extra = {}) {
  return { messageType: 'group', groupId: '555', userId: '777', promptText: '你好', atSelf: true, ...extra };
}
function privateEvt(extra = {}) {
  return { messageType: 'private', userId: '777', promptText: '你好', ...extra };
}

test('群聊：@ 机器人时触发', () => {
  const d = decideTrigger(groupEvt(), cfg(), SELF);
  assert.equal(d.trigger, true);
  assert.equal(d.reason, 'group_at');
});

test('群聊：没 @ 时不触发', () => {
  const d = decideTrigger(groupEvt({ atSelf: false }), cfg(), SELF);
  assert.equal(d.trigger, false);
  assert.equal(d.reason, 'not_at_self');
});

test('群聊：黑名单群不触发', () => {
  const d = decideTrigger(groupEvt(), cfg({ trigger: { group: { blacklist: ['555'] } } }), SELF);
  assert.equal(d.reason, 'group_blacklisted');
});

test('群聊：白名单非空时，只有白名单群触发', () => {
  const c = cfg({ trigger: { group: { whitelist: ['999'] } } });
  assert.equal(decideTrigger(groupEvt(), c, SELF).reason, 'group_not_whitelisted');
  assert.equal(decideTrigger(groupEvt({ groupId: '999' }), c, SELF).trigger, true);
});

test('群聊：关闭群聊功能后不触发', () => {
  const d = decideTrigger(groupEvt(), cfg({ trigger: { group: { enabled: false } } }), SELF);
  assert.equal(d.reason, 'group_disabled');
});

test('私聊：默认关闭', () => {
  const d = decideTrigger(privateEvt(), cfg(), SELF);
  assert.equal(d.reason, 'private_disabled');
});

test('私聊：开启且白名单为空 → 所有人可触发', () => {
  const d = decideTrigger(privateEvt(), cfg({ trigger: { private: { enabled: true } } }), SELF);
  assert.equal(d.trigger, true);
});

test('私聊：白名单限制生效', () => {
  const c = cfg({ trigger: { private: { enabled: true, whitelist: ['888'] } } });
  assert.equal(decideTrigger(privateEvt(), c, SELF).reason, 'user_not_whitelisted');
  assert.equal(decideTrigger(privateEvt({ userId: '888' }), c, SELF).trigger, true);
});

test('白名单：QQ 号写成 JSON 数字也要能匹配（不能静默失效）', () => {
  // 用户很自然会在 config.json 里写 "whitelist": [2000000001]（数字而非字符串）。
  // 若用 includes 严格比较，名单里的数字匹不上事件里的字符串 —— 表现是"配了却不生效"。
  const c = cfg({ trigger: { private: { enabled: true, whitelist: [2000000001] } } });
  assert.equal(decideTrigger(privateEvt({ userId: '2000000001' }), c, SELF).trigger, true);
  assert.equal(decideTrigger(privateEvt({ userId: 2000000001 }), c, SELF).trigger, true);
  assert.equal(decideTrigger(privateEvt({ userId: '2000000002' }), c, SELF).reason, 'user_not_whitelisted');

  // 群白名单与群黑名单同理
  const g = cfg({ trigger: { group: { whitelist: [555] } } });
  assert.equal(decideTrigger(groupEvt({ groupId: '555' }), g, SELF).trigger, true);
  const b = cfg({ trigger: { group: { blacklist: [555] } } });
  assert.equal(decideTrigger(groupEvt({ groupId: '555' }), b, SELF).reason, 'group_blacklisted');
});

test('自己发的消息永不触发', () => {
  const d = decideTrigger(groupEvt({ userId: SELF }), cfg(), SELF);
  assert.equal(d.reason, 'self_message');
  assert.equal(d.self, true);
});

test('手动接管期间不触发', () => {
  const d = decideTrigger(groupEvt(), cfg(), SELF, { isTakeover: true });
  assert.equal(d.reason, 'manual_takeover');
});

test('inQuietHours：不跨零点的区间', () => {
  const c = cfg({ quietHours: { enabled: true, start: '09:00', end: '18:00' } });
  assert.equal(inQuietHours(c, new Date('2026-10-13T10:00:00')), true);
  assert.equal(inQuietHours(c, new Date('2026-10-13T20:00:00')), false);
  assert.equal(inQuietHours(c, new Date('2026-10-13T09:00:00')), true);
  assert.equal(inQuietHours(c, new Date('2026-10-13T18:00:00')), false);
});

test('inQuietHours：跨零点的区间', () => {
  const c = cfg({ quietHours: { enabled: true, start: '23:30', end: '07:30' } });
  assert.equal(inQuietHours(c, new Date('2026-10-13T23:45:00')), true);
  assert.equal(inQuietHours(c, new Date('2026-10-13T02:00:00')), true);
  assert.equal(inQuietHours(c, new Date('2026-10-13T12:00:00')), false);
});

test('inQuietHours：未启用时恒为 false', () => {
  assert.equal(inQuietHours(cfg(), new Date('2026-10-13T23:45:00')), false);
});

test('checkSafety：命中敏感词', () => {
  const s = checkSafety('帮我转账', cfg());
  assert.equal(s.blocked, true);
  assert.equal(s.keyword, '转账');
});

test('checkSafety：正常内容放行', () => {
  assert.equal(checkSafety('今天天气不错', cfg()).blocked, false);
});

test('validateConfig：私聊开启但白名单为空 → 给出警告', () => {
  const { warnings } = validateConfig(cfg({ trigger: { private: { enabled: true } } }));
  assert.ok(warnings.some((w) => w.includes('白名单为空')));
});

test('validateConfig：非法 wsUrl 报错', () => {
  const { errors } = validateConfig(cfg({ onebot: { wsUrl: 'http://x' } }));
  assert.ok(errors.some((e) => e.includes('ws://')));
});

test('deepMerge：局部覆盖不影响其他字段', () => {
  const merged = deepMerge(DEFAULTS, { llm: { model: 'deepseek-reasoner' } });
  assert.equal(merged.llm.model, 'deepseek-reasoner');
  assert.equal(merged.llm.baseUrl, DEFAULTS.llm.baseUrl);
  assert.equal(merged.trigger.group.requireAt, true);
});

// 回归测试：数组曾与 DEFAULTS 共享引用，控制台 push 白名单会永久污染全局默认值。
test('deepMerge：数组必须深拷贝，改结果不污染 DEFAULTS', () => {
  const a = deepMerge(DEFAULTS, {});
  a.trigger.group.whitelist.push('555');
  a.persona.rules.push('被污染的规则');
  assert.deepEqual(DEFAULTS.trigger.group.whitelist, []);
  assert.equal(DEFAULTS.persona.rules.length, 7);

  const b = deepMerge(DEFAULTS, { trigger: { group: { enabled: true } } });
  assert.deepEqual(b.trigger.group.whitelist, []);
  assert.notEqual(b.trigger.group.whitelist, DEFAULTS.trigger.group.whitelist);
  assert.notEqual(b.persona.rules, DEFAULTS.persona.rules);
});

test('deepMerge：显式传入的数组会被复制而非直接引用', () => {
  const src = ['123'];
  const merged = deepMerge(DEFAULTS, { trigger: { group: { whitelist: src } } });
  merged.trigger.group.whitelist.push('456');
  assert.deepEqual(src, ['123'], '不应改动调用方传进来的数组');
  assert.deepEqual(merged.trigger.group.whitelist, ['123', '456']);
});
