/**
 * 图片获取：把 OneBot 图片段里的地址变成模型能吃的 data URL。
 *
 * 背景（实测）：NapCat 的 image 段里带了可直接下载的 `url`
 * （napcat.mjs 的 picElement：`url: await FileApi.getImageUrl(e)`），
 * 但 segments.js 一直只用 `type` 去查占位符表，把地址整个丢掉了，
 * 于是模型看到的永远只是「[图片]」三个字。这个模块负责把地址捡回来。
 *
 * 为什么转 base64 而不是直接把 URL 丢给模型：
 *  1. QQ 的图片地址带 rkey 之类的临时凭据，会过期，模型那边再去下载可能已经 403；
 *  2. 先下载下来才能校验它到底是不是图（在线状态返回一个 HTML 错误页也是常事）；
 *  3. 超限、超时、非图片这些情况都要在我们这边拦住，不能把错误丢给模型去猜。
 *
 * 约束（DeepSeek 官方文档）：只支持 jpeg/png/gif/webp，单图最大 32 MiB，
 * 图片只能出现在 user 消息里（system/assistant 带图会 400），每张图最多算 1024 token。
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { logger } from './logger.js';

const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 10000;
const DEFAULT_CACHE_TTL_MS = 10 * 60 * 1000;
const DEFAULT_CACHE_MAX = 16;

/** 按魔术字节认图片类型。不信 Content-Type —— 出错页也会自称 image/jpeg。 */
const MAGIC = [
  { mime: 'image/jpeg', test: (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  {
    mime: 'image/png',
    test: (b) => b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47,
  },
  { mime: 'image/gif', test: (b) => b.length > 6 && b.subarray(0, 3).toString('latin1') === 'GIF' },
  {
    mime: 'image/webp',
    test: (b) =>
      b.length > 12 &&
      b.subarray(0, 4).toString('latin1') === 'RIFF' &&
      b.subarray(8, 12).toString('latin1') === 'WEBP',
  },
];

/** 返回识别出的 MIME，认不出返回 ''（调用方据此拒绝，绝不硬猜）。 */
export function sniffImageMime(buf) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf ?? []);
  for (const m of MAGIC) if (m.test(b)) return m.mime;
  return '';
}

/** Buffer → data URL。 */
export function toDataUrl(buf, mime) {
  return `data:${mime};base64,${Buffer.from(buf).toString('base64')}`;
}

function looksLikeWindowsPath(u) {
  return /^[a-zA-Z]:[\\/]/.test(u) || u.startsWith('\\\\');
}

/** 按上限读取响应体，超了立刻断开，不把几十 MB 拉进内存。 */
async function readCapped(res, maxBytes) {
  const declared = Number(res.headers.get('content-length') ?? 0);
  if (declared && declared > maxBytes) {
    throw new Error(`图片 ${declared} 字节，超过上限 ${maxBytes}`);
  }
  const reader = res.body?.getReader?.();
  if (!reader) {
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > maxBytes) throw new Error(`图片 ${buf.length} 字节，超过上限 ${maxBytes}`);
    return buf;
  }
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new Error(`图片超过上限 ${maxBytes} 字节`);
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

/**
 * 图片获取器。带 TTL 缓存：同一条消息里的图只下一次，
 * 重连/重试导致的重复处理也不会重复下载。
 */
export class ImageFetcher {
  #cfg;
  #cache = new Map();
  #stats = { hits: 0, fetches: 0, errors: 0 };

  constructor(cfg = {}) {
    this.#cfg = cfg ?? {};
  }

  get enabled() {
    return this.#cfg.enabled !== false;
  }

