import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const { ImageFetcher, sniffImageMime, toDataUrl } = await import('../src/vision.js');
const { DEFAULTS, deepMerge } = await import('../src/config.js');
const { logger } = await import('../src/logger.js');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'qqbot-vision-'));

function makeCfg(overrides = {}) {
  return deepMerge(DEFAULTS, overrides).vision;
}

/** 一个魔术字节像 PNG 的假图。我们不解码，只验魔数。 */
function fakePng(extra = 32) {
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.alloc(extra, 0x7a),
  ]);
}

const fakeJpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(24, 1)]);
const fakeGif = Buffer.concat([Buffer.from('GIF89a', 'latin1'), Buffer.alloc(16, 2)]);
const fakeWebp = Buffer.concat([
  Buffer.from('RIFF', 'latin1'),
  Buffer.alloc(4, 0),
  Buffer.from('WEBP', 'latin1'),
  Buffer.alloc(16, 3),
]);

/** 起一个本地 HTTP 服务，按需返回图片 / 错误 / 超长内容。 */
async function startImageServer(handler) {
  const state = { hits: 0, status: 200, body: fakePng(), headers: {}, delayMs: 0, contentType: 'image/png' };
  const server = http.createServer(async (req, res) => {
    state.hits += 1;
    if (handler) return handler(req, res, state);
    if (state.delayMs) await new Promise((r) => setTimeout(r, state.delayMs));
    res.writeHead(state.status, { 'Content-Type': state.contentType, ...state.headers });
    res.end(state.body);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  state.url = `http://127.0.0.1:${server.address().port}/pic`;
  state.close = () => new Promise((r) => server.close(r));
  return state;
}

// ---------------------------------------------------------------------------
// 魔数识别
// ---------------------------------------------------------------------------

test('sniffImageMime：只认魔术字节，认不出就返回空串', () => {
  assert.equal(sniffImageMime(fakePng()), 'image/png');
  assert.equal(sniffImageMime(fakeJpeg), 'image/jpeg');
  assert.equal(sniffImageMime(fakeGif), 'image/gif');
  assert.equal(sniffImageMime(fakeWebp), 'image/webp');

  // 假装是图的 HTML 错误页 —— 绝不认
  assert.equal(sniffImageMime(Buffer.from('<!DOCTYPE html><html>404</html>')), '');
  assert.equal(sniffImageMime(Buffer.alloc(0)), '');
  assert.equal(sniffImageMime(null), '');
  // 太短，连魔数都凑不齐
  assert.equal(sniffImageMime(Buffer.from([0x89, 0x50])), '');
});

test('toDataUrl：拼成模型能吃的 data URL', () => {
  const url = toDataUrl(fakePng(0), 'image/png');
  assert.ok(url.startsWith('data:image/png;base64,'));
  const b64 = url.slice('data:image/png;base64,'.length);
  assert.deepEqual(Buffer.from(b64, 'base64'), fakePng(0));
});

// ---------------------------------------------------------------------------
// 各种地址协议
// ---------------------------------------------------------------------------

test('fetchOne：http 图片下载成 data URL', async () => {
  const server = await startImageServer();
  const v = new ImageFetcher(makeCfg());
  try {
    const dataUrl = await v.fetchOne(server.url);
    assert.ok(dataUrl.startsWith('data:image/png;base64,'));
    assert.equal(server.hits, 1);
    assert.equal(v.stats().fetches, 1);
  } finally {
    await server.close();
  }
});

test('fetchOne：本地文件路径与 file:// 都能读', async () => {
  const file = path.join(tmpRoot, 'a.png');
  fs.writeFileSync(file, fakePng());
  const v = new ImageFetcher(makeCfg());

  assert.ok((await v.fetchOne(file)).startsWith('data:image/png;base64,'));
  // 换成 file:// 也要读得到（前面缓存过，清一下确保真的走了文件分支）
  v.clear();
  const asUrl = new URL(`file:///${file.replace(/\\/g, '/')}`).href;
  assert.ok((await v.fetchOne(asUrl)).startsWith('data:image/png;base64,'));
});

test('fetchOne：base64:// 与 data: 原样可用', async () => {
  const v = new ImageFetcher(makeCfg());
  const viaBase64 = await v.fetchOne(`base64://${fakePng().toString('base64')}`);
  assert.ok(viaBase64.startsWith('data:image/png;base64,'));

  const original = toDataUrl(fakeJpeg, 'image/jpeg');
  assert.equal(await v.fetchOne(original), original);
});

test('fetchOne：不认识 / 空的地址直接抛可读错误', async () => {
  const v = new ImageFetcher(makeCfg());
  await assert.rejects(() => v.fetchOne(''), /图片地址为空/);
  await assert.rejects(() => v.fetchOne('ftp://example.com/a.png'), /不认识的图片地址协议/);
  await assert.rejects(() => v.fetchOne('data:text/html;base64,AAAA'), /不是支持的图片类型/);
  await assert.rejects(() => v.fetchOne('base64://'), /图片内容为空/);
  await assert.rejects(() => v.fetchOne(path.join(tmpRoot, 'nope.png')), /本地图片不存在/);
});

// ---------------------------------------------------------------------------
// 拦截坏图：这些是"宁可没有图，也不要给模型喂垃圾"的防线
// ---------------------------------------------------------------------------

test('fetchOne：HTML 错误页即使自称 image/jpeg 也会被拒', async () => {
  const server = await startImageServer(async (req, res) => {
    res.writeHead(200, { 'Content-Type': 'image/jpeg' });
    res.end('<html><body>403 Forbidden</body></html>');
  });
  const v = new ImageFetcher(makeCfg());
  try {
    await assert.rejects(() => v.fetchOne(server.url), /不是可识别的图片格式/);
  } finally {
    await server.close();
  }
});

test('fetchOne：HTTP 非 2xx 报状态码', async () => {
  const server = await startImageServer();
  server.status = 403;
  const v = new ImageFetcher(makeCfg());
  try {
    await assert.rejects(() => v.fetchOne(server.url), /HTTP 403/);
  } finally {
    await server.close();
  }
});

test('fetchOne：content-length 超限时不下拉', async () => {
  const server = await startImageServer();
  server.headers = { 'Content-Length': String(50 * 1024 * 1024) };
  const v = new ImageFetcher(makeCfg({ vision: { maxBytes: 1024 } }));
  try {
    await assert.rejects(() => v.fetchOne(server.url), /超过上限/);
  } finally {
    await server.close();
  }
});

test('fetchOne：没有 content-length 时边读边数，超限立刻断开', async () => {
  const big = Buffer.concat([fakePng(0), Buffer.alloc(3 * 1024 * 1024, 9)]);
  const server = await startImageServer(async (req, res) => {
    res.writeHead(200, { 'Content-Type': 'image/png' }); // 不给 content-length
    res.end(big);
  });
  const v = new ImageFetcher(makeCfg({ vision: { maxBytes: 64 * 1024 } }));
  try {
    await assert.rejects(() => v.fetchOne(server.url), /超过上限/);
  } finally {
    await server.close();
  }
});

test('fetchOne：本地图片超过上限也被拒', async () => {
  const file = path.join(tmpRoot, 'big.png');
  fs.writeFileSync(file, Buffer.concat([fakePng(0), Buffer.alloc(200 * 1024, 5)]));
  const v = new ImageFetcher(makeCfg({ vision: { maxBytes: 1024 } }));
  await assert.rejects(() => v.fetchOne(file), /超过上限/);
});

test('fetchOne：下载超时抛出可读错误，不会挂死', async () => {
  const server = await startImageServer();
  server.delayMs = 3000;
  const v = new ImageFetcher(makeCfg({ vision: { timeoutMs: 150 } }));
  try {
    await assert.rejects(() => v.fetchOne(server.url), /下载图片超时（150ms）/);
  } finally {
    await server.close();
  }
});

// ---------------------------------------------------------------------------
// 缓存与批量
// ---------------------------------------------------------------------------

test('缓存：同一地址第二次不再下载；TTL 过期后重新下载', async () => {
  const server = await startImageServer();
  const v = new ImageFetcher(makeCfg({ vision: { cacheTtlMs: 40 } }));
  try {
    await v.fetchOne(server.url);
    await v.fetchOne(server.url);
    assert.equal(server.hits, 1, 'TTL 内应该命中缓存');
    assert.equal(v.stats().hits, 1);

    await new Promise((r) => setTimeout(r, 60));
    await v.fetchOne(server.url);
    assert.equal(server.hits, 2, 'TTL 过期后应该重新下载');
  } finally {
    await server.close();
  }
});

test('缓存：cacheTtlMs = 0 等于不缓存', async () => {
  const server = await startImageServer();
  const v = new ImageFetcher(makeCfg({ vision: { cacheTtlMs: 0 } }));
  try {
    await v.fetchOne(server.url);
    await v.fetchOne(server.url);
    assert.equal(server.hits, 2);
    assert.equal(v.stats().cached, 0);
  } finally {
    await server.close();
  }
});

test('缓存：超过 cacheMax 时淘汰最旧的', async () => {
  const server = await startImageServer();
  const v = new ImageFetcher(makeCfg({ vision: { cacheTtlMs: 60000, cacheMax: 2 } }));
  try {
    for (const n of ['a', 'b', 'c']) {
      await v.fetchOne(`${server.url}?n=${n}`);
    }
    assert.equal(v.stats().cached, 2);
  } finally {
    await server.close();
  }
});

test('fetchMany：单张失败只跳过，其他照常返回（一张图挂了不能拦整条回复）', async () => {
  const server = await startImageServer();
  const v = new ImageFetcher(makeCfg());
  const realWarn = logger.warn;
  const warned = [];
  logger.warn = (m) => warned.push(m);
  try {
    // max 显式给 3，否则默认 maxImages=2 只会试前两个
    const out = await v.fetchMany([server.url, 'data:text/html;base64,AAAA', 'ftp://x/y.png'], { max: 3 });
    assert.equal(out.length, 1);
    assert.ok(out[0].startsWith('data:image/png;base64,'));
    assert.equal(v.stats().errors, 2);
    assert.equal(warned.length, 2);
    assert.match(warned[0], /图片获取失败（继续回复）/);
  } finally {
    logger.warn = realWarn;
    await server.close();
  }
});

test('fetchMany：maxImages 限制条数；关掉 enabled 或 maxImages=0 时一张都不取', async () => {
  const server = await startImageServer();
  try {
    const limited = new ImageFetcher(makeCfg({ vision: { maxImages: 2 } }));
    const urls = [`${server.url}?a`, `${server.url}?b`, `${server.url}?c`];
    assert.equal((await limited.fetchMany(urls)).length, 2);

    const off = new ImageFetcher(makeCfg({ vision: { enabled: false } }));
    assert.equal(off.enabled, false);
    assert.deepEqual(await off.fetchMany(urls), []);

    const zero = new ImageFetcher(makeCfg({ vision: { maxImages: 0 } }));
    assert.equal(zero.maxImages, 0);
    assert.deepEqual(await zero.fetchMany(urls), []);

    assert.equal(server.hits, 2, '关掉的时候不该发起任何下载');
  } finally {
    await server.close();
  }
});

test('配置越界时退回默认值，不会把程序搞坏', () => {
  const v = new ImageFetcher({ maxImages: 'abc', maxBytes: -1, timeoutMs: 0, cacheTtlMs: -5 });
  assert.equal(v.maxImages, 0); // NaN → 视作不带图
  assert.equal(v.maxBytes, 5 * 1024 * 1024);
  assert.equal(v.timeoutMs, 10000);
  assert.equal(v.cacheTtlMs, 10 * 60 * 1000);
  assert.equal(v.enabled, true);
});

test('配置：vision 段的默认值就是保守的那套', () => {
  const d = DEFAULTS.vision;
  assert.equal(d.enabled, true);
  assert.equal(d.maxImages, 2);
  assert.equal(d.maxBytes, 5 * 1024 * 1024);
  assert.ok(d.timeoutMs > 0);
  assert.ok(d.cacheTtlMs > 0);
});
