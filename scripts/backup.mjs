/**
 * 备份记忆数据库。
 *
 * 为什么不用 Copy-Item 直接复制 bot.db：
 * 数据库开了 WAL 模式，正在写入时 bot.db 里可能还缺还没合并的数据，
 * 单独复制这一个文件有可能拿到不完整甚至损坏的库。
 * 这里用 SQLite 的 `VACUUM INTO`，它由数据库自己产出一份**一致快照**，
 * 而且 bot 正在运行时也能安全执行。
 *
 * 用法：
 *   npm run backup                  # 备份到 data/backups/bot-<日期时间>.db
 *   npm run backup -- --keep 10     # 只保留最近 10 份
 */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ROOT } from '../src/config.js';

const args = process.argv.slice(2);
const keepArg = args.indexOf('--keep');
const keep = keepArg >= 0 ? Number(args[keepArg + 1]) : 20;

const dbPath = path.join(ROOT, 'data', 'bot.db');
if (!fs.existsSync(dbPath)) {
  console.error(`找不到数据库：${dbPath}`);
  console.error('（还没跑过 bot 的话是正常的，先启动一次让它建库）');
  process.exit(1);
}

const dir = path.join(ROOT, 'data', 'backups');
fs.mkdirSync(dir, { recursive: true });

const stamp = new Date()
  .toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai' })
  .replace(/[-: ]/g, '')
  .slice(0, 14);
const out = path.join(dir, `bot-${stamp}.db`);

const db = new DatabaseSync(dbPath, { readOnly: true });
try {
  // VACUUM INTO 不接受已存在的目标文件
  if (fs.existsSync(out)) fs.rmSync(out, { force: true });
  db.exec(`VACUUM INTO '${out.replace(/'/g, "''")}'`);
} finally {
  db.close();
}

const size = fs.statSync(out).size;
console.log(`已备份：${out}`);
console.log(`大小：${(size / 1024).toFixed(1)} KB`);

// 顺手清理旧备份，只留最近 keep 份
const files = fs
  .readdirSync(dir)
  .filter((f) => /^bot-\d{14}\.db$/.test(f))
  .sort()
  .reverse();
for (const f of files.slice(keep)) {
  fs.rmSync(path.join(dir, f), { force: true });
  console.log(`已清理旧备份：${f}`);
}
console.log(`当前保留 ${Math.min(files.length, keep)} 份备份。`);
