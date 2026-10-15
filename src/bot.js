import { EventEmitter } from 'node:events';
import { logger } from './logger.js';
import { buildMessages, buildSystemPrompt, chatCompletion, isOwner, llmReady, tidySelfText } from './llm.js';
import { formatMemories } from './memory.js';
import { RateLimiter } from './ratelimit.js';
import { checkSafety, decideTrigger, inQuietHours } from './trigger.js';
import { isAt, imageUrls, segmentsToText, splitReply, stripAt } from './segments.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 「这条是我自己刚发的」记忆窗口。
 * NapCat 开启 reportSelfMessage 后，机器人自己发的消息会以 message_sent 回灌，
 * 需要在这个时间窗内把它认出来，才不会被误当成"号主手打"。
 */
const OWN_ECHO_TTL_MS = 60_000;

/** 机器人主体：把 OneBot 事件 → 触发判断 → 模型 → 回发 串起来。 */
export class Bot extends EventEmitter {
  // 刚由机器人自己发出的消息：message_id / 原文 → 过期时间戳。
  // 用来把 NapCat 回灌的"自己发的消息"和我们真正想识别的"号主手打"区分开。
  #sentIds = new Map();
  #recentSends = new Map();

  constructor({ cfg, store, onebot, awareness = null, memory = null, vision = null, clock = () => new Date() }) {
    super();
    this.cfg = cfg;
    this.store = store;
    this.onebot = onebot;
    this.clock = clock;
    // 实时感知（时间/天气）、长期记忆、看图都是可选的：不传就退化成"没有人设之外的额外信息"，
    // 老测试和只想跑最小功能的人不用改。
    this.awareness = awareness;
    this.memory = memory;
    this.vision = vision;
    this.limiter = new RateLimiter({
      perSessionMinIntervalMs: cfg.rateLimit.perSessionMinIntervalMs,
      globalPerMinute: cfg.rateLimit.globalPerMinute,
    });
    this.stats = { received: 0, triggered: 0, replied: 0, skipped: 0, errors: 0 };
    // 最近若干条回复的耗时样本，用来回答"刚才怎么等了十几秒"。
    // 只留最近 20 条，不落库、不持久化 —— 够看清波动就行。
    this.latency = [];
    this.paused = false;
    this.pauseReason = null;
  }

  attach() {
    this.onebot.on('message', (evt) => {
      this.handle(evt).catch((err) => {
        this.stats.errors += 1;
        logger.error(`处理消息出错：${err.message}`);
      });
    });
    this.onebot.on('open', () => {
      this.onebot
        .getLoginInfo()
        .then((info) => logger.info(`已登录账号：${info.nickname ?? '?'}（${info.user_id ?? '?'}）`))
        .catch(() => logger.warn('获取登录信息失败（不影响使用）'));
    });
    return this;
  }

