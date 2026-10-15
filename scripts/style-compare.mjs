// 说话风格对比工具：同一个场景，真调 DeepSeek 生成回复，再走一遍「清洗 → 分段」，
// 把「句号数 / 换行数 / 气泡数 / 每泡字数」摊开来看。
//
//   node --disable-warning=ExperimentalWarning scripts/style-compare.mjs
//   node --disable-warning=ExperimentalWarning scripts/style-compare.mjs --ref HEAD   # 跟提交版比
//   node --disable-warning=ExperimentalWarning scripts/style-compare.mjs --only 天气   # 只跑匹配的场景
//
// 为什么要有这个脚本：
// 这次「说话风格」改造的目标是**减少句号、增加气泡分段、缩短长度**，
// 而这三件事全都发生在「模型输出之后」——cleanReply / splitReply / buildMessages 各管一段。
// 光看模型吐出来的原文看不出改造效果：真正决定对方看到几条消息的是 splitReply，
// 真正决定句号还在不在的是 cleanReply 有没有把换行留下。所以这里必须
// **原文 → cleanReply → splitReply** 完整走一遍，两头都要看。
//
// ⚠️ 模型有随机性，所以每个场景跑 2 次。单次结果不算数，看两次的一致趋势。
//
// ---- 关于 --ref（对比模式）----
// 给了 --ref 就 `git show <ref>:src/xxx.js` 把旧版源码写到系统临时目录，
// 两边各自 import 自己的 src/，于是「改造前 vs 改造后」可以并排看。
//
// 但这里有个**天生的限制**：--ref 那一边的 buildMessages 有 tidyAssistant 就调、
// 没有就当没有，所以只能在**当前版**这一侧做「句号→换行」的模拟；
// 旧版一侧永远显示它的真实行为。
//
// 降级说明（脚本必须能跑在当前工作区上，不管改造落盘没有）：
//   ① --ref 缺省时只测当前工作区版本，不做对比；
//   ② tidySelfText 不存在 → 跳过「自身话清洗」那一栏并注明；
//   ③ splitReply 不支持 bubbleOnNewline → 退回 maxLength/maxSegments 老路径并注明；
//   ④ buildMessages 不认 tidyAssistant → 按老签名调用并注明。
// 这四种情况都会在输出里用 ⚠️ 标出来，不会直接崩。
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// ---- 读取配置（拿 key 和 model；key 只用来发请求，绝不打印） ----
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

// ---- 命令行参数 ----
const argv = process.argv.slice(2);
function argOf(flag) {
  const i = argv.indexOf(flag);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : null;
}
const refArg = argOf('--ref');
const onlyArg = argOf('--only');

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
  '- 现在是 2026年10月15日 星期四 午后 12:50（秋天）\n' +
  '- 杭州 现在 21.4°C，多云，湿度 68%，风 4.2km/h';

/** 这次对话里她「方才自己说过的话」——用来验 tidySelfText / buildMessages 的清洗。 */
const SELF_TEXTS = [
  '嗯，我在的。刚才在整理书桌，翻出来一张旧车票。',
  '你那边今天冷不冷？出门记得多加一件。',
  '好，那我等你回来。',
];

// splitReply 的参数：群聊按 config.split.maxLength/maxSegments，私聊按 private*。
function splitOpts(isGroup) {
  const s = cfg.split ?? {};
  return isGroup
    ? { maxLength: Number(s.maxLength) || 90, maxSegments: Number(s.maxSegments) || 3 }
    : {
        maxLength: Number(s.privateMaxLength ?? s.maxLength) || 45,
        maxSegments: Math.max(Number(s.maxSegments) || 3, Number(s.privateMaxSegments ?? s.maxSegments) || 3),
      };
}

const SCENES = [
  { name: '① 日常闲聊', user: '午好呀萤宝', isGroup: false, ctx: OWNER_CTX },
  { name: '② 对方说累', user: '今天有点累', isGroup: false, ctx: OWNER_CTX },
  { name: '③ 情感重话', user: '我想你了', isGroup: false, ctx: OWNER_CTX },
  { name: '④ 深话题', user: '你会害怕死吗', isGroup: false, ctx: OWNER_CTX },
  { name: '⑤ 群聊普通群友', user: '今天天气怎么样', isGroup: true, ctx: GROUP_CTX },
  { name: '⑥ 长回复诱导', user: '跟我讲讲你以前的事', isGroup: false, ctx: OWNER_CTX },
];

