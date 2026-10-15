/**
 * 限速器：三层防护，避免短时间大量回复触发风控。
 * 1) 每会话最小间隔  2) 全局限速  3) 并发上限
 */
export class RateLimiter {
  #lastBySession = new Map();
  #globalHits = [];
  #inflight = 0;

  constructor({ perSessionMinIntervalMs = 3000, globalPerMinute = 20, maxInflight = 1 } = {}) {
    this.perSessionMinIntervalMs = perSessionMinIntervalMs;
    this.globalPerMinute = globalPerMinute;
    this.maxInflight = maxInflight;
  }

  /** @returns {{allowed: boolean, reason?: string, waitMs?: number}} */
  check(sessionKey, now = Date.now()) {
    if (this.#inflight >= this.maxInflight) {
      return { allowed: false, reason: 'inflight_limit' };
    }
    const last = this.#lastBySession.get(sessionKey) ?? 0;
    const elapsed = now - last;
    if (elapsed < this.perSessionMinIntervalMs) {
      return { allowed: false, reason: 'session_cooldown', waitMs: this.perSessionMinIntervalMs - elapsed };
    }
    this.#globalHits = this.#globalHits.filter((t) => now - t < 60000);
    if (this.#globalHits.length >= this.globalPerMinute) {
      return { allowed: false, reason: 'global_limit' };
    }
    return { allowed: true };
  }

  /** 占位：标记开始处理一个请求。 */
  begin(sessionKey, now = Date.now()) {
    this.#lastBySession.set(sessionKey, now);
    this.#globalHits.push(now);
    this.#inflight += 1;
  }

  end() {
    this.#inflight = Math.max(0, this.#inflight - 1);
  }

  get inflight() {
    return this.#inflight;
  }

  stats() {
    const now = Date.now();
    this.#globalHits = this.#globalHits.filter((t) => now - t < 60000);
    return { inflight: this.#inflight, lastMinute: this.#globalHits.length, sessions: this.#lastBySession.size };
  }
}