  /** 你本人手动回了这条会话 → AI 自动退避一段时间，不跟你抢话。 */
  #isUnderTakeover(scope, scopeId, nowMs) {
    const window = this.cfg.safety?.takeoverAfterSelfMessageMs ?? 0;
    if (window <= 0) return false;
    return nowMs - this.store.lastSelfTs(scope, scopeId) < window;
  }

  /** 记下"这条原文是我刚发的"，用于回灌消息的兜底识别。 */
  #rememberSend(scope, scopeId, text) {
    const nowMs = Date.now();
    this.#cleanupEchoTables(nowMs);
    // 先登记再发送：NapCat 的回灌可能比 API 响应更早到达。
    this.#recentSends.set(`${scope}:${scopeId}:${text}`, nowMs + OWN_ECHO_TTL_MS);
  }

  /** 记下 send_*_msg 返回的 message_id，这是最可靠的识别依据。 */
  #rememberSentId(messageId) {
    if (messageId === undefined || messageId === null) return;
    const nowMs = Date.now();
    this.#cleanupEchoTables(nowMs);
    this.#sentIds.set(String(messageId), nowMs + OWN_ECHO_TTL_MS);
  }

  #cleanupEchoTables(nowMs) {
    for (const [k, until] of this.#sentIds) if (until < nowMs) this.#sentIds.delete(k);
    for (const [k, until] of this.#recentSends) if (until < nowMs) this.#recentSends.delete(k);
  }

  /**
   * 这条"自己发的消息"是不是机器人自己刚通过 API 发出的（NapCat 回灌）？
   * 先按 message_id 精确匹配；拿不到/对不上时，退回"同会话 + 同原文 + 时间窗"。
   */
  #isOwnEcho(evt, scope, scopeId) {
    const nowMs = Date.now();
    const mid = String(evt.messageId ?? '');
    if (mid) {
      const until = this.#sentIds.get(mid);
      if (until !== undefined && until >= nowMs) return true;
    }
    const key = `${scope}:${scopeId}:${segmentsToText(evt.message)}`;
    const until = this.#recentSends.get(key);
    return until !== undefined && until >= nowMs;
  }

  async handle(evt) {
    this.stats.received += 1;

    // 1) 去重：同一 message_id 只处理一次
    const mid = String(evt.messageId ?? '');
    if (mid && this.store.seenMessage(mid, this.cfg.rateLimit.dedupeTtlMs)) {
      this.stats.skipped += 1;
      return { action: 'skip', reason: 'duplicate' };
    }

    // 2) 记录入站消息（先落盘，再判断，保证上下文完整）
    const isGroup = evt.messageType === 'group';
    const scope = isGroup ? 'group' : 'private';
    const senderName = evt.sender?.card || evt.sender?.nickname || evt.userId;
    const isSelf = String(evt.userId) === String(this.onebot.selfId);
    // 自己发的消息里 user_id 是自己，会话对象在 target_id。
    // 不修正的话，私聊里"号主手打"会被记到自己名下，接管退避就永远不生效。
    const scopeId = isGroup
      ? String(evt.groupId)
      : String(isSelf ? (evt.targetId ?? evt.userId) : evt.userId);
    const now = this.clock();
    const nowMs = now.getTime();

    // 自己发的消息（message_sent）只记录，不触发。
    // 这里要区分两种来源：
    //   a) 你本人在 QQ 客户端手打 → origin='human'，用来做"接管退避"；
    //   b) NapCat 开启了 reportSelfMessage 后，把「机器人自己刚通过 API 发的消息」
    //      也回灌成 message_sent。若不区分，AI 每回一句都会被自己判定成"号主手打"，
    //      从而把自己锁死 10 分钟。
    if (isSelf) {
      if (this.#isOwnEcho(evt, scope, scopeId)) {
        return { action: 'skip', reason: 'own_echo' };
      }
      this.store.addMessage({
        scope, scopeId, senderId: evt.userId, sender: senderName,
        role: 'assistant', origin: 'human', text: segmentsToText(evt.message), ts: nowMs,
      });
      return { action: 'record_self' };
    }

    const atSelf = isGroup && isAt(evt.message, this.onebot.selfId);
    const promptText = isGroup ? stripAt(evt.message, this.onebot.selfId) : segmentsToText(evt.message);
    const fullText = segmentsToText(evt.message);

    // 「距上次说话多久」要的是"这条消息之前"的上一条，所以必须在落库前取。
    // 落库之后再取就永远是自己（时间差 0），识别不出"好几天没说话了"。
    const prevTs = this.store.lastMessageTs(scope, scopeId);

    this.store.addMessage({
      scope, scopeId, senderId: evt.userId, sender: senderName,
      role: 'user', origin: 'user', text: fullText, ts: nowMs,
    });

    // 3) 全局暂停 / 静默时段
    if (this.paused) {
      this.stats.skipped += 1;
      return { action: 'skip', reason: 'paused' };
    }
    if (inQuietHours(this.cfg, now)) {
      this.stats.skipped += 1;
      return { action: 'skip', reason: 'quiet_hours' };
    }

    // 4) 触发规则
    const takeover = this.#isUnderTakeover(scope, scopeId, nowMs);
    const decision = decideTrigger(
      { ...evt, atSelf, promptText },
      this.cfg,
      this.onebot.selfId,
      { isTakeover: takeover },
    );
    if (!decision.trigger) {
      this.stats.skipped += 1;
      logger.debug(`不触发：${decision.reason}（${scope}:${scopeId}）`);
      return { action: 'skip', reason: decision.reason };
    }

    // 只用"去掉 @ 自己之后"的文本判断有没有实际内容。
    // 不能用 fullText 兜底：群里只 @ 不说话时 fullText 会是"@我"，会被误判成有话要说。
    const askText = promptText.trim();
    if (!askText) {
      // 只 @ 了没说话 → 随机挑一句简短应答
      return this.#send(scope, scopeId, evt, this.cfg.persona.fallback, 'empty_prompt');
    }

    // 5) 敏感词兜底：不调模型
    const safety = checkSafety(askText, this.cfg);
    if (safety.blocked) {
      logger.warn(`命中敏感词「${safety.keyword}」，使用固定话术回复`);
      return this.#send(scope, scopeId, evt, safety.reply, 'safety_blocked');
    }

    // 6) 限速
    const sessionKey = `${scope}:${scopeId}`;
    const gate = this.limiter.check(sessionKey, nowMs);
    if (!gate.allowed) {
      this.stats.skipped += 1;
      logger.info(`限速跳过（${gate.reason}）${sessionKey}`);
      return { action: 'skip', reason: `rate_${gate.reason}` };
    }

    // 7) 调用模型
    if (!llmReady(this.cfg.llm)) {
      this.stats.errors += 1;
      logger.error('llm.apiKey 未配置，无法生成回复');
      return { action: 'error', reason: 'llm_not_configured' };
    }

    this.stats.triggered += 1;
    this.limiter.begin(sessionKey, nowMs);
    const started = Date.now();
    try {
      // 历史按「轮」取，不按「行」取。
      // 实测：私聊最近 20 行里她自己占 13 行（65%），窗口边界常落在一轮中间，
      // 开头那半条助手消息会被 buildMessages 丢掉 —— 等于白占额度，
      // 而对方说过的话反而记不住。
      const turns = isGroup
        ? this.cfg.context.groupTurns ?? this.cfg.context.groupWindow
        : this.cfg.context.privateTurns ?? this.cfg.context.privateWindow;
      const history = this.store.recentTurns(scope, scopeId, turns);

      // 短期自身话记忆：她最近几轮说过的话单独拎出来提醒一次。
      // 为什么需要：她连发的多条气泡在模型眼里是合并后的一条 assistant，
      // 滑出窗口后她就不知道自己答应过什么了（实测会重复答应同一件事）。
      const sm = this.cfg.selfMemory ?? {};
      const selfTexts =
        sm.enabled === false
          ? []
          : (() => {
              const maxChars = Number(sm.maxChars ?? 400) || 0;
              const maxItem = Number(sm.maxItemChars ?? 60) || 60;
              // recentSelfTexts 返回的是时间正序（旧 → 新）。
              // 必须过 tidySelfText：这里是同一个自我强化回路的第二个入口 ——
              // 这段文本会被拼进 system prompt，如果它自己带句号，模型就照着自己的
              // 旧句号继续写。buildMessages 里清洗的是 assistant 历史，这里清洗的是
              // 「方才自己说过的话」清单，两处都堵上才算完整。
              const all = this.store
                .recentSelfTexts(scope, scopeId, sm.turns ?? 8, { limit: sm.limit ?? 8 })
                .map((t) => tidySelfText(t))
                // 太短的口水话（"嗯""在呢"）提醒了也没用，还白占 token。
                .filter((t) => t.length >= 4)
                .map((t) => (t.length > maxItem ? `${t.slice(0, maxItem)}…` : t));
              // 从最近的那条往回塞，塞满 maxChars 就停 —— 越近的越重要。
              const picked = [];
              let used = 0;
              for (let i = all.length - 1; i >= 0; i -= 1) {
                if (used + all[i].length + 2 > maxChars) break;
                picked.push(all[i]);
                used += all[i].length + 2;
              }
              return picked.reverse();
            })();

      // 「开拓者」只认 owner.qq 那一个号。群里其他人 @ 时 isOwner=false，
      // prompt 会换成"普通群友"的语境，避免把人设里对开拓者的亲近套到陌生人身上。
      const senderIsOwner = isOwner(this.cfg, evt.userId);

      // 实时感知：时间 + 天气 + 距上次说话多久。
      // snapshot 是同步的、只读缓存，绝不会在这条链路上发网络请求 —— 天气由后台定时刷新。
      const environment = this.awareness
        ? this.awareness.snapshot({ now, lastTs: prevTs })
        : [];

      // 长期记忆检索：本地 SQLite 查询，实测 5000 条下只要 1ms，放主链路没有负担。
      let recalled = [];
      if (this.memory?.recallEnabled) {
        try {
          recalled = this.memory.retrieve({
            scope, scopeId, text: askText, senderId: evt.userId,
          });
        } catch (err) {
          // 记忆检索失败绝不能拖垮回复：宁可这次没有记忆，也要把话回出去。
          logger.warn(`记忆检索失败（继续回复）：${err.message}`);
        }
      }

      const system = buildSystemPrompt(this.cfg, {
        isGroup,
        groupId: scopeId,
        isOwner: senderIsOwner,
        environment,
        memories: recalled.length ? formatMemories(recalled) : '',
        selfTexts,
      });

      // 看图：把图片下载成 data URL，作为多模态内容附在这条 user 消息上。
      // 下载有超时、有大小上限、有缓存，单张失败只记日志不拦回复 ——
      // 图挂了也要把话说出去，不能因为一张图整个卡住。
      const images = this.vision
        ? await this.vision.fetchMany(imageUrls(evt.message))
        : [];

      const messages = buildMessages(system, history, { maxChars: this.cfg.context.maxChars, images });
      const result = await chatCompletion(this.cfg.llm, messages);
      const reply = cleanReply(result.text);

      if (!reply) {
        this.#maybeExtractMemory(scope, scopeId, evt, senderIsOwner, senderName, history);
        return this.#send(scope, scopeId, evt, this.cfg.persona.fallback, 'empty_reply', {
          elapsedMs: Date.now() - started,
        });
      }
      logger.info(
        `生成回复（${Date.now() - started}ms，${reply.length} 字，${senderIsOwner ? '开拓者' : '非开拓者'}，` +
          `记忆 ${recalled.length} 条，自身话 ${selfTexts.length} 条，感知 ${environment.length} 条，图片 ${images.length} 张）：${reply.slice(0, 80)}`,
      );

      // 8) 分段发送并记录 assistant 历史
      // 私聊和群聊的节奏不同，所以长度与段数都分开取：
      //   群聊：人多眼杂，气泡要大一点、条数少一点（实测群聊中位 30 字，保持不动）。
      //   私聊：实测中位 83 字、48% 超 90，偏长的抱怨全部来自这里，
      //         所以气泡收紧到 privateMaxLength，段数上限放宽到 privateMaxSegments。
      // 两个值都做了 ?? 兜底：老配置文件里没有这些键时行为跟以前完全一致。
      const maxLength = isGroup
        ? this.cfg.split.maxLength
        : this.cfg.split.privateMaxLength ?? this.cfg.split.maxLength;
      const maxSegments = isGroup
        ? this.cfg.split.maxSegments
        : Math.max(this.cfg.split.maxSegments, this.cfg.split.privateMaxSegments ?? this.cfg.split.maxSegments);
      const chunks = this.cfg.split.enabled
        ? splitReply(reply, {
            maxLength,
            maxSegments,
            bubbleOnNewline: this.cfg.split.bubbleOnNewline !== false,
          })
        : [reply];

      // 打字延迟：模拟"看到消息 → 打字 → 发出去"，按这条回复的字数算。
      // 已经花掉的时间（记忆检索 + 模型生成）从预算里扣掉 —— 否则模型本来就慢时
      // 还要再等一遍，变成没必要的叠加。私聊只有一条消息时也要等，见 #send()。
      const waitedMs = Date.now() - started;
      const thinkMs = typingDelayMs(this.cfg, { text: reply, elapsedMs: waitedMs });
      this.#recordLatency({ modelMs: waitedMs, thinkMs, chars: reply.length });
      // 用 info 而不是 debug：用户反馈"有时候要等十几秒"，而光看"生成回复 XXXms"
      // 分不清这十几秒是模型慢还是程序在等 —— 这一行把两个数字并排摆出来。
      logger.info(
        `打字延迟 ${thinkMs}ms（回复 ${reply.length} 字，模型已耗时 ${waitedMs}ms` +
          `，预计发送时刻 +${waitedMs + thinkMs}ms）`,
      );
      if (thinkMs > 0) {
        await this.#typingPause(scope, scopeId, thinkMs);
      }

      for (let i = 0; i < chunks.length; i += 1) {
        if (i > 0) await sleep(randInt(this.cfg.split.delayMinMs, this.cfg.split.delayMaxMs));
        const sent = await this.#rawSend(scope, scopeId, chunks[i]);
        this.#rememberSentId(sent?.message_id);
        this.store.addMessage({
          scope, scopeId, senderId: this.onebot.selfId ?? 'self', sender: '我',
          role: 'assistant', origin: 'ai', text: chunks[i], ts: Date.now(),
        });
      }
      this.stats.replied += 1;
      // 记忆抽取在**回复发出之后**启动，且不 await：
      // 它是额外一次模型调用（实测 400-800ms），等它会让每次回复都慢近 1 秒。
      this.#maybeExtractMemory(scope, scopeId, evt, senderIsOwner, senderName, history);
      return { action: 'reply', chunks };
    } catch (err) {
      this.stats.errors += 1;
      logger.error(`生成/发送失败：${err.message}`);
      return { action: 'error', reason: err.message };
    } finally {
      this.limiter.end();
    }
  }

  /**
   * 记下这条回复的耗时构成，供 /api/status 查看。
   *
   * 用户反馈过"刚才等了十二秒"。日志里只有"生成回复 12417ms"一行，
   * 分不清是模型慢、还是程序在等 —— 而这两件事的解法完全不同：
   * 模型慢只能缩 prompt 或调超时，程序等就是 typing 配置的事。
   * 只留最近 20 条，内存里存着，不落库。
   */
  #recordLatency(sample) {
    this.latency.push({ ts: Date.now(), ...sample });
    if (this.latency.length > 20) this.latency.shift();
  }

  /**
   * 回复之后，在后台把这一轮对话里值得记的东西抽成长期记忆。
   *
   * 故意的"发射后不管"：不 await、失败只打日志。
   * 理由：抽取是额外一次模型调用（实测 400-800ms）。等它完成再结束 handle()，
   * 每次回复都会白白慢近 1 秒；而且抽取失败跟"这次有没有回上话"毫无关系。
   */
  #maybeExtractMemory(scope, scopeId, evt, senderIsOwner, senderName, history) {
    if (!this.memory?.extractEnabled) return;
    // history 是"这条消息之前"的历史，缺当前这句；补进去，否则刚说的话永远抽不到。
    const withCurrent = [...history, {
      role: 'user',
      sender: senderName,
      senderId: evt.userId,
      text: segmentsToText(evt.message),
      ts: Date.now(),
    }];
    this.memory
      .extractAndStore({
        scope,
        scopeId,
        history: withCurrent,
        senderId: evt.userId,
        senderName,
        isOwner: senderIsOwner,
      })
      .catch((err) => logger.warn(`记忆抽取异常（不影响回复）：${err.message}`));
  }

  /**
   * 打字延迟 + 「对方正在输入…」提示。
   *
   * 为什么要有这个包装：单纯的 sleep 只是让程序闭嘴，对方屏幕上什么都没发生，
   * 他会以为机器人没反应。发一次"正在输入"能把这几十秒变成"她正在打字"。
   *
   * 两个刻意的限制：
   *   1. 只在私聊发 —— NapCat 的 set_input_status 内部把 chatType 写死成 KCHATTYPEC2C，
   *      群聊没有这个概念（协议层做不到，不是我们不想）。
   *   2. 发信号是"顺手的事"：它失败（老版本 NapCat 没这个动作、对方把你删了、
   *      网络抖了一下）只会写一行 debug 日志，绝不能影响这条回复。
   */
  async #typingPause(scope, scopeId, sleepMs) {
    const ic = this.cfg.inputStatus;
    const shouldSignal =
      scope === 'private' &&
      Boolean(this.onebot.selfId) &&
      ic?.enabled !== false &&
      sleepMs >= Math.max(0, Number(ic?.minDelayMs ?? 800) || 0);

    if (shouldSignal) {
      // 不等它返回：这是"顺手发一下"，QQ 那边收不收得到都不影响我们按时把话发出去。
      this.onebot
        .setInputStatus(scopeId, 1)
        .then(() => logger.debug(`已发送「正在输入」提示：${scopeId}`))
        .catch((err) => logger.debug(`「正在输入」提示发送失败（不影响回复）：${err.message}`));
    }

    await sleep(sleepMs);
  }

  async #send(scope, scopeId, evt, text, reason, { elapsedMs = 0 } = {}) {
    if (!text) return { action: 'skip', reason };

    // 兜底的几条路径（只 @ 不说话 / 敏感词 / 模型没给出正文）以前是秒回的，
    // 而"秒回一句'嗯……让我想想'"恰恰最不像人。这里补上同一套打字延迟。
    const thinkMs = typingDelayMs(this.cfg, { text, elapsedMs });
    this.#recordLatency({ modelMs: elapsedMs, thinkMs, chars: text.length, reason });
    if (thinkMs > 0) {
      logger.info(`打字延迟 ${thinkMs}ms（兜底回复 ${text.length} 字，reason=${reason}，模型已耗时 ${elapsedMs}ms）`);
      await this.#typingPause(scope, scopeId, thinkMs);
    }

    this.store.addMessage({
      scope, scopeId, senderId: this.onebot.selfId ?? 'self', sender: '我',
      role: 'assistant', origin: 'ai', text, ts: Date.now(),
    });
    try {
      const sent = await this.#rawSend(scope, scopeId, text);
      this.#rememberSentId(sent?.message_id);
      this.stats.replied += 1;
      return { action: 'reply', chunks: [text], reason };
    } catch (err) {
      this.stats.errors += 1;
      logger.error(`发送失败：${err.message}`);
      return { action: 'error', reason: err.message };
    }
  }

  #rawSend(scope, scopeId, text) {
    // 先登记原文再发送：回灌事件可能先于 API 响应抵达。
    this.#rememberSend(scope, scopeId, text);
    return scope === 'group'
      ? this.onebot.sendGroup(scopeId, text)
      : this.onebot.sendPrivate(scopeId, text);
  }

  pause(reason = 'manual') {
    this.paused = true;
    this.pauseReason = reason;
    logger.warn(`机器人已暂停：${reason}`);
  }

  resume() {
    this.paused = false;
    this.pauseReason = null;
    logger.info('机器人已恢复');
  }
}