// ---- 旧版源码：git show 到系统临时目录，再 import 那一份 ----
// （临时目录用 os.tmpdir()，脚本退出时删掉，不在工作区留垃圾。）
let tmpDir = null;
function cleanup() {
  if (tmpDir) {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* 删不掉就算了，系统临时目录会自己清 */
    }
    tmpDir = null;
  }
}
process.on('exit', cleanup);

/**
 * 把某个 git ref 的 src/*.js 落盘到临时目录，返回可 import 的模块集合。
 * 用 src/config.js 里的 ROOT 推出项目根，这样旧版 src 也能自己找到 config/。
 * 拿不到的那几个文件不算致命：风格改造只碰 bot/segments/llm，缺了就退化成「没有对比」。
 */
async function loadFromRef(ref) {
  const prefix = `${ref}:src/`;
  let listing;
  try {
    listing = execFileSync('git', ['ls-tree', '--name-only', ref, 'src/'], { cwd: ROOT, encoding: 'utf8' });
  } catch (err) {
    throw new Error(`git 读不到 ${ref}（${String(err.message).split('\n')[0]}）`);
  }
  const names = listing
    .split('\n')
    .map((s) => s.trim())
    .filter((s) => s.startsWith('src/') && s.endsWith('.js'));
  if (!names.length) throw new Error(`${ref} 里没有 src/*.js`);

  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'style-compare-'));
  const srcDir = path.join(tmpDir, 'src');
  fs.mkdirSync(srcDir, { recursive: true });
  for (const n of names) {
    const body = execFileSync('git', ['show', `${prefix}${path.basename(n)}`], { cwd: ROOT, encoding: 'utf8' });
    // 旧版的 src/config.js 里的 ROOT 会指到临时目录，它得能找到 config/ 和人设文件，
    // 所以根目录建一个软链接指回真项目根（Windows 上目录软链要权限，退化成复制两个文件）。
    fs.writeFileSync(path.join(srcDir, path.basename(n)), body, 'utf8');
  }
  const cfgDir = path.join(tmpDir, 'config');
  fs.mkdirSync(cfgDir, { recursive: true });
  for (const f of ['config.json', 'persona.md']) {
    const from = path.join(ROOT, 'config', f);
    if (!fs.existsSync(from)) continue;
    try {
      fs.linkSync(from, path.join(cfgDir, f));
    } catch {
      fs.copyFileSync(from, path.join(cfgDir, f));
    }
  }

  const load = async (name) => {
    const p = path.join(srcDir, name);
    if (!fs.existsSync(p)) return null;
    try {
      return await import(pathToFileURL(p).href);
    } catch (err) {
      console.log(`⚠️  ${ref} 的 src/${name} 导入失败（这一栏跳过）：${err.message}`);
      return null;
    }
  };
  return {
    label: `${ref}`,
    bot: await load('bot.js'),
    segments: await load('segments.js'),
    llm: await load('llm.js'),
    config: await load('config.js'),
  };
}

/**
 * 列出 ref 与当前工作区相比改过的 src/*.js（git diff --name-only）。
 * git 用不了就返回 null，调用方自己决定要不要提示。
 *
 * 为什么不拿 system prompt 比对：人设文件 config/persona.md 是两个版本共用的，
 * 哪怕 src/ 里三个文件全改了，拼出来的 system prompt 也可能一字不差 ——
 * 第一版就是这么写的，结果明明改了却报「完全一样，比不出差异」。直接比源码才靠谱。
 */
function changedFiles(ref) {
  try {
    const out = execFileSync('git', ['diff', '--name-only', ref, '--', 'src/'], {
      cwd: ROOT,
      encoding: 'utf8',
    });
    return out
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => path.basename(s));
  } catch {
    return null;
  }
}

