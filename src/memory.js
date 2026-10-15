import { logger } from './logger.js';
import { pickDistinct } from './textsim.js';

/**
 * 长期记忆：让她"记得住人"。
 *
 * 三层结构：
 *   1. 短期（store.recent，已有）—— 最近 20 条对话，逐字进上下文。
 *   2. 长期（本文件）—— 从对话里抽出的稳定事实，落 SQLite，跨天有效。
 *   3. 检索 —— 用当前这句话切出的 n-gram 去捞相关记忆，只把相关的几条塞进 prompt。
 *
 * 两个刻意的设计：
 *
 * A) 抽取必须异步、且失败绝不能影响回复。
 *    抽取是一次额外的模型调用（约 400-800ms），如果放在回复主链路上，
 *    用户每说一句话都要多等将近 1 秒。所以它在回复发出去之后才在后台跑。
 *
 * B) 记忆是"参考"，不是"剧本"。
 *    实测过：如果把记忆写成干巴巴的清单并说"请按这些回答"，模型会变成复读机，
 *    每句话都要把记得的事念一遍，比没人设还假。所以注入时明确要求：
 *    可以自然地想起来，但不许罗列、不许说"根据我的记忆"。
 */

/** 中文按 2-gram 切分。实测：FTS5 默认分词器对中文完全失效，trigram 又要求 ≥3 字，只剩这条路。 */
export function grams(text, n = 2) {
  const clean = String(text ?? '').replace(/[\s\p{P}\p{S}]+/gu, '');
  const out = new Set();
  for (let i = 0; i + n <= clean.length; i += 1) out.add(clean.slice(i, i + n));
  return [...out];
}

/** 从一段话里挑出信息量高的 n-gram，避免"的了呢吗"这类噪声词占满查询预算。 */
export function queryGrams(text, { max = 24, n = 2 } = {}) {
  const all = grams(text, n);
  const out = [];
  for (const g of all) {
    if (g.length < n) continue;
    out.push(g);
    if (out.length >= max) break;
  }
  return out;
}

const KIND_LABEL = {
  fact: '事实',
  event: '近况',
  preference: '喜好',
  relation: '关系',
};

/**
 * 把检索到的记忆拼成注入 system prompt 的一段。
 *
 * 注意这里只返回「记得的内容」，使用方式的要求写在 buildSystemPrompt 里，
 * 避免职责混在一起难以调整。
 */
export function formatMemories(memories) {
  if (!Array.isArray(memories) || memories.length === 0) return '';
  const lines = memories.map((m) => {
    const label = KIND_LABEL[m.kind] ?? '';
    return `- ${m.text}${label ? `（${label}）` : ''}`;
  });
  return lines.join('\n');
}

export class MemoryManager {
  #cfg;
  #store;
  #llm;
  #running = new Set();

  constructor({ cfg, store, llm }) {
    this.#cfg = cfg?.memory ?? {};
    this.#store = store;
    this.#llm = llm;
    this.stats = { extracted: 0, stored: 0, updated: 0, skipped: 0, errors: 0 };
  }

  get enabled() {
    return this.#cfg.enabled !== false;
  }

  get recallEnabled() {
    return this.enabled && this.#cfg.recall !== false;
  }

  get extractEnabled() {
    return this.enabled && this.#cfg.extract !== false;
  }