/**
 * 清洗模型输出：去掉包裹引号、多余前缀、换行符。
 *
 * 除了通用清洗，这里还要兜住"人设文件里写了台词范例"带来的副作用：
 * 范例用「」包裹时，模型很容易学着一起打出来。QQ 里发书名号很出戏，所以统一剥掉。
 */
export function cleanReply(text) {
  let out = String(text ?? '').trim();
  out = out.replace(/^```[\s\S]*?\n/, '').replace(/```$/, '').trim();
  out = out.replace(/^(回复|回答|助手|AI)[:：]\s*/i, '');
  // 书名号：人设文件第四节的台词范例用「」包裹，模型很容易学着一起打出来。
  // 这些符号在 QQ 聊天里没有任何作用，直接连壳去掉，只保留里面的内容。
  // 用"全部删除"而不是"剥成对的外壳"，是因为嵌套（「他说『你好』」）和落单的半个括号
  // 都会让成对匹配失败，留下半个符号发出去。
  out = out.replace(/[「」『』]/g, '');
  // 动作描写/强调用的星号，如 *歪头* —— 聊天里不该出现。
  out = out.replace(/\*([^*\n]{1,40})\*/g, '$1');

  // ---- 换行 = 气泡边界 ----
  // 以前这里写的是 `out.replace(/\s*\n+\s*/g, ' ')`，把换行一律抹成空格。
  // 代价是实测出来的：模型本来就会用换行分段（"我也想你\n\n刚才还在想…"），
  // 抹掉之后整条变成一段"文字"，它下一轮为了让话说得清就只能改用句号，
  // 而我们又把带句号的历史喂回去当范例 —— 于是句号越积越多，越来越像写作文。
  // 现在保留换行，交给 splitReply 按行切成气泡；空行折叠成单个换行。
  out = out
    .split('\n')
    .map((line) => line.trim().replace(/^["'“”‘’]+|["'“”‘’]+$/g, '').trim())
    .filter(Boolean)
    .join('\n');

  if (out.length > 400) out = out.slice(0, 400);
  return out;
}

function randInt(min, max) {
  const lo = Math.max(0, Number(min) || 0);
  const hi = Math.max(lo, Number(max) || lo);
  return lo + Math.floor(Math.random() * (hi - lo + 1));
}

/**
 * 算出「这条回复该等多久再发」。
 *
 * 想要的效果不是"慢"，是"像真人在手机上打字"：
 *   反应时间（看到消息 → 开始打字）+ 打字时间（字数 × 每字耗时）
 * 最后再扣掉已经花掉的时间（记忆检索 + 模型生成，实测 0.5~2 秒）。
 * 不扣的话，模型慢的时候会变成"慢 + 慢"的叠加，那就不像人了，是真卡。
 *
 * 返回 0 表示不等（关掉了、或预算已经被生成耗时用完）。
 */
export function typingDelayMs(cfg, { text = '', elapsedMs = 0, random = Math.random } = {}) {
  const t = cfg?.typing;
  if (!t || t.enabled === false) return 0;

  const perChar = Math.max(0, Number(t.perCharMs) || 0);
  const cap = Math.max(0, Number(t.maxDelayMs) || 0);
  const reactMin = Math.max(0, Number(t.reactMinMs) || 0);
  const reactMax = Math.max(reactMin, Number(t.reactMaxMs) || reactMin);

  // 反应时间每条回复只算一次；打字时间按字数。
  const react = reactMin + random() * (reactMax - reactMin);
  const typing = Math.min(String(text ?? '').length * perChar, cap);

  const budget = react + typing - Math.max(0, Number(elapsedMs) || 0);
  return budget > 0 ? Math.round(budget) : 0;
}
