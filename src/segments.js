/** OneBot 11 消息段处理。 */

const PLACEHOLDER = {
  image: '[图片]',
  face: '[表情]',
  record: '[语音]',
  video: '[视频]',
  file: '[文件]',
  json: '[卡片]',
  xml: '[卡片]',
  music: '[音乐]',
  forward: '[合并转发]',
  mface: '[表情]',
  poke: '[戳一戳]',
  dice: '[骰子]',
  rps: '[猜拳]',
};

/** 把消息段数组（或 CQ 字符串）转成纯文本，供模型阅读。 */
export function segmentsToText(message) {
  if (typeof message === 'string') return message.trim();
  if (!Array.isArray(message)) return '';
  const parts = [];
  for (const seg of message) {
    const type = seg?.type;
    const data = seg?.data ?? {};
    if (type === 'text') {
      parts.push(String(data.text ?? ''));
    } else if (type === 'at') {
      const qq = String(data.qq ?? '');
      if (qq === 'all') parts.push('@全体成员');
      else parts.push(`@${data.name ?? qq}`);
    } else if (type === 'reply') {
      // 引用段本身不产生文本
    } else if (PLACEHOLDER[type]) {
      parts.push(PLACEHOLDER[type]);
    }
  }
  return parts.join('').replace(/\s+/g, ' ').trim();
}

/**
 * 抽出消息里的图片地址，供多模态模型使用。
 *
 * NapCat 的 image 段里 `url` 是可直接下载的地址（`data.file` 有时也是地址，
 * 开了 enableLocalFile2Url 则可能是本地路径）。这里只负责把候选收集起来，
 * 具体能不能用、要不要下载，交给 vision.js 判断。
 */
export function imageUrls(message) {
  if (!Array.isArray(message)) return [];
  const out = [];
  for (const seg of message) {
    if (seg?.type !== 'image') continue;
    const data = seg?.data ?? {};
    for (const key of ['url', 'file']) {
      const v = String(data[key] ?? '').trim();
      if (v && !out.includes(v)) {
        out.push(v);
        break;
      }
    }
  }
  return out;
}

/** 是否 @ 了指定 QQ 号（含 @全体成员）。 */
export function isAt(message, selfId) {
  if (!Array.isArray(message)) return false;
  const self = String(selfId ?? '');
  return message.some((seg) => {
    if (seg?.type !== 'at') return false;
    const qq = String(seg?.data?.qq ?? '');
    return qq === 'all' || (self !== '' && qq === self);
  });
}

/** 去掉 @机器人 的片段，得到"真正想问什么"。 */
export function stripAt(message, selfId) {
  if (!Array.isArray(message)) return segmentsToText(message);
  const self = String(selfId ?? '');
  const filtered = message.filter(
    (seg) => !(seg?.type === 'at' && String(seg?.data?.qq ?? '') === self),
  );
  return segmentsToText(filtered);
}

/** 构造一个纯文本消息段。 */
export function textSeg(text) {
  return { type: 'text', data: { text: String(text) } };
}

/**
 * 把一段长回复切成多条短消息，模仿真人打字节奏。
 * 优先在句末标点处断句，其次在逗号处，最后硬切。
 */
export function splitReply(text, { maxLength = 90, maxSegments = 3, bubbleOnNewline = true } = {}) {
  const cleaned = String(text ?? '').trim();
  if (!cleaned) return [];
  if (cleaned.length <= maxLength && !cleaned.includes('\n')) return [cleaned];

  // 换行优先：模型用换行表示"这是下一条消息"，人设也是这么教的。
  // 以前这里把换行抹成空格，等于逼它改用句号来分段 —— 那正是"像 AI"的来源之一。
  const lines = bubbleOnNewline
    ? cleaned.split(/\n+/).map((s) => s.trim()).filter(Boolean)
    : [cleaned.replace(/\n+/g, ' ')];

  const chunks = [];
  for (const line of lines) {
    if (chunks.length >= maxSegments) {
      // 超出 maxSegments 的余量合并进最后一条，避免丢内容
      chunks[chunks.length - 1] = `${chunks[chunks.length - 1]} ${line}`.trim();
      continue;
    }
    if (line.length <= maxLength) {
      chunks.push(line);
      continue;
    }
    // 单行本身还是太长（模型一口气写长了）→ 退回按标点切
    for (const piece of splitByPunctuation(line, maxLength)) {
      if (chunks.length >= maxSegments) chunks[chunks.length - 1] = `${chunks[chunks.length - 1]}${piece}`;
      else chunks.push(piece);
    }
  }
  return chunks.filter(Boolean);
}

/**
 * 按标点在 maxLength 附近切分（splitReply 的内部实现）。
 * 找不到标点就硬切 —— 宁可切得难看，也不能把内容丢了。
 */
function splitByPunctuation(text, maxLength) {
  const chunks = [];
  let rest = String(text ?? '').trim();
  while (rest) {
    if (rest.length <= maxLength) {
      chunks.push(rest);
      break;
    }
    const window = rest.slice(0, maxLength + 10);
    let cut = -1;
    for (const re of [/[。！？!?…~]/g, /[，,、；;]/g]) {
      let m;
      let last = -1;
      while ((m = re.exec(window)) !== null) {
        if (m.index > 0 && m.index <= maxLength) last = m.index + m[0].length;
      }
      if (last > 0) {
        cut = last;
        break;
      }
    }
    if (cut <= 0) cut = maxLength;
    chunks.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  return chunks.filter(Boolean);
}
