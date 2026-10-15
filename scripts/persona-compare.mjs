// 人设对比工具：同一个场景，分别用「旧人设」和「当前人设」问一次模型，并排看差异。
//
//   node scripts/persona-compare.mjs                            # git HEAD 的人设 vs 现在的人设
//   node scripts/persona-compare.mjs --base HEAD~1              # 跟更早的版本比
//   node scripts/persona-compare.mjs --base 7d1de68             # 跟某个提交比
//   node scripts/persona-compare.mjs --file a.md --file b.md    # 对比任意两个人设文件
//
// 为什么要有这个脚本（ROADMAP 坑 5）：
// 调人设时最危险的失败模式是「为了压长度 / 压 AI 味，把对方说的话丢了」——
// 单看一条输出看不出来，必须同一个场景跑两版对照，才看得见是不是没接住话。
// 而且模型有随机性（同一场景两次能差一倍长度），所以要看趋势和「有没有接住话题」，
// 不要凭单次结果下结论。
//
// ⚠️ 注意：**改完人设提交之前**跑默认模式才有对照意义；提交之后 HEAD 就等于当前人设了，
//    那时候要用 --base <上一个提交> 才比得出差异。
//
// 用的是 config/config.json 里的真实 API key，会花钱（一个场景两次调用，很便宜）。
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// ---- 读取配置（拿 key 和 model） ----
const cfgPath = path.join(ROOT, 'config', 'config.json');
if (!fs.existsSync(cfgPath)) {
  console.error(`找不到 ${cfgPath}，先把 config.example.json 复制一份并填好 apiKey。`);
  process.exit(1);
}
const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
if (!cfg.llm?.apiKey || !String(cfg.llm.apiKey).startsWith('sk-')) {
  console.error('config/config.json 里的 llm.apiKey 看起来没填。');
  process.exit(1);
}

const strip = (raw) => raw.replace(/<!--[\s\S]*?-->/g, '').trim();

// ---- 决定要比哪两个人设 ----
const fileArgs = process.argv.reduce((acc, a, i, arr) => {
  if (a === '--file' && arr[i + 1]) acc.push(arr[i + 1]);
  return acc;
}, []);
const baseIdx = process.argv.indexOf('--base');
const baseRef = baseIdx >= 0 && process.argv[baseIdx + 1] ? process.argv[baseIdx + 1] : 'HEAD';

let A; // 旧
let B; // 新
if (fileArgs.length >= 2) {
  A = { label: `文件 ${fileArgs[0]}`, text: strip(fs.readFileSync(path.resolve(ROOT, fileArgs[0]), 'utf8')) };
  B = { label: `文件 ${fileArgs[1]}`, text: strip(fs.readFileSync(path.resolve(ROOT, fileArgs[1]), 'utf8')) };
} else {
  // 默认：某个提交里的人设 = 旧；工作区现用的人设 = 新
  let headPersona;
  try {
    headPersona = execFileSync('git', ['show', `${baseRef}:config/persona.example.md`], { cwd: ROOT, encoding: 'utf8' });
  } catch {
    console.error(`git 里读不到 ${baseRef}:config/persona.example.md（换个 --base，或用 --file 指定两个文件）。`);
    process.exit(1);
  }
  const livePath = path.join(ROOT, 'config', 'persona.md');
  if (!fs.existsSync(livePath)) {
    console.error(`找不到 ${livePath}（当前生效的人设）。`);
    process.exit(1);
  }
  A = { label: `【旧】${baseRef} 的人设`, text: strip(headPersona) };
  B = { label: '【新】config/persona.md', text: strip(fs.readFileSync(livePath, 'utf8')) };
  if (A.text === B.text) {
    console.log(`⚠️  ${baseRef} 的人设和当前 config/persona.md 完全一样，比不出差异。`);
    console.log('    改完人设要在提交前跑；已经提交了就用 --base HEAD~1 指向上一个版本。\n');
  }
}

console.log(`${A.label}：${A.text.length} 字符`);
console.log(`${B.label}：${B.text.length} 字符`);
console.log(`模型：${cfg.llm.model} / temperature=${cfg.llm.temperature}\n`);

// ---- 场景 ----
// 每个场景固定配一段「当前场合」和感知数据，模拟真实请求里的拼法。
const OWNER_CTX =
  '当前场合：你正在和你的「开拓者」私聊——他是你最在意的人，也是这个 QQ 号的主人。这里没有外人。\n' +
  '私聊里可以放松一些，语气更亲近、更温柔，可以问问他最近怎么样、也可以主动讲讲你自己的想法。' +
  '但"亲近"不等于"话多"：这里的分寸是短句、一次只讲一件事，想说的多就分成几条短的发，而不是把一段话写长。';
