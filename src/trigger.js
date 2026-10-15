/** 决定一条消息该不该触发 AI 回复。纯函数，方便单测。 */

/** 白名单比较：统一按字符串比。用户在 JSON 里把 QQ 号写成数字(2000000001)是常事，
 *  若用 includes 严格比较会静默失效（名单里 [2000000001] 匹不上 '2000000001'）。 */
export function inList(list, value) {
  if (!Array.isArray(list)) return false;
  const v = String(value ?? '');
  return list.some((x) => String(x ?? '') === v);
}

/**
 * @returns {{trigger: boolean, reason: string, self: boolean, text: string}}
 */
export function decideTrigger(evt, cfg, selfId, { isTakeover = false } = {}) {
  const self = String(selfId ?? '');
  const isGroup = evt.messageType === 'group';
  const senderId = String(evt.userId ?? '');

  if (!isGroup && evt.messageType !== 'private') {
    return { trigger: false, reason: 'unsupported_message_type', self: false, text: '' };
  }
  if (self && senderId === self) {
    return { trigger: false, reason: 'self_message', self: true, text: '' };
  }
  if (isTakeover) {
    return { trigger: false, reason: 'manual_takeover', self: false, text: '' };
  }

  if (isGroup) {
    const g = cfg.trigger.group;
    if (!g.enabled) return { trigger: false, reason: 'group_disabled', self: false, text: '' };
    const gid = String(evt.groupId ?? '');
    if (inList(g.blacklist, gid)) return { trigger: false, reason: 'group_blacklisted', self: false, text: '' };
    if (g.whitelist?.length && !inList(g.whitelist, gid))
      return { trigger: false, reason: 'group_not_whitelisted', self: false, text: '' };
    if (g.requireAt && !evt.atSelf) return { trigger: false, reason: 'not_at_self', self: false, text: '' };
    return { trigger: true, reason: 'group_at', self: false, text: evt.promptText ?? '' };
  }

  const p = cfg.trigger.private;
  if (!p.enabled) return { trigger: false, reason: 'private_disabled', self: false, text: '' };
  if (p.whitelist?.length && !inList(p.whitelist, senderId))
    return { trigger: false, reason: 'user_not_whitelisted', self: false, text: '' };
  return { trigger: true, reason: 'private_message', self: false, text: evt.promptText ?? '' };
}

/** 静默时段判断，支持跨零点。 */
export function inQuietHours(cfg, now = new Date()) {
  const q = cfg.quietHours;
  if (!q?.enabled) return false;
  const toMin = (s) => {
    const [h, m] = String(s).split(':').map(Number);
    return h * 60 + m;
  };
  const start = toMin(q.start);
  const end = toMin(q.end);
  const cur = now.getHours() * 60 + now.getMinutes();
  if (start === end) return false;
  if (start < end) return cur >= start && cur < end;
  return cur >= start || cur < end; // 跨零点
}

/** 安全兜底：命中敏感词就不调模型。 */
export function checkSafety(text, cfg) {
  const kws = cfg.safety?.blockedKeywords ?? [];
  const hit = kws.find((k) => text.includes(k));
  if (hit) return { blocked: true, reply: cfg.safety.blockedReply, keyword: hit };
  return { blocked: false };
}

/** @deprecated 用 inList：这个旧名字只做数字/字符串归一后的包含判断，保留仅为兼容。 */
export function matchesList(list, value) {
  return inList(list, value);
}