/** 当前工作区的版本。同样逐个文件 try，缺了就退化成 null。 */
async function loadLive() {
  const load = async (name) => {
    const p = path.join(ROOT, 'src', name);
    if (!fs.existsSync(p)) return null;
    try {
      return await import(pathToFileURL(p).href);
    } catch (err) {
      console.log(`⚠️  当前 src/${name} 导入失败：${err.message}`);
      return null;
    }
  };
  return {
    label: '当前工作区',
    bot: await load('bot.js'),
    segments: await load('segments.js'),
    llm: await load('llm.js'),
    config: await load('config.js'),
  };
}

// ---- 人设与 system prompt ----
function liveConfig() {
  return { ...cfg, persona: { ...(cfg.persona ?? {}), systemPromptText: personaText } };
}
let personaText = '';
{
  const f = path.join(ROOT, 'config', 'persona.md');
  if (fs.existsSync(f)) personaText = fs.readFileSync(f, 'utf8').replace(/<!--[\s\S]*?-->/g, '').trim();
  if (!personaText) {
    console.log('⚠️  config/persona.md 读不到，退回 persona.description/style 简版。');
  }
}

/**
 * 用**目标版本自己的** buildSystemPrompt 拼 system prompt —— 这样如果改造顺手改了
 * 人设里的措辞（比如加了"不要句号"），对比里也看得见。
 * 拿不到 buildSystemPrompt 就手动拼一个近似的。
 */
function systemFor(side, scene, cfgObj) {
  const c = side.config?.loadConfig ? safeLoad(side, cfgObj) : cfgObj;
  if (side.llm?.buildSystemPrompt) {
    return side.llm.buildSystemPrompt(c, {
      isGroup: scene.isGroup,
      groupId: '200000001',
      isOwner: !scene.isGroup,
      environment: [
        '现在是 2026年10月15日 星期四 午后 12:50（秋天）',
        '杭州 现在 21.4°C，多云，湿度 68%，风 4.2km/h',
      ],
      memories: '',
      selfTexts: [],
    });
  }
  return `${personaText || c.persona?.description || ''}\n\n${scene.ctx}${SENSES}`;
}
function safeLoad(side, fallback) {
  try {
    return side.config.loadConfig(path.join(ROOT, 'config', 'config.json'));
  } catch {
    return fallback;
  }
}

// ---- 调模型（照抄 persona-compare.mjs 的写法，保持零依赖） ----
async function ask(system, scene) {
  const res = await fetch(`${String(cfg.llm.baseUrl).replace(/\/+$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.llm.apiKey}` },
    body: JSON.stringify({
      model: cfg.llm.model,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: scene.user },
      ],
      temperature: cfg.llm.temperature,
      max_tokens: Number(cfg.llm.maxTokens) || 800,
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`HTTP ${res.status}：${JSON.stringify(body).slice(0, 200)}`);
  return String(body.choices?.[0]?.message?.content ?? '').trim();
}

// ---- 统计 ----
const count = (s, re) => (s.match(re) || []).length;

/**
 * 一个版本的完整管线：原文 → cleanReply → splitReply。
 * 每个环节单独 try：改造还没落盘时，缺哪个函数就跳过哪个环节并记一笔。
 */