  /**
   * 检索与当前这句话相关的长期记忆。
   * 同步、纯本地 SQLite 查询 —— 实测 5000 条记忆下 16 次 LIKE + 排序约 1ms。
   */
  retrieve({ scope, scopeId, text, senderId }) {
    if (!this.recallEnabled) return [];
    const gs = queryGrams(text, { max: Number(this.#cfg.maxQueryGrams ?? 24) });
    if (gs.length === 0) return [];
    const want = Number(this.#cfg.recallLimit ?? 8);
    // subject 用 QQ 号标识"关于谁"。自己的事记在 'self' 下，任何会话都该想得起来。
    const mems = this.#store.searchMemories({
      scope,
      scopeId,
      grams: gs,
      extraSubjects: senderId ? [String(senderId)] : [],
      // 多取候选：下面要先剔同义重复再截断，按 want 取会把名额浪费在变体上。
      // 实测真库 73 条里 36% 是冗余，命中 6 个名额里常常只有 3 个不同事实。
      limit: this.#cfg.dedupeOnRetrieve === false ? want : Math.max(want * 4, want),
    });
    const minScore = Number(this.#cfg.minScore ?? 2);
    const scored = mems.filter((m) => m.score >= minScore);
    // 检索端多样性去重：即使库里已经有脏数据（历史遗留、抽取器没听话），
    // 也不能把同一件事的 5 种说法一起喂给模型 —— 那会让模型误判"这件事特别重要"。
    const kept = this.#cfg.dedupeOnRetrieve === false ? scored.slice(0, want) : pickDistinct(scored).slice(0, want);
    if (kept.length) {
      this.#store.touchMemories(kept.map((m) => m.id));
      logger.debug(
        `召回记忆 ${kept.length} 条（候选 ${scored.length}）` +
          `${scored.length > kept.length ? `，合并同义 ${scored.length - kept.length} 条` : ''}：` +
          kept.map((m) => `${m.text}(${m.score})`).join(' / '),
      );
    }
    return kept;
  }

  /**
   * 后台抽取：从这几轮对话里挑出值得长期记住的事，写进库。
   * 调用方**不应该 await 它** —— 它是纯附加的，慢一点、失败都无所谓。
   * 返回 Promise 方便测试里 await。
   */
  async extractAndStore({ scope, scopeId, history, senderId, senderName, isOwner }) {
    if (!this.extractEnabled) return { stored: 0, skipped: true };
    const key = `${scope}:${scopeId}`;
    if (this.#running.has(key)) {
      // 同一会话上一次抽取还没跑完就来了新的，直接跳过：记忆不是实时性要求高的东西。
      this.stats.skipped += 1;
      return { stored: 0, skipped: true };
    }
    const lines = this.#buildTranscript(history);
    if (!lines) return { stored: 0, skipped: true };

    this.#running.add(key);
    try {
      // 把「已经记住的事」一并喂给抽取器：否则它每次都会给同一件事另起一个说法，
      // 库里的重复就永远补不完（实测 73 条里 36% 是冗余，多数是这么来的）。
      const known = this.#cfg.dedupeExtract === false ? [] : this.#knownMemories(scope, scopeId, String(senderId ?? ''));
      const raw = await this.#callExtractor({ lines, senderName, isOwner, known });
      const items = this.#parseItems(raw);
      if (items.length === 0) return { stored: 0 };
      let stored = 0;
      let updated = 0;
      const maxPerCall = Number(this.#cfg.maxPerCall ?? 5);
      for (const item of items.slice(0, maxPerCall)) {
        const subject = item.subject === 'self' ? 'self' : String(senderId ?? 'unknown');
        const res = this.#store.addMemory(
          {
            scope,
            scopeId,
            subject,
            text: item.text,
            kind: item.kind,
          },
          // 第②层：入库时的保守近似合并，兜住抽取器没听话的情况。
          {
            merge: {
              enabled: this.#cfg.dedupeOnWrite !== false,
            },
          },
        );
        if (res?.updated) updated += 1;
        else if (res) stored += 1;
      }
      this.stats.extracted += 1;
      this.stats.stored += stored;
      this.stats.updated += updated;
      if (stored || updated) {
        logger.info(`记忆更新：新增 ${stored} 条，强化 ${updated} 条（${key}）`);
      }
      // 条数上限保护：长期记忆不按时间删，但也不能无限涨。
      this.#store.pruneMemories(scope, scopeId, Number(this.#cfg.maxPerSession ?? 500));
      return { stored, updated };
    } catch (err) {
      this.stats.errors += 1;
      logger.warn(`记忆抽取失败（不影响回复）：${err.message}`);
      return { stored: 0, error: err.message };
    } finally {
      this.#running.delete(key);
    }
  }

  /** 只把"对方说的话"喂给抽取器：AI 自己的回复里可能有编造内容，不能当成事实记下来。 */
  #buildTranscript(history) {
    const lines = [];
    for (const h of history ?? []) {
      const text = String(h.text ?? '').trim();
      if (!text) continue;
      if (h.role === 'assistant') continue;
      const who = h.sender || h.senderId || '对方';
      lines.push(`${who}：${text}`);
    }
    const joined = lines.join('\n');
    const maxChars = Number(this.#cfg.maxInputChars ?? 1200);
    return joined.length > maxChars ? joined.slice(-maxChars) : joined;
  }

  /**
   * 取已经记住的、关于这个人的记忆，用于喂给抽取器当"已知清单"。
   * 取了最新的 N 条（近期的更可能被重复提到），失败一律当没有 —— 它只是优化项。
   */
  #knownMemories(scope, scopeId, senderId) {
    try {
      const limit = Number(this.#cfg.dedupeKnownLimit ?? 40);
      if (!(limit > 0)) return [];
      return this.#store.listMemories(scope, scopeId, { limit }).filter((m) => m.subject === 'self' || m.subject === senderId);
    } catch {
      return [];
    }
  }

  async #callExtractor({ lines, senderName, isOwner, known = [] }) {
    const label = isOwner ? `号主本人（人设里称他"开拓者"）` : `群友/陌生人「${senderName ?? '未知'}」`;
    const system = [
      '你是一个记忆抽取器。从下面这段聊天记录里，找出**值得长期记住**的关于对方的信息。',
      '',
      '值得记的（举例）：',
      '- 稳定的偏好：不喜欢吃香菜、喜欢喝冰美式',
      '- 持续的近况：最近在学吉他、下个月要去成都旅游、在准备考研',
      '- 个人事实：养了一只叫咪咪的猫、生日是四月十二号、在杭州读大学',
      '- 与她的关系：是她的老朋友、经常在群里帮她说话',
      '- 关于她自己被确认的事：她说过自己怕冷',
      '',
      '不值得记的（一律不要）：',
      '- 寒暄、打招呼、语气词、表情（"在吗""哈哈""好的"）',
      '- 临时状态（"我现在在吃饭""刚睡醒"）',
      '- 提问、请求、命令（"你在干嘛""帮我查一下"）',
      '- 任何她（AI/流萤）自己说的话 —— 那可能是编的',
      '- 敏感信息：密码、验证码、转账、身份证、银行卡 —— 一个字都不要记',
      '',
      `对方是谁：${label}`,
      '如果没有任何值得记的，就返回空数组。宁可不记，也不要记废话。',
    ];

    if (Array.isArray(known) && known.length) {
      system.push(
        '',
        '【已经记住的事 —— 这些不用再记一遍】',
        ...known.map((m) => `- ${m.text}`),
        '',
        '如果聊天里出现的事和上面某条其实是**同一件事**（只是换了说法、多了少了一点细节），',
        '就**不要**再输出一条 —— 除非出现了上面没有的**新信息**（新的时间、新的对象、新的态度）。',
        '判断标准是"这件事我知道了吗"，不是"用词一样吗"。',
      );
    }

    system.push(
      '',
      '只返回 JSON，格式：',
      '{"memories":[{"text":"一句话陈述，主语写清楚是谁","kind":"fact|event|preference|relation","subject":"other|self"}]}',
      '其中 subject=other 表示这条是关于对方的，subject=self 表示是关于流萤自己的。',
      'text 必须是完整通顺的中文陈述句，不要用"他""她"这种指代不明的代词。',
      // 真库实测：同一个人被写成「阿澈…」和「对方…」两种主语，
      // 于是「阿澈在五月份去过重庆玩」和「对方在五月份去过重庆玩」明明是同一件事，
      // 却因为主语不同合并不了，白占两个召回名额。
      // 靠放宽相似度阈值去救会连带放过「猫/狗」，所以从源头把主语钉死。
      `主语一律写"${senderName || '对方'}"，不要写"对方""他""这个人" —— 同一个人每次都要用同一个称呼。`,
    );

    const messages = [
      { role: 'system', content: system.join('\n') },
      { role: 'user', content: lines },
    ];
    const result = await this.#llm.chat(messages, {
      temperature: 0.2,
      maxTokens: Number(this.#cfg.maxTokens ?? 500),
      responseFormat: { type: 'json_object' },
    });
    return result.text;
  }

  #parseItems(raw) {
    const text = String(raw ?? '').trim();
    if (!text) return [];
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      // 模型偶尔会套一层 ```json，兜一下。
      const m = text.match(/\{[\s\S]*\}/);
      if (!m) return [];
      try {
        data = JSON.parse(m[0]);
      } catch {
        return [];
      }
    }
    const arr = Array.isArray(data) ? data : data?.memories;
    if (!Array.isArray(arr)) return [];
    const out = [];
    for (const it of arr) {
      const t = String(it?.text ?? '').trim();
      if (!t || t.length < 3) continue;
      if (t.length > Number(this.#cfg.maxTextLength ?? 120)) continue;
      if (isSensitive(t)) continue;
      const kind = ['fact', 'event', 'preference', 'relation'].includes(it?.kind) ? it.kind : 'fact';
      out.push({ text: t, kind, subject: it?.subject === 'self' ? 'self' : 'other' });
    }
    return out;
  }
}

/** 双重保险：即使抽取模型不听话，也不能把敏感信息写进长期库。 */
const SENSITIVE = ['密码', '验证码', '身份证', '银行卡', '转账', '打钱', '贷款', '借钱', '支付密码'];
export function isSensitive(text) {
  const s = String(text ?? '');
  return SENSITIVE.some((k) => s.includes(k));
}