const GROUP_CTX =
  '当前场合：你正在 QQ 群（群号 200000001）里被一位群友 @ 到。这个人是群里的普通成员，不是开拓者，你也不认识他。\n' +
  '对待他的方式：保持你一贯的温和有礼，但要守住分寸——像对待一位路上遇到的旅人，友善、客气、话不多。\n' +
  '只回应当前 @ 你的这一个人，不要回应群里其他人。回复一两句就够。';

const SENSES =
  '\n\n你此刻的感知（真实信息，可以自然地说到）：\n' +
  '- 现在是 2026年10月14日 星期三 深夜 23:47（秋天）\n' +
  '- 杭州 现在 18.2°C，晴，湿度 71%，风 5.1km/h';

const SCENES = [
  {
    name: '① 明确说不困（不能继续催睡）',
    ctx: OWNER_CTX,
    turns: [{ role: 'user', text: '我还不困，先不睡' }],
  },
  {
    name: '② 深夜闲聊（该短）',
    ctx: OWNER_CTX,
    turns: [{ role: 'user', text: '在干嘛' }],
  },
  {
    name: '③ 心情不好（第一句必须接到"累"）',
    ctx: OWNER_CTX,
    turns: [{ role: 'user', text: '今天有点累' }],
  },
  {
    name: '④ 多轮：说了不困之后还在聊',
    ctx: OWNER_CTX,
    turns: [
      { role: 'user', text: '我还不困，先不睡' },
      { role: 'assistant', text: '嗯，那就不睡。我陪你一会儿。' },
      { role: 'user', text: '嗯，在弄点东西' },
    ],
  },
  {
    name: '⑤ 群聊：普通群友问天气（不该被改坏）',
    ctx: GROUP_CTX,
    turns: [{ role: 'user', text: '今天天气怎么样' }],
  },
  {
    name: '⑥ 深聊：会不会害怕死（这里该允许一点诗意）',
    ctx: OWNER_CTX,
    turns: [{ role: 'user', text: '你会害怕死吗' }],
  },
  {
    name: '⑦ 对方说了句心里话（绝对不能被当成寒暄绕开）',
    ctx: OWNER_CTX,
    turns: [{ role: 'user', text: '我想你了' }],
  },
];

function buildSystem(persona, ctx) {
  return (
    persona +
    '\n\n' +
    ctx +
    SENSES +
    '\n\n只输出你要发出去的消息正文，不要任何前缀、引号、解释或多余格式。'
  );
}

async function ask(persona, scene) {
  const messages = [{ role: 'system', content: buildSystem(persona, scene.ctx) }];
  for (const t of scene.turns) messages.push({ role: t.role, content: t.text });
  const res = await fetch(`${String(cfg.llm.baseUrl).replace(/\/+$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.llm.apiKey}` },
    body: JSON.stringify({
      model: cfg.llm.model,
      messages,
      temperature: cfg.llm.temperature,
      max_tokens: Number(cfg.llm.maxTokens) || 800,
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`HTTP ${res.status}：${JSON.stringify(body).slice(0, 200)}`);
  return String(body.choices?.[0]?.message?.content ?? '').trim();
}

function stats(text) {
  const clean = text.replace(/\s+/g, '');
  const sentences = text.split(/[。！？!?…~]+/).filter((s) => s.trim());
  const lens = sentences.map((s) => s.trim().length);
  return {
    字数: clean.length,
    句号: (text.match(/。/g) || []).length,
    平均句长: lens.length ? Math.round(lens.reduce((a, b) => a + b, 0) / lens.length) : 0,
    超20字句: lens.filter((n) => n > 20).length,
    省略号: (text.match(/…/g) || []).length,
    感叹号: (text.match(/[！!]/g) || []).length,
    波浪号: (text.match(/~/g) || []).length,
  };
}

const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const DIM = '\x1b[2m';
const OFF = '\x1b[0m';

for (const scene of SCENES) {
  console.log('='.repeat(72));
  console.log(scene.name);
  console.log('='.repeat(72));
  for (const side of [A, B]) {
    try {
      const out = await ask(side.text, scene);
      const s = stats(out);
      const meta = Object.entries(s).map(([k, v]) => `${k}${v}`).join(' ');
      console.log(`\n${side.label}  ${DIM}${meta}${OFF}`);
      console.log(out.replace(/\n/g, ' ⏎ '));
    } catch (err) {
      console.log(`${RED}${side.label} 失败：${err.message}${OFF}`);
    }
  }
  console.log();
}

console.log(`${GREEN}看什么${OFF}：`);
console.log('  ① 对方那句话有没有被正面接住（这是最要紧的，比长短重要）');
console.log('  ② 日常闲聊是否够短、够像打字；重的话题是否允许 2～3 句');
console.log('  ③ 群聊那条不能被改坏（应该短、客气、不带开拓者专属的东西）');
console.log(`  ${DIM}模型有随机性，同一场景两次长度可能差一倍，看趋势不要看单次。${OFF}`);
