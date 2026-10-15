/**
 * 冒烟测试：用 mock NapCat 起真实的 src/index.js，验证生产入口能跑通。
 * 用法：node scripts/smoke.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { MockOneBotServer, waitFor } from '../test/helpers/mock-ws-server.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qqbot-smoke-'));
const log = (...a) => console.log('[smoke]', ...a);

/** 借一个空闲端口：监听 0 拿到系统分配的口，然后立刻释放给子进程用。 */
async function freePort() {
  const srv = http.createServer();
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  await new Promise((r) => srv.close(r));
  return port;
}

// --- mock LLM ---
const llm = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    log(`LLM 收到请求 ${req.url}，model=${JSON.parse(body || '{}').model}`);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      choices: [{ message: { role: 'assistant', content: '在的在的，咋了' } }],
    }));
  });
});
await new Promise((r) => llm.listen(0, '127.0.0.1', r));
const llmUrl = `http://127.0.0.1:${llm.address().port}/v1`;

// --- mock NapCat ---
const napcat = new MockOneBotServer();
await napcat.listen(0);
napcat.onApi('get_login_info', () => ({ user_id: 10001, nickname: '小号' }));
napcat.onApi('get_status', () => ({ online: true, good: true }));

// --- 真实配置文件 ---
const ctlPort = await freePort();
fs.mkdirSync(path.join(tmp, 'config'), { recursive: true });
fs.writeFileSync(path.join(tmp, 'config', 'config.json'), JSON.stringify({
  onebot: { wsUrl: napcat.url },
  llm: { baseUrl: llmUrl, apiKey: 'smoke-key', model: 'deepseek-chat' },
  control: { enabled: true, host: '127.0.0.1', port: ctlPort },
  storage: { dbPath: './data/bot.db' },
  logLevel: 'info',
  rateLimit: { perSessionMinIntervalMs: 0, globalPerMinute: 100 },
  split: { delayMinMs: 0, delayMaxMs: 0 },
  // 打字延迟按真实时间等，冒烟里必须关掉，否则下面 waitForApi 的 8 秒会不够。
  typing: { enabled: false },
}, null, 2));

// 把真实入口复制到 tmp，让它用自己的 ROOT 解析 config/
fs.mkdirSync(path.join(tmp, 'src'), { recursive: true });
fs.cpSync(path.join(ROOT, 'src'), path.join(tmp, 'src'), { recursive: true });

const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(tmp, 'src', 'index.js')], {
  cwd: tmp,
  stdio: ['ignore', 'pipe', 'pipe'],
});
let stdout = '';
child.stdout.on('data', (d) => { stdout += d; });
child.stderr.on('data', (d) => { stdout += d; });

let failed = 0;
const check = (name, cond, extra = '') => {
  console.log(`${cond ? '  PASS' : '  FAIL'}  ${name}${extra ? ` — ${extra}` : ''}`);
  if (!cond) failed += 1;
};

try {
  await waitFor(() => napcat.sockets.size > 0, { timeoutMs: 8000 });
  check('index.js 已连上 NapCat 的 WebSocket', true);
  await waitFor(() => stdout.includes('已登录账号'), { timeoutMs: 8000 });
  check('get_login_info 握手成功', true);

  // 控制台 API（等端口真正监听上；waitFor 是同步判定，async 断言需自己轮询）
  const ctlBase = `http://127.0.0.1:${ctlPort}`;
  let ctlUp = false;
  for (let i = 0; i < 80 && !ctlUp; i += 1) {
    try {
      ctlUp = (await fetch(`${ctlBase}/api/status`)).ok;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  check('控制台端口已监听', ctlUp);
  const status = await fetch(`${ctlBase}/api/status`).then((r) => r.json());
  check('控制台 /api/status 可访问', status.connected === true, `paused=${status.paused}`);

  // 群 @ 消息 → 回复
  napcat.push({
    post_type: 'message', message_type: 'group', sub_type: 'normal', message_id: 1,
    group_id: 555, user_id: 777, self_id: 10001,
    message: [{ type: 'at', data: { qq: '10001', name: '我' } }, { type: 'text', data: { text: '在吗' } }],
    raw_message: '在吗', sender: { user_id: 777, nickname: '小明' }, time: Math.floor(Date.now() / 1000),
  });
  const call = await napcat.waitForApi('send_group_msg', { timeoutMs: 8000 });
  check('群 @ 消息触发了回复', call.params.message === '在的在的，咋了', `实际="${call.params.message}"`);

  // 停服流程
  const paused = await fetch(`${ctlBase}/api/pause`, { method: 'POST' }).then((r) => r.json());
  check('/api/pause 生效', paused.paused === true);

  const hist = await fetch(`${ctlBase}/api/history?scope=group&id=555&limit=5`).then((r) => r.json());
  check('历史已落库', hist.messages.length === 2, `${hist.messages.length} 条`);

  // Windows 上 child.kill() 等价于 TerminateProcess，进程会以 signalCode='SIGTERM'
  // 结束而 exitCode 保持 null —— 两者有一个非 null 就说明进程已经退出了。
  // （真实使用时按 Ctrl+C 走的是 SIGINT 分支，由 index.js 的处理器负责优雅关闭。）
  child.kill();
  await waitFor(() => child.exitCode !== null || child.signalCode !== null, { timeoutMs: 5000 }).catch(() => {});
  const stopped = child.exitCode !== null || child.signalCode !== null;
  check('进程可被终止', stopped, `exitCode=${child.exitCode} signal=${child.signalCode}`);
} catch (err) {
  failed += 1;
  console.log(`  FAIL  冒烟流程异常：${err.message}`);
  console.log('--- 子进程输出 ---\n' + stdout);
} finally {
  child.kill();
  await napcat.close();
  await new Promise((r) => llm.close(r));
}

console.log(failed === 0 ? '\n[smoke] 全部通过 ✅' : `\n[smoke] ${failed} 项失败 ❌`);
process.exit(failed === 0 ? 0 : 1);