  /** 一条消息最多带几张图。0 表示不带。 */
  get maxImages() {
    const n = Number(this.#cfg.maxImages ?? 2);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
  }

  get maxBytes() {
    const n = Number(this.#cfg.maxBytes ?? DEFAULT_MAX_BYTES);
    return Number.isFinite(n) && n > 0 ? n : DEFAULT_MAX_BYTES;
  }

  get timeoutMs() {
    const n = Number(this.#cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    return Number.isFinite(n) && n > 0 ? n : DEFAULT_TIMEOUT_MS;
  }

  get cacheTtlMs() {
    const n = Number(this.#cfg.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS);
    return Number.isFinite(n) && n >= 0 ? n : DEFAULT_CACHE_TTL_MS;
  }

  stats() {
    return { ...this.#stats, cached: this.#cache.size, enabled: this.enabled };
  }

  clear() {
    this.#cache.clear();
  }

  #cacheGet(url) {
    const hit = this.#cache.get(url);
    if (!hit) return null;
    if (hit.until < Date.now()) {
      this.#cache.delete(url);
      return null;
    }
    // 触碰一下，LRU 淘汰时它是"新的"
    this.#cache.delete(url);
    this.#cache.set(url, hit);
    return hit.dataUrl;
  }

  #cacheSet(url, dataUrl) {
    if (this.cacheTtlMs <= 0) return;
    const max = Math.max(1, Number(this.#cfg.cacheMax ?? DEFAULT_CACHE_MAX));
    this.#cache.set(url, { dataUrl, until: Date.now() + this.cacheTtlMs });
    while (this.#cache.size > max) {
      const oldest = this.#cache.keys().next().value;
      this.#cache.delete(oldest);
    }
  }

  /**
   * 取一张图，返回 data URL。
   * 支持：http(s) URL、data URL、OneBot 的 base64://、file:// 以及本地绝对路径
   * （NapCat 开了 enableLocalFile2Url 时给的就是本地路径）。
   */
  async fetchOne(rawUrl) {
    const url = String(rawUrl ?? '').trim();
    if (!url) throw new Error('图片地址为空');

    const cached = this.#cacheGet(url);
    if (cached) {
      this.#stats.hits += 1;
      return cached;
    }

    let dataUrl;
    if (url.startsWith('data:')) {
      if (url.length > this.maxBytes * 1.4) throw new Error('data URL 过大');
      if (!/^data:image\/(jpeg|png|gif|webp);base64,/i.test(url)) {
        throw new Error('data URL 不是支持的图片类型');
      }
      dataUrl = url;
    } else if (url.startsWith('base64://')) {
      const buf = Buffer.from(url.slice('base64://'.length), 'base64');
      dataUrl = this.#encode(buf);
    } else if (url.startsWith('file://') || looksLikeWindowsPath(url)) {
      const file = url.startsWith('file://') ? fileURLToPath(url) : url;
      const stat = await fs.stat(file).catch(() => null);
      if (!stat?.isFile()) throw new Error(`本地图片不存在：${path.basename(file)}`);
      if (stat.size > this.maxBytes) throw new Error(`本地图片 ${stat.size} 字节，超过上限`);
      dataUrl = this.#encode(await fs.readFile(file));
    } else if (/^https?:\/\//i.test(url)) {
      dataUrl = this.#encode(await this.#download(url));
    } else {
      throw new Error(`不认识的图片地址协议：${url.slice(0, 24)}`);
    }

    this.#cacheSet(url, dataUrl);
    return dataUrl;
  }

  /** 校验魔数后编码。非图片一律拒绝，宁可没有图也不要给模型喂垃圾。 */
  #encode(buf) {
    if (!buf.length) throw new Error('图片内容为空');
    if (buf.length > this.maxBytes) throw new Error(`图片 ${buf.length} 字节，超过上限 ${this.maxBytes}`);
    const mime = sniffImageMime(buf);
    if (!mime) throw new Error('不是可识别的图片格式（只支持 jpeg/png/gif/webp）');
    return toDataUrl(buf, mime);
  }

  async #download(url) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    this.#stats.fetches += 1;
    try {
      const res = await fetch(url, {
        signal: controller.signal,
        redirect: 'follow',
        headers: { 'User-Agent': 'qq-ai-bot/1.0', Accept: 'image/*' },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await readCapped(res, this.maxBytes);
    } catch (err) {
      if (err.name === 'AbortError') throw new Error(`下载图片超时（${this.timeoutMs}ms）`);
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * 取多条，返回可用的 data URL 数组。
   * 单张失败只记日志、不抛错 —— 一张图挂了不该让整条回复发不出去。
   */
  async fetchMany(urls, { max = this.maxImages } = {}) {
    if (!this.enabled || max <= 0) return [];
    const list = (Array.isArray(urls) ? urls : []).slice(0, max);
    const out = [];
    for (const url of list) {
      try {
        out.push(await this.fetchOne(url));
      } catch (err) {
        this.#stats.errors += 1;
        logger.warn(`图片获取失败（继续回复）：${err.message}`);
      }
    }
    return out;
  }
}
