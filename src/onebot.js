import { EventEmitter } from 'node:events';
import { logger } from './logger.js';

/**
 * OneBot 11 正向 WebSocket 客户端。
 * 只实现本项目需要的最小接口面：收事件、发 API 请求。
 */
export class OneBot extends EventEmitter {
  #ws = null;
  #pending = new Map();
  #seq = 0;
  #retry = 0;
  #closed = false;
  #timer = null;
  #selfId = null;
  #lastPong = 0;

  constructor(cfg) {
    super();
    this.cfg = cfg;
    this.wsUrl = cfg.onebot?.wsUrl ?? cfg.wsUrl;
    this.accessToken = cfg.onebot?.accessToken ?? cfg.accessToken ?? '';
    this.reconnectMinMs = cfg.onebot?.reconnectMinMs ?? 1000;
    this.reconnectMaxMs = cfg.onebot?.reconnectMaxMs ?? 30000;
    this.apiTimeoutMs = cfg.onebot?.apiTimeoutMs ?? 15000;
  }

  get connected() {
    return this.#ws !== null && this.#ws.readyState === 1;
  }

  get selfId() {
    return this.#selfId;
  }

  connect() {
    this.#closed = false;
    if (this.connected) return;
    if (typeof WebSocket === 'undefined') {
      throw new Error('当前 Node 不支持全局 WebSocket，请使用 Node 22+ 并确认 --experimental-websocket 状态');
    }

    const url = this.#buildUrl();
    logger.info(`连接 OneBot：${this.wsUrl}`);
    let ws;
    try {
      ws = new WebSocket(url);
    } catch (err) {
      logger.error(`WebSocket 创建失败：${err.message}`);
      this.#scheduleReconnect();
      return;
    }
    this.#ws = ws;

    ws.addEventListener('open', () => {
      this.#retry = 0;
      this.#lastPong = Date.now();
      logger.info('OneBot 已连接');
      this.emit('open');
      this.#startPing();
    });

    ws.addEventListener('message', (ev) => {
      let payload;
      try {
        payload = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data));
      } catch {
        logger.warn('收到非 JSON 消息，已忽略');
        return;
      }
      this.#dispatch(payload);
    });

    ws.addEventListener('error', (ev) => {
      logger.warn(`OneBot 连接错误：${ev?.message ?? 'unknown'}`);
    });

    ws.addEventListener('close', (ev) => {
      this.#stopPing();
      this.#ws = null;
      this.#failAllPending(new Error(`连接已关闭 (code=${ev?.code ?? '?'})`));
      if (this.#closed) {
        logger.info('OneBot 已主动断开');
        return;
      }
      logger.warn(`OneBot 连接断开 (code=${ev?.code ?? '?'})，将自动重连`);
      this.emit('close', ev);
      this.#scheduleReconnect();
    });
  }

  #buildUrl() {
    if (!this.accessToken) return this.wsUrl;
    const sep = this.wsUrl.includes('?') ? '&' : '?';
    // NapCat 正向 WS 支持 query 传 token
    return `${this.wsUrl}${sep}access_token=${encodeURIComponent(this.accessToken)}`;
  }

  #dispatch(payload) {
    const { post_type: postType, message_type: messageType } = payload ?? {};

    // API 响应：有 echo 且没有 post_type
    if (payload?.echo !== undefined && !postType) {
      const pending = this.#pending.get(String(payload.echo));
      if (!pending) return;
      this.#pending.delete(String(payload.echo));
      clearTimeout(pending.timer);
      if (payload.status === 'ok' || payload.retcode === 0) {
        pending.resolve(payload.data ?? {});
      } else {
        pending.reject(new Error(`API 调用失败：${payload.message ?? payload.wording ?? payload.retcode}`));
      }
      return;
    }

    if (payload?.self_id) this.#selfId = String(payload.self_id);

    if (postType === 'meta_event') {
      if (payload.meta_event_type === 'lifecycle') {
        this.emit('lifecycle', payload);
      } else if (payload.meta_event_type === 'heartbeat') {
        this.#lastPong = Date.now();
        this.emit('heartbeat', payload);
      }
      return;
    }

    if (postType === 'message' || postType === 'message_sent') {
      this.emit('message', {
        raw: payload,
        postType,
        messageType,
        messageId: payload.message_id,
        selfId: payload.self_id,
        userId: String(payload.user_id ?? ''),
        groupId: payload.group_id !== undefined ? String(payload.group_id) : undefined,
        // 自己发的消息（message_sent）里 user_id 是自己，真正的会话对象在 target_id。
        // 私聊必须靠它才能把"本人手打"记到正确的会话上。
        targetId: payload.target_id !== undefined ? String(payload.target_id) : undefined,
        message: payload.message,
        rawMessage: payload.raw_message,
        sender: payload.sender ?? {},
        time: payload.time ? payload.time * 1000 : Date.now(),
      });
      return;
    }

    if (postType === 'notice') this.emit('notice', payload);
    if (postType === 'request') this.emit('request', payload);
  }

  /** 调用 OneBot API，返回 data。失败时 reject。 */
  call(action, params = {}, { timeoutMs } = {}) {
    return new Promise((resolve, reject) => {
      if (!this.connected) {
        reject(new Error(`OneBot 未连接，无法调用 ${action}`));
        return;
      }
      const echo = `req_${++this.#seq}_${Date.now()}`;
      const timer = setTimeout(() => {
        this.#pending.delete(echo);
        reject(new Error(`调用 ${action} 超时（${timeoutMs ?? this.apiTimeoutMs}ms）`));
      }, timeoutMs ?? this.apiTimeoutMs);
      this.#pending.set(echo, { resolve, reject, timer, action });
      try {
        this.#ws.send(JSON.stringify({ action, params, echo }));
      } catch (err) {
        clearTimeout(timer);
        this.#pending.delete(echo);
        reject(err);
      }
    });
  }

  sendGroup(groupId, message) {
    return this.call('send_group_msg', { group_id: Number(groupId), message });
  }

  sendPrivate(userId, message) {
    return this.call('send_private_msg', { user_id: Number(userId), message });
  }

  getLoginInfo() {
    return this.call('get_login_info');
  }

  /**
   * 告诉对方"我正在输入"。
   *
   * 这是 NapCat 的扩展动作（不是 OneBot 标准），而且它内部把 chatType 写死成
   * KCHATTYPEC2C —— 只支持私聊，群聊做不到。老版本 NapCat 上可能根本没有这个动作，
   * 所以调用方必须容忍它失败。
   */
  setInputStatus(userId, eventType = 1) {
    return this.call('set_input_status', {
      user_id: String(userId),
      event_type: Number(eventType),
    });
  }

  #failAllPending(err) {
    for (const [echo, p] of this.#pending) {
      clearTimeout(p.timer);
      p.reject(new Error(`${err.message}（${p.action}）`));
      this.#pending.delete(echo);
    }
  }

  #startPing() {
    this.#stopPing();
    this.#timer = setInterval(() => {
      if (!this.connected) return;
      if (Date.now() - this.#lastPong > 90000) {
        logger.warn('90 秒未收到心跳，判定连接假死，强制重连');
        try {
          this.#ws.close();
        } catch {
          /* ignore */
        }
        return;
      }
      this.call('get_status', {}, { timeoutMs: 5000 })
        .then(() => {
          this.#lastPong = Date.now();
        })
        .catch(() => {
          /* 心跳失败交给假死检测 */
        });
    }, 30000);
    this.#timer.unref?.();
  }

  #stopPing() {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
  }

  #scheduleReconnect() {
    if (this.#closed) return;
    const delay = Math.min(this.reconnectMinMs * 2 ** this.#retry, this.reconnectMaxMs);
    this.#retry += 1;
    logger.info(`${Math.round(delay / 1000)} 秒后重连（第 ${this.#retry} 次）`);
    setTimeout(() => {
      if (!this.#closed) this.connect();
    }, delay).unref?.();
  }

  close() {
    this.#closed = true;
    this.#stopPing();
    this.#failAllPending(new Error('正在关闭'));
    try {
      this.#ws?.close();
    } catch {
      /* ignore */
    }
    this.#ws = null;
  }
}