function pipeline(side, raw, scene) {
  const notes = [];
  const rawText = String(raw ?? '');

  // ① cleanReply：以前会把换行抹成空格，改造后保留换行。
  let cleaned = rawText;
  if (typeof side.bot?.cleanReply === 'function') {
    try {
      cleaned = String(side.bot.cleanReply(rawText));
    } catch (err) {
      notes.push(`cleanReply 抛错：${err.message}`);
    }
  } else {
    notes.push('没有 cleanReply，原文照用');
  }
  if (cleaned.includes('\n')) {
    // 换行留不留得住是这次改造的核心之一：留下了才能按行切气泡。
  } else if (rawText.includes('\n')) {
    notes.push('cleanReply 把换行抹掉了（改造尚未落盘）');
  }

  // ② splitReply：改造后 bubbleOnNewline 默认 true，优先按换行切。
  const opts = splitOpts(scene.isGroup);
  let bubbles = [cleaned].filter(Boolean);
  let usedNewline = false;
  if (typeof side.segments?.splitReply === 'function') {
    try {
      // 新版签名认 bubbleOnNewline；旧版对多出来的键直接无视（JS 解构不校验），
      // 所以这里不会抛错 —— 是否真的按换行切要靠下面的 usedNewline 判定。
      bubbles = side.segments.splitReply(cleaned, { ...opts, bubbleOnNewline: true });
    } catch (err) {
      notes.push(`splitReply 抛错（退回整段一条）：${err.message}`);
      bubbles = [cleaned].filter(Boolean);
    }
    // 判定方式：多行的输入被切成了多条，且每条都不含换行 → 说明是按行切的。
    usedNewline = cleaned.includes('\n') && bubbles.length > 1 && bubbles.every((b) => !b.includes('\n'));
    if (cleaned.includes('\n') && bubbles.length === 1) {
      notes.push('有多行却只出一条气泡 → bubbleOnNewline 尚未生效');
    }
  } else {
    notes.push('没有 splitReply，按整段一条算');
  }
  bubbles = bubbles.filter((b) => String(b).trim());

  // ③ tidySelfText / buildMessages：历史里她自己的话会不会被「句号 → 换行」清洗。
  let tidied = null;
  let tidyApi = 'none';
  if (typeof side.llm?.tidySelfText === 'function') {
    tidyApi = 'tidySelfText';
    try {
      tidied = String(side.llm.tidySelfText(SELF_TEXTS[0]));
    } catch (err) {
      notes.push(`tidySelfText 抛错：${err.message}`);
      tidyApi = 'error';
    }
  } else {
    notes.push('没有 tidySelfText（改造尚未落盘）');
  }
  // buildMessages 的 tidyAssistant 是默认开的；这里用一段带句号的历史验证它真的生效。
  let histSnippet = '';
  let histTidy = false;
  if (typeof side.llm?.buildMessages === 'function') {
    try {
      const msgs = side.llm.buildMessages('SYS', [
        { role: 'user', text: '在吗' },
        { role: 'assistant', text: SELF_TEXTS[0] },
      ], { maxChars: 1500, tidyAssistant: true });
      const last = msgs[msgs.length - 1];
      histSnippet = typeof last?.content === 'string' ? last.content : '(非纯文本)';
      histTidy = histSnippet.includes('\n');
      if (!histTidy) notes.push('buildMessages 未清洗 assistant 历史（tidyAssistant 尚未落盘）');
    } catch (err) {
      notes.push(`buildMessages 抛错：${err.message}`);
    }
  }

  return {
    raw: rawText,
    cleaned,
    bubbles: bubbles.map((b) => String(b)),
    tidied,
    tidyApi,
    histSnippet,
    histTidy,
    usedNewline,
    notes,
  };
}

/** 每个气泡的字数（不含空白）。 */
const bubbleLens = (bubbles) => bubbles.map((b) => b.replace(/\s+/g, '').length);

const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';
const OFF = '\x1b[0m';

const show = (s) => String(s).replace(/\n/g, ' ⏎ ');

