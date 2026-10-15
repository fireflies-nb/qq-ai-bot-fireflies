import http from 'node:http';
import { logger } from './logger.js';

/**
 * 本地控制台：查看状态、热改白名单、暂停/恢复、测试 LLM。
 * 只监听 127.0.0.1，不对外网暴露。
 */
export function createControlServer({
  cfg, bot, store, llmTest, awareness = null, memory = null, vision = null,
}) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const json = (code, body) => {
      res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(body, null, 2));
    };

    const route = `${req.method} ${url.pathname}`;
    try {
      if (route === 'GET /api/status') {
        return json(200, {
          paused: bot.paused,
          pauseReason: bot.pauseReason,
          connected: bot.onebot.connected,
          selfId: bot.onebot.selfId,
          stats: bot.stats,
          // 最近几条回复的耗时构成。用户反馈过"怎么等了十二秒"，
          // 这里把「模型耗时」和「打字延迟」分开列出来 —— 两者解法完全不同。
          latency: {
            recent: bot.latency ?? [],
            last: bot.latency?.length ? bot.latency[bot.latency.length - 1] : null,
          },
          rate: bot.limiter.stats(),
          trigger: cfg.trigger,
          quietHours: cfg.quietHours,
          llm: { model: cfg.llm.model, baseUrl: cfg.llm.baseUrl, hasKey: Boolean(cfg.llm.apiKey) },
          logLevel: logger.level,
          awareness: awareness
            ? {
                enabled: awareness.enabled,
                timezone: awareness.timezone,
                location: awareness.location?.name ?? null,
                weatherEnabled: awareness.weatherEnabled,
                weather: awareness.weatherText || null,
                weatherAgeMs: awareness.weatherAgeMs,
                now: awareness.snapshot({}).slice(0, 1)[0] ?? null,
              }
            : null,
          memory: memory
            ? { enabled: memory.enabled, recall: memory.recallEnabled, extract: memory.extractEnabled, stats: memory.stats }
            : null,
          vision: vision
            ? { ...vision.stats(), maxImages: vision.maxImages, maxBytes: vision.maxBytes }
            : null,
        });
      }

      if (route === 'GET /api/memories') {
        const scope = url.searchParams.get('scope') ?? 'group';
        const id = url.searchParams.get('id') ?? '';
        if (!id) return json(400, { error: '缺少 id 参数' });
        const limit = Math.min(Number(url.searchParams.get('limit') ?? 50), 200);
        return json(200, {
          scope,
          id,
          total: store.countMemories(scope, id),
          memories: store.listMemories(scope, id, { limit }),
        });
      }

      if (route === 'GET /api/memories/search') {
        const scope = url.searchParams.get('scope') ?? 'group';
        const id = url.searchParams.get('id') ?? '';
        const q = url.searchParams.get('q') ?? '';
        if (!id) return json(400, { error: '缺少 id 参数' });
        if (!q) return json(400, { error: '缺少 q 参数' });
        // 走和回复时完全相同的检索路径，这样在这里看到什么，回复时就会想起什么。
        const found = memory
          ? memory.retrieve({ scope, scopeId: id, text: q, senderId: url.searchParams.get('sender') ?? '' })
          : [];
        return json(200, { scope, id, q, count: found.length, memories: found });
      }

      if (route === 'POST /api/memories') {
        const scope = url.searchParams.get('scope') ?? 'group';
        const id = url.searchParams.get('id') ?? '';
        const text = url.searchParams.get('text') ?? '';
        if (!id) return json(400, { error: '缺少 id 参数' });
        if (!text) return json(400, { error: '缺少 text 参数' });
        const saved = store.addMemory({
          scope,
          scopeId: id,
          subject: url.searchParams.get('subject') ?? 'other',
          text,
          kind: url.searchParams.get('kind') ?? 'fact',
        });
        if (!saved) return json(400, { error: '文本为空或只有标点，未写入' });
        return json(200, { ok: true, ...saved });
      }

      if (route === 'POST /api/memories/dedupe') {
        const scope = url.searchParams.get('scope') ?? 'private';
        const id = url.searchParams.get('id') ?? '';
        if (!id) return json(400, { error: '缺少 id 参数' });
        // 默认**只预览**：这个接口会删行，必须显式 apply=1 才动手。
        const apply = url.searchParams.get('apply') === '1';
        const res = store.dedupeMemories(scope, id, { dryRun: !apply });
        return json(200, {
          scope,
          id,
          applied: apply,
          total: res.total,
          merged: res.merged,
          kept: res.kept,
          groups: res.groups,
          hint: apply
            ? '已合并。再调一次 apply=1 应该返回 merged:0（幂等）。'
            : '这是预览，没有改库。确认无误后加 &apply=1 真正执行；建议先 npm run backup。',
        });
      }

      if (route === 'DELETE /api/memories') {
        const mid = Number(url.searchParams.get('memory_id') ?? '');
        if (!Number.isInteger(mid) || mid <= 0) return json(400, { error: '缺少有效的 memory_id 参数' });
        const removed = store.deleteMemory(mid);
        return json(200, { ok: true, removed });
      }

      if (route === 'POST /api/weather-refresh') {
        if (!awareness) return json(400, { error: '实时感知未启用' });
        return awareness
          .refreshWeather({ force: true })
          .then((text) => json(200, { ok: Boolean(text), weather: text || null }))
          .catch((e) => json(500, { ok: false, error: e.message }));
      }

      // 看图自检：给一个图片地址，看看能不能下载、识别格式、算出 data URL 大小。
      // 不调模型（不花钱），但能确认"图到底拿没拿到"这一段是通的。
      if (route === 'GET /api/vision/check') {
        if (!vision) return json(400, { error: '看图未启用（vision.enabled = false）' });
        const target = url.searchParams.get('url') ?? '';
        if (!target) return json(400, { error: '缺少 url 参数' });
        return vision
          .fetchOne(target)
          .then((dataUrl) =>
            json(200, {
              ok: true,
              mime: dataUrl.slice(5, dataUrl.indexOf(';')),
              bytes: dataUrl.length,
              preview: `${dataUrl.slice(0, 48)}…`,
            }),
          )
          .catch((e) => json(500, { ok: false, error: e.message }));
      }

      if (route === 'POST /api/pause') {
        bot.pause(url.searchParams.get('reason') ?? 'manual');
        return json(200, { ok: true, paused: true });
      }

      if (route === 'POST /api/resume') {
        bot.resume();
        return json(200, { ok: true, paused: false });
      }

      if (route === 'POST /api/group-whitelist') {
        const value = url.searchParams.get('id') ?? '';
        const op = url.searchParams.get('op') ?? 'add';
        if (!value) return json(400, { error: '缺少 id 参数' });
        const list = cfg.trigger.group.whitelist;
        if (op === 'add' && !list.some((x) => String(x) === value)) list.push(value);
        if (op === 'remove') cfg.trigger.group.whitelist = list.filter((x) => String(x) !== value);
        if (op === 'clear') cfg.trigger.group.whitelist = [];
        return json(200, { ok: true, whitelist: cfg.trigger.group.whitelist });
      }

      if (route === 'POST /api/private-whitelist') {
        const value = url.searchParams.get('id') ?? '';
        const op = url.searchParams.get('op') ?? 'add';
        if (!value) return json(400, { error: '缺少 id 参数' });
        const list = cfg.trigger.private.whitelist;
        if (op === 'add' && !list.some((x) => String(x) === value)) list.push(value);
        if (op === 'remove') cfg.trigger.private.whitelist = list.filter((x) => String(x) !== value);
        if (op === 'clear') cfg.trigger.private.whitelist = [];
        return json(200, { ok: true, whitelist: cfg.trigger.private.whitelist });
      }

      if (route === 'POST /api/private-enabled') {
        cfg.trigger.private.enabled = url.searchParams.get('enabled') !== 'false';
        return json(200, { ok: true, private: cfg.trigger.private });
      }

      if (route === 'POST /api/quiet-hours') {
        const enabled = url.searchParams.get('enabled');
        if (enabled !== null) cfg.quietHours.enabled = enabled !== 'false';
        const start = url.searchParams.get('start');
        const end = url.searchParams.get('end');
        if (start) cfg.quietHours.start = start;
        if (end) cfg.quietHours.end = end;
        return json(200, { ok: true, quietHours: cfg.quietHours });
      }

      if (route === 'POST /api/test-llm') {
        const prompt = url.searchParams.get('prompt') ?? '你好';
        return llmTest(prompt)
          .then((r) => json(200, { ok: true, reply: r.text, model: r.model, usage: r.usage }))
          .catch((e) => json(500, { ok: false, error: e.message }));
      }

      if (route === 'GET /api/history') {
        const scope = url.searchParams.get('scope') ?? 'group';
        const id = url.searchParams.get('id') ?? '';
        const limit = Math.min(Number(url.searchParams.get('limit') ?? 20), 100);
        if (!id) return json(400, { error: '缺少 id 参数' });
        return json(200, { scope, id, messages: store.recent(scope, id, limit) });
      }

      if (route === 'GET /' || route === 'GET /api') {
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end(HELP);
      }

      return json(404, { error: `未知接口：${route}` });
    } catch (err) {
      logger.error(`控制台接口异常：${err.message}`);
      return json(500, { error: err.message });
    }
  });

  server.listen(cfg.control.port, cfg.control.host, () => {
    // 用 server.address().port 而不是 cfg.control.port：配置成 0 时（测试里就是）
    // 真正的端口是系统分配的，照配置打印会写出"http://127.0.0.1:0/"这种误导信息。
    const actualPort = server.address()?.port ?? cfg.control.port;
    logger.info(`控制台已启动：http://${cfg.control.host}:${actualPort}/`);
  });
  server.on('error', (err) => {
    logger.error(`控制台启动失败（端口 ${cfg.control.port}）：${err.message}`);
  });
  return server;
}

const HELP = `QQ AI Bot 控制台

GET  /api/status                              查看运行状态
POST /api/pause                               暂停自动回复
POST /api/resume                              恢复自动回复
POST /api/group-whitelist?id=<群号>&op=add|remove|clear
POST /api/private-whitelist?id=<QQ号>&op=add|remove|clear
POST /api/private-enabled?enabled=true|false  开关私聊回复
POST /api/quiet-hours?enabled=true&start=23:30&end=07:30
POST /api/test-llm?prompt=你好                测试模型连通性
POST /api/weather-refresh                     立刻刷新天气（不等后台定时）
GET  /api/history?scope=group&id=<群号>&limit=20
GET  /api/memories?scope=group&id=<群号>&limit=50        列出长期记忆
GET  /api/memories/search?scope=group&id=<群号>&q=吉他     按回复时的同一套逻辑检索记忆
POST /api/memories?scope=group&id=<群号>&text=...&kind=fact&subject=other   手动记一条
POST /api/memories/dedupe?scope=private&id=<QQ号>          预览重复记忆合并（不改库）
POST /api/memories/dedupe?scope=private&id=<QQ号>&apply=1  真的合并（建议先 npm run backup）
DELETE /api/memories?memory_id=12             删掉一条记忆
`;
