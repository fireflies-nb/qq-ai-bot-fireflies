import { logger } from './logger.js';

/** 调用 OpenAI 兼容的 /chat/completions 接口。 */
export async function chatCompletion(cfg, messages, { signal, temperature, maxTokens, responseFormat } = {}) {
  const url = `${String(cfg.baseUrl).replace(/\/+$/, '')}/chat/completions`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);
  const onAbort = () => controller.abort();
  signal?.addEventListener('abort', onAbort, { once: true });

  try {
    const body = {
      model: cfg.model,
      messages,
      temperature: temperature ?? cfg.temperature,
      max_tokens: maxTokens ?? cfg.maxTokens,
      stream: false,
    };
    // 抽取记忆这类"要机器可读结果"的调用才需要它，普通对话不加（会限制表达）。
    if (responseFormat) body.response_format = responseFormat;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${cfg.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`LLM HTTP ${res.status}：${body.slice(0, 300)}`);
    }

    const data = await res.json();
    const content = data?.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || !content.trim()) {
      throw new Error(`LLM 返回内容为空：${JSON.stringify(data).slice(0, 300)}`);
    }
    return {
      text: content.trim(),
      usage: data.usage ?? null,
      model: data.model ?? cfg.model,
    };
  } catch (err) {
    if (err.name === 'AbortError') throw new Error(`LLM 调用超时（${cfg.timeoutMs}ms）`);
    throw err;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

/**
 * 判断某个发言人是不是号主本人（也就是人设里的「开拓者」）。
 *
 * owner.qq 为空时恒为 false —— 这是刻意的安全默认：宁可对号主生分，
 * 也不要把群里的陌生人当成号主来亲近（人设里对开拓者的态度是很私密的）。
 */
export function isOwner(cfg, senderId) {
  const qq = String(cfg?.owner?.qq ?? '').trim();
  if (!qq) return false;
  return String(senderId ?? '') === qq;
}

/**
 * 构建人设 System Prompt。
 *
 * 两个来源，二选一：
 *  - persona.systemPromptFile 指向的文件读了内容（cfg.persona.systemPromptText）→ 整段作为人设主体，
 *    此时**不再**追加 description/style/rules。因为文件人设通常自带完整的性格、说话方式和行为准则，
 *    再叠加简版配置会互相打架（比如文件里是"扮演流萤"，简版里是"你就是号主本人"）。
 *  - 文件缺失/为空 → 退回 description/style/rules 简版。
 *
 * 人设之外再补一段「当前场景」，这是运行时才知道的事实，人设文件不该管：
 *  - 群里 + 号主：对开拓者，维持人设里的亲近
 *  - 群里 + 别人：普通群友，要拉开距离，不许用对开拓者的语气、不许提两人的私事
 *  - 私聊 + 号主：没有外人，允许她说多几句
 *  - 私聊 + 别人：陌生人，礼貌且有距离
 *
 * 【缓存约束 — 改这个函数前必读】
 * 实测 DeepSeek 的前缀缓存：同一段 system prompt 连发三次，第 2、3 次命中 91%
 * （cache_hit=2304 / cache_miss=232），成本差好几倍。命中要求**前缀逐字节相同**。
 * 所以「现在几点」「外面什么天气」「想起了哪几条记忆」这些每条消息都变的动态内容，
 * 一律追加在**最后**（见 environment / memories 的位置），绝不能插到人设前面。
 */
export function buildSystemPrompt(
  cfg,
  { isGroup, groupId, isOwner: owner = false, environment = [], memories = '', selfTexts = [] } = {},
) {
  const p = cfg.persona;
  const filePersona = String(p.systemPromptText ?? '').trim();
  const lines = [];
  if (filePersona) {
    lines.push(filePersona);
  } else {
    lines.push(p.description, p.style);
  }

  if (isGroup && owner) {
    lines.push(
      `当前场合：你正在 QQ 群（群号 ${groupId}）里，@ 你的人是你的「开拓者」——` +
        '他是这个 QQ 号的主人本人，也是你最在意的人。群里还有别人在说话，' +
        '但只回应 @ 你的开拓者，不要回应其他人的历史发言。',
    );
    lines.push('群聊里人多眼杂，回复要短，一句话最好，不要刷屏。');
  } else if (isGroup) {
    lines.push(
      `当前场合：你正在 QQ 群（群号 ${groupId}）里被一位群友 @ 到。` +
        '这个人是群里的普通成员，**不是开拓者**，你也不认识他。',
    );
    lines.push(
      '对待他的方式：保持你一贯的温和有礼，但要守住分寸——像对待一位路上遇到的旅人，' +
        '友善、客气、话不多。不要用你对开拓者那种亲近、依恋或撒娇的语气，' +
        '不要称他为"开拓者"，也不要提起你和开拓者之间的事（匹诺康尼、萨姆、星核猎手、你的病）。',
    );
    lines.push('只回应当前 @ 你的这一个人，不要回应群里其他人。回复一两句就够。');
  } else if (owner) {
    lines.push(
      '当前场合：你正在和你的「开拓者」私聊——他是你最在意的人，也是这个 QQ 号的主人。' +
        '这里没有外人。',
    );
    lines.push(
      '私聊里可以放松一些，语气更亲近、更温柔，可以问问他最近怎么样、也可以主动讲讲你自己的想法。' +
        '但"亲近"不等于"话多"：这里的分寸是**短句、一次只讲一件事**，想说的多就分成几条短的发，' +
        '而不是把一段话写长。',
    );
  } else {
    lines.push('当前场合：你正在和一个不认识的人私聊。这个人不是开拓者。');
    lines.push('保持礼貌和距离，不要透露你和开拓者的事，也不要表现得亲近。回复简短即可。');
  }

  if (!filePersona && Array.isArray(p.rules) && p.rules.length) {
    lines.push('硬性要求：');
    for (const r of p.rules) lines.push(`- ${r}`);
  }

  // ---- 动态内容从这里开始，必须排在人设之后（前缀缓存） ----
  if (Array.isArray(environment) && environment.length) {
    lines.push('', '你此刻的感知（真实信息，可以自然地说到）：');
    for (const e of environment) lines.push(`- ${e}`);
  }

  if (memories) {
    lines.push(
      '',
      '你记得关于对方的事：',
      String(memories),
      // 这段话是实测逼出来的：如果写成"请根据这些记忆回答"，模型会变成复读机，
      // 每句话都把记得的事念一遍，比没人设还假。
      '以上是背景，不是台词。像人一样：想得起来就自然带一句，想不起来就别硬提，' +
        '更不要罗列、不要复述、不要说"根据我的记忆"。对方这次说的事和记忆无关时，就当它不存在。',
    );
  }

  if (Array.isArray(selfTexts) && selfTexts.length) {
    lines.push(
      '',
      '你方才自己说过的话（这只是提醒，不是要你复述）：',
      ...selfTexts.map((t) => `- ${t}`),
      // 这条是实测逼出来的：她连发的几条气泡在模型眼里是合并后的一条 assistant，
      // 一旦滑出窗口就完全不知道"我刚才答应过什么"，于是把同一件事又郑重答应一遍。
      // 写法上刻意强调"说过就别再说"，而不是"请保持一致"——后者太软，模型不当回事。
      '对方已经听过这些话了：**同一件事不要重复说、不要再答应一遍**，也不要和它们互相矛盾。' +
        '你如果确实还要接着讲同一件事，就往下讲新的内容，或者干脆换一件事说。' +
        '这些内容不要念出来、不要罗列、不要说"我刚才说过"。',
    );
  }

  lines.push(
    filePersona
      ? '输出要求：只输出你要发出去的消息正文。不要「」『』书名号，不要星号、括号动作描写，不要 markdown，不要 emoji，不要任何前缀或解释。'
      : '只输出你要发出去的消息正文，不要任何前缀、引号、解释或多余格式。',
  );
  return lines.join('\n');
}

/**
 * 看图的注意事项。附在图片同一条 user 消息里，而不是塞进 system prompt：
 *  1) 离图片最近，模型最当回事；
 *  2) system prompt 保持逐字节不变，前缀缓存不会被"这条有没有图"打散。
 *
 * 这段话是被实测逼出来的：给一张**全黑、根本没有字**的图，模型一本正经地读出了
 * 「VANS」「FRI 14」。看不清却硬猜，比直接说看不见更糟——人看不出它在编。
 */
export const VISION_HINT =
  '（图片已经附在下面，用你的眼睛看。看得清就自然回应；' +
  '如果画面模糊、字太小看不清、或者你其实拿不准，就老实说看不清，千万不要猜、不要编。）';

/**
 * 把「她自己说过的话」整理成不示范句号的样子。
 *
 * 为什么要做这件事（实测数据）：
 *   同一个提问，给空历史 → 平均 2 个句号；给真实历史（她自己以前的回复带句号）→ 平均 3 个；
 *   把她历史里的句号换掉 → 句号 0 个。
 * 也就是说，**她自己的历史是最强的风格范例**，比人设里写十条"不要打句号"都管用。
 * 历史里那些句号是早期版本的遗留，不能继续拿来当榜样。
 *
 * 段与段之间用空格连接，**不用 " / " 之类的分隔符**：这段文本本身就是在给她示范
 * 该怎么说话，塞进去一个新符号，她下一轮就会照着用。
 */
export function tidySelfText(text) {
  return String(text ?? '')
    .replace(/。/g, '\n')
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
    .join(' ');
}

/**
 * 把存储的会话历史转成 messages 数组。
 * 群聊里别人的历史发言统一标成 user 并带昵称，模型才知道谁在说话。
 *
 * images：data URL 数组，只会挂到**最后一条 user 消息**（也就是刚发的这条）上。
 * 历史里的图片不重复携带 —— 否则每轮都要为老图片再付一次 token，很快就烧光。
 *
 * tidyAssistant：把 assistant 历史里的句号换成换行。理由是实测出来的（见 tidySelfText）：
 * 模型会模仿历史里自己的文体，历史带句号 → 新回复也带句号，形成自我强化。
 */
export function buildMessages(
  systemPrompt,
  history,
  { maxChars = 1500, images = [], tidyAssistant = true } = {},
) {
  const out = [{ role: 'system', content: systemPrompt }];
  const picked = [];
  let budget = maxChars;
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const h = history[i];
    const isAssistant = h.role === 'assistant';
    const label = isAssistant ? null : h.sender || h.senderId;
    let body = String(h.text ?? '');
    // 历史里的换行是"气泡边界"，模型看到的应该是它自己的分段方式，保留。
    // 末尾那个换行要去掉：句号在队尾时会被替换成孤立换行，纯粹是噪声 token。
    if (isAssistant && tidyAssistant) body = body.replace(/。/g, '\n').replace(/\s+$/, '');
    const content = label ? `${label}：${body}` : body;
    if (content.length > budget && picked.length > 0) break;
    budget -= content.length;
    picked.unshift({ role: isAssistant ? 'assistant' : 'user', content });
  }
  // 模型要求首条非 system 消息尽量是 user 且 user/assistant 交替；这里做一次宽松归一
  const normalized = [];
  let lastRole = null;
  for (const m of picked) {
    if (m.role === lastRole && m.role === 'assistant') {
      // 两条连续 assistant（我们连发多条）→ 合并
      normalized[normalized.length - 1].content += `\n${m.content}`;
      continue;
    }
    normalized.push({ ...m });
    lastRole = m.role;
  }
  const trimmed = normalized[0]?.role === 'assistant' ? normalized.slice(1) : normalized;
  const list = trimmed.length ? trimmed : [{ role: 'user', content: '（无上下文）' }];

  // 图片挂到最后一条 user 消息上：那是"刚发的这条"。
  // 找不到 user 消息（理论上不会）就补一条，否则图片挂不上去、模型看不到。
  if (Array.isArray(images) && images.length) {
    const pick = (m, extraText) => ({
      role: 'user',
      content: [
        { type: 'text', text: `${m?.content ?? ''}\n${extraText}`.trim() },
        ...images.map((url) => ({ type: 'image_url', image_url: { url } })),
      ],
    });
    let at = -1;
    for (let i = list.length - 1; i >= 0; i -= 1) {
      if (list[i].role === 'user') {
        at = i;
        break;
      }
    }
    if (at >= 0) list[at] = pick(list[at], VISION_HINT);
    else list.push(pick(null, VISION_HINT));
  }

  return out.concat(list);
}

/** 判断 LLM 配置是否可用于真实请求。 */
export function llmReady(cfg) {
  return Boolean(cfg.apiKey && cfg.baseUrl && cfg.model);
}

/**
 * 把 chatCompletion 包成对象形式，方便注入（记忆抽取器只关心"给我 messages 和参数，还我文本"）。
 * 抽出来是为了让 MemoryManager 不直接依赖 cfg 结构，测试里可以塞一个假的。
 */
export function createLlmClient(cfg) {
  return {
    chat: (messages, opts = {}) => chatCompletion(cfg, messages, opts),
  };
}

export { logger };