async function main() {
  // ---- 载入要比的两个版本 ----
  const live = await loadLive();
  let old = null;
  if (refArg) {
    try {
      old = await loadFromRef(refArg);
    } catch (err) {
      console.log(`${RED}--ref ${refArg} 用不了：${err.message}${OFF}`);
      console.log(`${DIM}降级成「只测当前工作区」。${OFF}\n`);
    }
  }
  // 旧在前、现在在后，和 persona-compare.mjs 的 A/B 顺序一致。
  const sides = refArg && old ? [old, live] : [live];
  if (refArg && old) {
    const changed = changedFiles(refArg);
    if (changed && changed.length === 0) {
      console.log(`⚠️  ${refArg} 和当前工作区的 src/ 完全一样，两个版本会跑出同样的结果。`);
      console.log(`${DIM}    （源码没差异，模型随机性造成的差别不算改造效果。）${OFF}\n`);
    } else if (changed) {
      console.log(`${DIM}${refArg} 相比当前工作区，src/ 改动：${changed.join(' / ')}${OFF}\n`);
    }
  }

  const scenes = onlyArg ? SCENES.filter((s) => s.name.includes(onlyArg)) : SCENES;
  if (!scenes.length) {
    console.error(`--only ${onlyArg} 没匹配到任何场景。可用：${SCENES.map((s) => s.name).join(' / ')}`);
    process.exit(1);
  }

  console.log(`${BOLD}说话风格对比${OFF}  ${DIM}（句号 / 换行 / 气泡，每个场景 2 次）${OFF}`);
  console.log(`模型：${cfg.llm.model} / temperature=${cfg.llm.temperature}`);
  console.log(`版本：${sides.map((s) => s.label).join('  vs  ')}`);
  if (!refArg) console.log(`${DIM}没给 --ref，只测当前工作区；想对比用 --ref HEAD~1 或 --ref HEAD。${OFF}`);
  console.log();

  const summary = [];

  for (const scene of scenes) {
    console.log('='.repeat(72));
    console.log(`${scene.name}  ${DIM}${scene.isGroup ? '群聊' : '私聊'}｜「${scene.user}」${OFF}`);
    console.log('='.repeat(72));

    for (const side of sides) {
      const system = systemFor(side, scene, liveConfig());
      const accent = side === old ? YELLOW : GREEN;
      // 每个场景跑 2 次：模型有随机性，单次不算数。
      for (let run = 1; run <= 2; run += 1) {
        try {
          const raw = await ask(system, scene);
          const r = pipeline(side, raw, scene);
          const lens = bubbleLens(r.bubbles);
          const head =
            `字数${r.cleaned.replace(/\s+/g, '').length} ` +
            `句号${count(r.cleaned, /。/g)} ` +
            `换行${count(r.raw, /\n/g)}→${count(r.cleaned, /\n/g)} ` +
            `气泡${r.bubbles.length} ` +
            `每泡[${lens.join(', ')}] ` +
            `平均句长${avgSentence(r.cleaned)}`;
          console.log(`\n${accent}${side.label}${OFF} 第${run}次  ${DIM}${head}${OFF}`);
          console.log(`  ${DIM}原文${OFF}  ${show(r.raw)}`);
          if (r.cleaned !== r.raw) console.log(`  ${DIM}清洗${OFF}  ${show(r.cleaned)}`);
          console.log(`  ${DIM}气泡${OFF}  ${r.bubbles.map((b, i) => `[${i + 1}] ${show(b)}`).join('\n        ')}`);
          if (r.notes.length) console.log(`  ${YELLOW}⚠️  ${r.notes.join('；')}${OFF}`);
          summary.push({
            scene: scene.name, side: side.label, run,
            dots: count(r.cleaned, /。/g),
            nlRaw: count(r.raw, /\n/g),
            nlClean: count(r.cleaned, /\n/g),
            bubbles: r.bubbles.length,
            chars: r.cleaned.replace(/\s+/g, '').length,
            newlineSplit: r.usedNewline,
          });
        } catch (err) {
          // API 报错只记一笔，继续跑下一个场景（可能是限流、断网、余额）。
          console.log(`\n${RED}${side.label} 第${run}次失败：${err.message}${OFF}`);
          summary.push({ scene: scene.name, side: side.label, run, error: err.message });
        }
      }
    }
    console.log();
  }

  // ---- 汇总表 ----
  console.log('='.repeat(72));
  console.log(`${BOLD}汇总${OFF}`);
  console.log('='.repeat(72));
  console.log(`${DIM}场景                 版本        次  字数  句号  换行(原→清)  气泡  按行切${OFF}`);
  for (const s of summary) {
    if (s.error) {
      console.log(`${s.scene.padEnd(20)} ${s.side.padEnd(10)} ${s.run}  ${RED}失败：${s.error.slice(0, 40)}${OFF}`);
      continue;
    }
    console.log(
      `${s.scene.padEnd(20)} ${s.side.padEnd(10)} ${s.run}  ${String(s.chars).padStart(4)}  ` +
        `${String(s.dots).padStart(4)}  ${String(`${s.nlRaw}→${s.nlClean}`).padStart(10)}  ` +
        `${String(s.bubbles).padStart(4)}  ${s.newlineSplit ? `${GREEN}是${OFF}` : '否'}`,
    );
  }

  // ---- 稳定性：同一场景两次的句号/气泡是否一致 ----
  const unstable = [];
  const byKey = new Map();
  for (const s of summary) {
    if (s.error) continue;
    const k = `${s.scene}|${s.side}`;
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k).push(s);
  }
  for (const [k, runs] of byKey) {
    if (runs.length < 2) continue;
    const dots = new Set(runs.map((r) => r.dots));
    const bub = new Set(runs.map((r) => r.bubbles));
    if (dots.size > 1 || bub.size > 1) unstable.push(`${k}（句号 ${[...dots].join('/')}，气泡 ${[...bub].join('/')}）`);
  }
  if (unstable.length) {
    console.log(`\n${YELLOW}两次结果不一致的场景${OFF}（模型随机性，看趋势别看单次）：`);
    for (const u of unstable) console.log(`  ${u}`);
  }

  // ---- 能力探测 ----
  const cap = pipeline(live, '测试。第二句。\n第三行', SCENES[0]);
  const tidyOk = typeof live.llm?.tidySelfText === 'function';
  const nlOk = cap.usedNewline;
  console.log(`\n${BOLD}改造落盘情况（当前工作区）${OFF}`);
  console.log(`  tidySelfText         ${tidyOk ? `${GREEN}已导出${OFF}` : `${YELLOW}未导出${OFF}`}`);
  console.log(`  splitReply 按换行切  ${nlOk ? `${GREEN}已生效${OFF}` : `${YELLOW}未生效（仍走 maxLength/maxSegments）${OFF}`}`);
  console.log(`  buildMessages 清洗    ${cap.histTidy ? `${GREEN}已生效${OFF}` : `${YELLOW}未生效${OFF}`}`);
  console.log(`  cleanReply 保留换行  ${cap.cleaned.includes('\n') ? `${GREEN}保留${OFF}` : `${YELLOW}抹平${OFF}`}`);

  console.log(`\n${GREEN}怎么读这些数字${OFF}：`);
  console.log('  ① 句号数：改造目标是「减少句号」。同场景两次都为 0～1 才算真的降下来了；');
  console.log('     如果还是 2～3 个，说明 prompt 里的要求没压住模型习惯，得继续拧。');
  console.log('  ② 换行(原→清)：左边是模型吐出来的换行数，右边是 cleanReply 之后还剩几个。');
  console.log('     右边为 0 而左边不为 0 = 换行被抹掉了，后面按行切气泡就无从谈起。');
  console.log('  ③ 气泡数：这是对方**实际看到几条消息**，是最直接的体感指标。');
  console.log('     1 条 = 一大坨（改造前常态）；2～4 条才是"在打字"的样子。');
  console.log('  ④ 每泡字数：私聊上限 45、群聊 90（config.split）。超了说明切分没生效，');
  console.log('     不是模型话多——切分是程序控制的，模型管不着。');
  console.log('  ⑤ 平均句长：越短越像打字。但太短（<6）会碎成电报腔，也不是好事。');
  console.log('  ⑥ 按行切=是：说明 splitReply 真的走了 bubbleOnNewline 这条路。');
  console.log(`  ${DIM}模型有随机性，同一场景两次可能差一倍；单次异常别当结论，两次都这样才算问题。${OFF}`);
}

/** 按句末标点切句，算平均句长（空句不计）。 */
function avgSentence(text) {
  const parts = String(text)
    .split(/[。！？!?…~\n]+/)
    .map((s) => s.replace(/\s+/g, ''))
    .filter(Boolean);
  if (!parts.length) return 0;
  return Math.round(parts.reduce((a, b) => a + b.length, 0) / parts.length);
}

main().catch((err) => {
  console.error(`${RED}脚本出错：${err.stack || err.message}${OFF}`);
  process.exitCode = 1;
});
