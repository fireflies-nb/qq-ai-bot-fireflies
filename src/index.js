#!/usr/bin/env node
import process from 'node:process';
import { loadConfig, validateConfig } from './config.js';
import { logger } from './logger.js';
import { Store } from './store.js';
import { OneBot } from './onebot.js';
import { Bot } from './bot.js';
import { createControlServer } from './control.js';
import { buildMessages, buildSystemPrompt, chatCompletion, createLlmClient, llmReady } from './llm.js';
import { Awareness } from './awareness.js';
import { MemoryManager } from './memory.js';
import { ImageFetcher } from './vision.js';

async function main() {
  let cfg;
  try {
    cfg = loadConfig();
  } catch (err) {
    console.error(`\n[配置错误] ${err.message}\n`);
    process.exit(1);
  }
  logger.setLevel(cfg.logLevel ?? 'info');

  const { errors, warnings } = validateConfig(cfg);
  for (const w of warnings) logger.warn(w);
  if (errors.length) {
    for (const e of errors) logger.error(e);
    process.exit(1);
  }

  const store = new Store(cfg.storage.dbPath, { retentionDays: cfg.storage.retentionDays });
  store.prune();

  const onebot = new OneBot(cfg);
  // 实时感知（时间/天气）：后台定时刷天气，回复时只读缓存。
  const awareness = new Awareness(cfg);
  awareness.start();
  // 长期记忆：抽取走独立的 llm client，超时和温度都和主对话分开。
  const memory = new MemoryManager({ cfg, store, llm: createLlmClient(cfg.llm) });
  // 看图：把消息里的图片下载成 data URL 再交给多模态模型。
  const vision = new ImageFetcher(cfg.vision);
  const bot = new Bot({ cfg, store, onebot, awareness, memory, vision }).attach();

  onebot.on('close', () => logger.warn('已与 NapCat 断开，等待自动重连…'));
  logger.info(
    `实时感知：${awareness.enabled ? '开' : '关'}` +
      `（天气 ${awareness.weatherEnabled ? '开' : '关'}，${cfg.awareness.location?.name ?? '未设地点'}）` +
      `；长期记忆：${memory.enabled ? '开' : '关'}` +
      `；看图：${vision.enabled && vision.maxImages > 0 ? `开（每条最多 ${vision.maxImages} 张）` : '关'}` +
      `；「正在输入」提示：${cfg.inputStatus?.enabled === false ? '关' : '开（仅私聊）'}`,
  );

  const llmTest = async (prompt) => {
    if (!llmReady(cfg.llm)) throw new Error('llm.apiKey 未配置');
    const messages = buildMessages(
      // 自测时按"号主本人在私聊"来组装 prompt：这是你调人设、看语气用的，
      // 应该看到流萤对开拓者说话的样子，而不是对陌生人说话的样子。
      // 也带上真实的感知，这样点一下就能看出她知不知道现在几点、外面什么天气。
      buildSystemPrompt(cfg, { isGroup: false, isOwner: true, environment: awareness.snapshot({}) }),
      [{ role: 'user', sender: '测试', text: prompt }],
    );
    return chatCompletion(cfg.llm, messages);
  };

  let controlServer = null;
  if (cfg.control?.enabled) {
    controlServer = createControlServer({ cfg, bot, store, llmTest, awareness, memory, vision });
  }

  onebot.connect();

  // 天气不能等第一条消息才去取（那样第一次回复要多等 1 秒），启动就先拉一次。
  // 失败也没关系：refreshWeather 内部只打日志，snapshot 会跳过天气那一行。
  awareness.refreshWeather().catch(() => {});

  // 定时清理历史
  const pruneTimer = setInterval(() => store.prune(), 6 * 3600_000);
  pruneTimer.unref?.();

  logger.info('机器人已启动。按 Ctrl+C 退出。');

  const shutdown = (sig) => {
    logger.info(`收到 ${sig}，正在退出…`);
    try {
      controlServer?.close();
    } catch {
      /* ignore */
    }
    onebot.close();
    awareness.stop();
    store.close();
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('unhandledRejection', (err) => {
    logger.error(`未处理的 Promise 异常：${err?.stack ?? err}`);
  });
}

main();
