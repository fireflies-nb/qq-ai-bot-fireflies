/**
 * 清理已有的重复记忆。
 *
 * 为什么需要单独一个命令：
 * 「近似合并」只在**新写的记忆**入库时生效（store.addMemory 里那道），
 * 而库里早就堆积的重复是历史遗留 —— 抽取器以前没有"已有清单"可看，
 * 换个说法就会重新记一条。程序不会自己去改你的库，所以要你手动跑一次。
 *
 * 安全设计：
 *  - 默认是 **dryRun**，只报告不落库。看清楚了再加 --apply。
 *  - 合并**不会删信息**：同一件事的多个说法压成一条，hits 累加到保留的那条。
 *  - 用锚点式聚类而不是并查集，避免通过一条"同时提到两件事"的复合记忆
 *    把两个不同的事实串成一组删掉。
 *  - 不同 subject 之间绝不互相合并。
 *  - 跑之前强烈建议先 `npm run backup`。
 *
 * 用法：
 *   npm run dedupe                          # 预览（不落库）
 *   npm run dedupe -- --apply               # 真的合并
 *   npm run dedupe -- --scope private --id 2000000001
 *   npm run dedupe -- --scope group --id 200000001 --apply
 *   npm run dedupe -- --all --apply         # 库里所有会话
 */
import path from 'node:path';
import { Store } from '../src/store.js';
import { ROOT } from '../src/config.js';

const args = process.argv.slice(2);
const has = (flag) => args.includes(flag);
const val = (flag, dflt = null) => {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
};

const apply = has('--apply');
const all = has('--all');
const scope = val('--scope', 'private');
const scopeId = val('--id', null);
const dbPath = val('--db', path.join(ROOT, 'data', 'bot.db'));

const store = new Store(dbPath, { retentionDays: 30 });

// 找出要处理哪些会话
let targets;
if (all) {
  targets = store.listSessions().map((s) => ({ scope: s.scope, scopeId: s.scopeId }));
  if (!targets.length) {
    console.log('库里还没有任何会话。');
    process.exit(0);
  }
} else {
  if (!scopeId) {
    console.error('缺少 --id（会话号）。想知道有哪些会话，用 --all 或不带参数看提示。');
    console.error('');
    console.error('  实际库里的会话：');
    for (const s of store.listSessions()) {
      console.error(`    --scope ${s.scope} --id ${s.scopeId}   （记忆 ${s.memories} 条 / 消息 ${s.messages} 条）`);
    }
    process.exit(1);
  }
  targets = [{ scope, scopeId }];
}

console.log(apply ? '模式：真的合并（--apply）' : '模式：预览（dryRun，不改库）。确认无误后加 --apply');
if (apply) console.log('提示：如果还没备份，现在 Ctrl+C 停下来先跑 `npm run backup`。');
console.log('');

let totalBefore = 0;
let totalAfter = 0;
let totalMerged = 0;

for (const t of targets) {
  const before = store.countMemories(t.scope, t.scopeId);
  const res = store.dedupeMemories(t.scope, t.scopeId, { dryRun: !apply });
  totalBefore += res.total;
  totalAfter += res.kept;
  totalMerged += res.merged;

  console.log(`【${t.scope}:${t.scopeId}】记忆 ${before} 条 → ${apply ? res.kept : `${res.kept}（预览）`}`);
  if (!res.groups.length) {
    console.log('  没有发现重复。\n');
    continue;
  }
  for (const g of res.groups) {
    console.log(`  保留 #${g.keep}：${g.keepText}${g.addedHits ? `（hits +${g.addedHits}）` : ''}`);
    for (const mt of g.mergedTexts) console.log(`    并入：${mt}`);
  }
  console.log('');
}

console.log('──────────────────────────────');
console.log(`共 ${totalBefore} 条，${apply ? '合并' : '可合并'} ${totalMerged} 条，剩 ${totalAfter} 条。`);
if (!apply && totalMerged) {
  console.log('');
  console.log('确认这些"并入"的都是同一件事，再加 --apply 真正执行。');
  console.log('拿不准就先 `npm run backup` —— 合并是不可逆的（但不会丢信息，只是把说法收拢）。');
}
if (apply) {
  // 二次执行应该是 0，用来确认幂等
  let leftover = 0;
  for (const t of targets) leftover += store.dedupeMemories(t.scope, t.scopeId, { dryRun: true }).merged;
  console.log(leftover === 0 ? '已确认：再跑一次无可合并项（幂等）。' : `注意：还剩 ${leftover} 条可合并，可能被 limit 截断了。`);
}
store.close();
