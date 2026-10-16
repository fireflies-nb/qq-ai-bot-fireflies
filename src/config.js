import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const DEFAULTS = {
  onebot: {
    // 正向 WebSocket：NapCat 作服务端，本程序作客户端连上去
    wsUrl: 'ws://127.0.0.1:3001',
    accessToken: '',
    reconnectMinMs: 1000,
    reconnectMaxMs: 30000,
    apiTimeoutMs: 15000,
  },
  llm: {
    baseUrl: 'https://api.deepseek.com/v1',
    apiKey: '',
    model: 'deepseek-chat',
    temperature: 1.1,
    // 硬上限，不是目标长度。原来是 400：一旦模型想写更长，接口会**静默截断**
    // （回复会像被切断），而程序这边收不到任何错误。抬到 800 只是把这个隐患拿掉，
    // 实际长度仍然由人设里的字数要求来管。
    maxTokens: 800,
    timeoutMs: 45000,
  },
  trigger: {
    group: {
      enabled: true,
      requireAt: true,
      whitelist: [], // 空数组 = 所有群；填了则只响应这些群
      blacklist: [],
    },
    private: {
      enabled: false, // 私聊默认关闭
      whitelist: [], // 填了则只有这些人能触发
    },
  },
  context: {
    groupWindow: 20,
    privateWindow: 20,
    // 按「轮」取历史的轮数（一轮 = 对方一条 + 她随后的若干条）。
    // 实测：私聊最近 20 行里她占 13 行（65%），窗口边界常落在一轮中间，开头那半条
    // 助手消息会被丢掉。改按轮取之后每一轮都是完整的。
    // 为什么不直接调小行数：行数小了会让她更健忘；按轮取能在同样"忘记"程度下
    // 多记住几次对方说的话。
    groupTurns: 20,
    privateTurns: 10,
    // 注：窗口最后由 maxChars 字数预算兜底，这两个轮数只是上限。
    // 实测私聊每轮约 101 字，10 轮 ≈ 1000 字，1500 预算正好装得下。
    maxChars: 1500,
  },
  rateLimit: {
    perSessionMinIntervalMs: 3000,
    globalPerMinute: 20,
    dedupeTtlMs: 300000,
  },
  quietHours: {
    enabled: false,
    start: '23:30',
    end: '07:30',
  },
  split: {
    enabled: true,
    // 群聊的每条气泡上限。实测群聊表现良好（中位 30 字、0% 超 90），保持不动。
    maxLength: 90,
    maxSegments: 3,
    // 私聊单独收紧长度：实测私聊中位 83 字、48% 超 90，偏长的抱怨全部来自这里。
    // 单独设值是必须的——直接改上面的 maxLength 会把本来正常的群聊一起改坏。
    privateMaxLength: 45,
    // 私聊单独放宽段数上限：私聊是"跟流萤聊天"，允许她多说几条。
    privateMaxSegments: 5,
    // 气泡之间的停顿。原来是 700~2000ms，读起来像在等下一段，
    // 容易让人觉得"上一句说了一半"。缩短到 300~800ms，几条连起来才像一个人在想事情。
    delayMinMs: 300,
    delayMaxMs: 800,
    // 换行 = 一条新消息。人设里教她"想分成两句就用换行，不要用句号"，
    // 这里就是那句话的兑现点（cleanReply 保留换行，splitReply 按行切）。
    // 关掉会退回以前的行为：换行被当空格，只在长度超标时按标点切。
    bubbleOnNewline: true,
  },
  // 打字延迟：不要"秒回"，要像真人在手机上打字。
  // 为什么要按字数算：真人打 40 个字要好几秒，秒回长句子最不像人；
  // 而"嗯"、"在呢"这种一两个字的回话本来就该快。
  // 已花掉的时间（检索 + 模型生成，实测 1~1.5 秒）会从预算里扣掉，
  // 否则模型本来就慢的时候还要再等一遍，变成没必要的叠加。
  typing: {
    enabled: true,
    // 看到消息 → 开始打字的反应时间。每条回复只算一次。
    reactMinMs: 600,
    reactMaxMs: 1600,
    // 每个字的打字时间，约等于手机上每秒打 22 个字。
    perCharMs: 45,
    // 打字时间的上限。防止超长回复让人等太久（4 秒 ≈ 90 个字）。
    maxDelayMs: 4000,
  },
  // 「对方正在输入…」提示。
  // 只能在私聊用：NapCat 的 set_input_status 内部把 chatType 写死成私聊，
  // 群聊没有这个概念。不消耗 token，只是多一个 QQ 协议动作。
  // 用的是 NapCat 扩展动作，老版本可能没有 —— 发失败只记 debug 日志，绝不影响回复。
  inputStatus: {
    enabled: true,
    // 停顿短于这个值时干脆不发：一闪而过的提示比不发还假。
    minDelayMs: 800,
  },
  // 号主本人的 QQ 号。「开拓者」这个身份只属于这一个号。
  // 群里其他人 @ 时不会被当成开拓者，人设里"对开拓者的态度"不会生效。
  // 留空字符串 = 谁都不是开拓者（安全默认：宁可对号主生分，也不要把陌生人当号主）。
  owner: {
    qq: '',
  },
  persona: {
    // 人设正文文件。整段作为 system prompt，优先于下面的 description/style/rules。
    // 设为空字符串 '' 即退回简版配置。
    systemPromptFile: './config/persona.md',
    // 说话习惯示范：**怎么称呼号主**。见 llm.js 的 buildAddressDemo()。
    // 背景：人设文件里早就写了"不用每句都叫，但也不要一直躲着不叫"，但真实历史回放
    // 实测称呼 0/50 —— 抽象规则对"叫不叫名字"这种口头习惯几乎不起作用。
    // 换成一小段**具体示范**（"他说他回来了：开拓者，回来啦"）后实测 0/20 → 6/20
    // （"他要去睡"那一档 4/5）。注意示范里用「开拓者」比用他本人的昵称有效得多
    // （开拓者 6/18 vs 昵称 1/18），因为前者是人设里写死的身份。
    // 只在**私聊 + 号主**时注入；群里和陌生人一律不注入。空数组 = 关掉这段示范。
    //
    // ⚠️ **这里可以填真名，但人设文件里千万别填**：模型会把示范里的字符串逐字照抄。
    // 踩过的坑 —— 公开仓库里的昵称是脱敏占位名，人设范例里引用了它，真机就开始那样叫她。
    // 所以真名只走这个配置项（它在 .gitignore 里），人设里只写"开拓者"。见 ROADMAP 坑 18。
    addressNames: ['开拓者'],
    description:
      '你是这个 QQ 号的主人本人。你在群里聊天，说话随意、简短、口语化，像真人在手机上打字。',
    style: '每次回 1 句话为主，最多 2 句。不用标点堆砌，不用书面语，不用 emoji 堆叠。',
    rules: [
      '绝对不要暴露你是 AI、机器人、模型或助手，也不要说"作为AI"之类的话。',
      '不要输出括号动作描写，不要用"哈哈"以外的过度客套。',
      '不确定的事情就用模糊的话带过，不要编造具体事实骗人。',
      '别人问你是不是机器人，就自然地否认或反问回去。',
      '涉及转账、账号密码、验证码、身份证、银行卡的，一律不回应细节，只说"这个不方便说"。',
      '不要主动索要任何人的隐私信息。',
      '如果对方在问你解决不了的事情，就说"我看看"、"待会儿回你"这类话。',
    ],
    fallback: '嗯……让我想想。',
  },
  // 实时感知：让她知道"现在几点、外面什么天气、跟这个人多久没说话了"。
  // 时间走本机时钟（不用联网）；天气走 open-meteo（免费、无需 key）。
  awareness: {
    enabled: true,
    // 当地时间。写错会退回本机时区，不会崩。
    timezone: 'Asia/Shanghai',
    // 是否告诉她"距上次说话多久了"（这是一个很有效的"像真人"信号）。
    gap: true,
    location: {
      // 定位**故意写死**：实测 ip-api.com 三次请求两次超时（12s），
      // 拿它做实时定位会让回复要么卡死要么没天气。要换地方就改这里。
      name: '杭州',
      latitude: 30.2741,
      longitude: 120.1551,
    },
    weather: {
      enabled: true,
      // 天气 30 分钟才变一次，绝对不要每条消息都查 —— 那是白白给回复加 1 秒延迟。
      // 实际是后台定时刷新，回复主链路只读缓存。
      refreshMs: 1800000,
      timeoutMs: 8000,
      // 失败后多久才重试，避免断网时每条消息都去撞一次超时。
      retryOnFailMs: 120000,
    },
  },
  // 长期记忆：从对话里抽出稳定事实，跨天记住某个人。
  memory: {
    enabled: true,
    // 回复时是否检索并注入相关记忆。
    recall: true,
    // 回复后是否在后台抽取新记忆（异步，不占用回复时间）。
    extract: true,
    // 一次注入多少条记忆。太多会挤掉对话上下文，也容易让模型变成复读机。
    recallLimit: 6,
    // 至少要命中几个 n-gram 才算相关。1 会把"的""了"这种噪声词也放进来。
    minScore: 2,
    // 每次抽取最多写入几条，防止模型一口气吐 20 条废话。
    maxPerCall: 5,
    // 单个会话的记忆条数上限。长期记忆不按时间删，靠这个防无限膨胀。
    maxPerSession: 500,
    // 抽取用的 prompt 最多喂多少字聊天记录。
    maxInputChars: 1200,
    maxTextLength: 120,
    maxTokens: 500,
    maxQueryGrams: 24,
    // ---- 近似重复整治（三层，见 textsim.js）----
    // 实测真机记忆库 73 条里 36% 是同一件事的多种说法，
    // 后果是检索时 6 个名额被同一件事占满，模型误判"这件事特别重要"而反复提。
    // ① 抽取时把「已经记住的事」告诉抽取器，让它别再换个说法重记一遍。
    dedupeExtract: true,
    // 上面那份「已知清单」取多少条。太大反而稀释注意力，40 条够覆盖近期。
    dedupeKnownLimit: 40,
    // ② 入库时的保守近似合并：新记忆和已有某条是同一件事就只强化它。
    dedupeOnWrite: true,
    // ③ 检索端多样性去重：命中多条同义时只留一条，保证名额不浪费在变体上。
    dedupeOnRetrieve: true,
  },
  // 短期「她自己说过的话」记忆。
  // 和上面 memory 段是两回事：memory 记的是**关于对方的长期事实**（跨天不丢），
  // 这里记的是**她这几天刚说过的话**（跟着上下文窗口滑动的补丁）。
  // 为什么需要：她连发的多条气泡在模型眼里会被合并成一条 assistant，
  // 一旦滑出窗口她就完全不知道自己说过什么 —— 实测出现过"重复答应同一件事"
  // 和"编造共同过去"，而长期记忆刻意不收她自己的话（编造的话固化下来洗不掉）。
  selfMemory: {
    enabled: true,
    // 回看几轮。太小（1~2 轮）治不了"跨轮重复答应"，太大等于把窗口又拉回来。
    turns: 8,
    // 注入几条、每条最多多少字。这里是**保持前后一致**用的，不是背景知识，
    // 所以给得很省，避免又把窗口挤满。
    limit: 8,
    maxChars: 400,
    maxItemChars: 60,
  },
  // 看图：把消息里的图片真正交给多模态模型。
  // 代价是每张图最多 1024 token（DeepSeek 官方限制），所以默认上限很保守。
  vision: {
    enabled: true,
    // 一条消息最多带几张图。设为 0 等于关掉看图。
    maxImages: 2,
    // 单张图的字节上限，超过就放弃（5MB 足够普通聊天图，也不会把内存拉爆）。
    maxBytes: 5242880,
    // 下载图片的超时（毫秒）。
    timeoutMs: 10000,
    // 已下载图片的缓存时长：同一条消息重复处理时不再下一次。
    cacheTtlMs: 600000,
    cacheMax: 16,
  },
  safety: {
    // 命中这些关键词时，不调用模型，直接返回固定话术（防止被套话或做危险承诺）
    blockedKeywords: ['转账', '打钱', '验证码', '密码', '银行卡', '身份证', '贷款', '借钱'],
    blockedReply: '这个真不方便说',
    // 被动接管：你本人在该会话手动发言后，多少毫秒内 AI 不再插手
    takeoverAfterSelfMessageMs: 600000,
  },
  control: {
    enabled: true,
    host: '127.0.0.1',
    port: 8787,
  },
  storage: {
    dbPath: './data/bot.db',
    retentionDays: 30,
  },
  logLevel: 'info',
};

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/**
 * 深合并。数组必须复制：否则 cfg.trigger.group.whitelist 会和 DEFAULTS 共享同一个
 * 数组引用，控制台 push 白名单会永久污染 DEFAULTS，让后续 loadConfig 和测试互相串味。
 */
export function deepMerge(base, override) {
  if (Array.isArray(override)) return override.map((x) => (isPlainObject(x) || Array.isArray(x) ? deepMerge({}, x) : x));
  if (!isPlainObject(override)) return override === undefined ? clone(base) : override;
  const out = isPlainObject(base) ? { ...base } : {};
  if (isPlainObject(base)) {
    for (const [k, v] of Object.entries(base)) if (!(k in override)) out[k] = clone(v);
  }
  for (const [k, v] of Object.entries(override)) {
    out[k] = isPlainObject(base?.[k]) && isPlainObject(v) ? deepMerge(base[k], v) : clone(v);
  }
  return out;
}

/** 复制数组/普通对象，避免调用方拿到 DEFAULTS 内部的共享引用。 */
function clone(v) {
  if (Array.isArray(v)) return v.map(clone);
  if (isPlainObject(v)) {
    const o = {};
    for (const [k, x] of Object.entries(v)) o[k] = clone(x);
    return o;
  }
  return v;
}

export function loadConfig(file = path.join(ROOT, 'config', 'config.json')) {
  if (!fs.existsSync(file)) {
    throw new Error(
      `找不到配置文件：${file}\n请先复制 config/config.example.json 为 config/config.json 并填写。`,
    );
  }
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    throw new Error(`配置文件不是合法 JSON：${file}\n${err.message}`);
  }
  const warnings = [];
  const cfg = deepMerge(DEFAULTS, parsed);
  cfg.storage.dbPath = path.resolve(ROOT, cfg.storage.dbPath);
  cfg.persona.systemPromptText = loadPersonaPrompt(cfg.persona, warnings);
  // 加载阶段的告警（如人设文件缺失）交给 validateConfig 一起报，避免启动时被吞掉。
  cfg.loadWarnings = warnings;
  return cfg;
}

/**
 * 读取人设正文文件。整段内容会作为 system prompt 的主体。
 * 找不到文件时不算致命错误：退回 persona.description/style/rules 简版，只给个警告，
 * 因为仓库里只带 persona.example.md，用户没复制时不该直接启动失败。
 */
function loadPersonaPrompt(persona, warnings) {
  const rel = String(persona?.systemPromptFile ?? '').trim();
  if (!rel) return '';
  const file = path.isAbsolute(rel) ? rel : path.resolve(ROOT, rel);
  if (!fs.existsSync(file)) {
    warnings.push(
      `人设文件不存在：${file}（已退回 persona.description/style/rules 简版。` +
        `想用文件人设，把 config/persona.example.md 复制成 config/persona.md）`,
    );
    return '';
  }
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    warnings.push(`人设文件读取失败：${file}（${err.message}）`);
    return '';
  }
  // 去掉 HTML 注释：文件顶部的使用说明是写给用户看的，不该进模型上下文。
  const text = raw.replace(/<!--[\s\S]*?-->/g, '').trim();
  if (!text) {
    warnings.push(`人设文件内容为空：${file}（已退回简版人设）`);
    return '';
  }
  return text;
}

/** 启动前的显式校验：宁可启动失败，也不要在群里发出诡异消息。 */
export function validateConfig(cfg) {
  const errors = [];
  const warnings = [...(cfg.loadWarnings ?? [])];

  if (!/^wss?:\/\//.test(cfg.onebot.wsUrl)) errors.push('onebot.wsUrl 必须是 ws:// 或 wss:// 开头');
  if (!cfg.llm.apiKey) warnings.push('llm.apiKey 为空，将无法调用模型（可先用 /api/test-llm 验证）');
  if (!cfg.trigger.group.enabled && !cfg.trigger.private.enabled)
    warnings.push('群聊和私聊都关闭了，机器人不会回复任何消息');
  if (cfg.trigger.private.enabled && cfg.trigger.private.whitelist.length === 0)
    warnings.push('私聊已开启且白名单为空 → 所有好友私聊都会被 AI 回复，风险较高');
  if (cfg.quietHours.enabled && !/^\d{2}:\d{2}$/.test(cfg.quietHours.start))
    errors.push('quietHours.start 格式应为 HH:MM');
  if (cfg.quietHours.enabled && !/^\d{2}:\d{2}$/.test(cfg.quietHours.end))
    errors.push('quietHours.end 格式应为 HH:MM');
  if (!cfg.persona?.systemPromptText && !cfg.persona?.description)
    warnings.push('人设为空：persona.systemPromptFile 和 persona.description 都没有内容，AI 会没有性格设定');

  if (cfg.awareness?.enabled && cfg.awareness?.weather?.enabled) {
    const lat = Number(cfg.awareness.location?.latitude);
    const lon = Number(cfg.awareness.location?.longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      warnings.push('awareness.location 的 latitude/longitude 不是数字，天气功能会自动跳过（时间感知不受影响）');
    } else if (lat < -90 || lat > 90 || lon < -180 || lon > 180) {
      warnings.push(`awareness.location 坐标超出合法范围（${lat}, ${lon}），天气可能取不到`);
    }
  }
  if (cfg.awareness?.enabled && cfg.awareness?.timezone) {
    try {
      new Intl.DateTimeFormat('zh-CN', { timeZone: cfg.awareness.timezone });
    } catch {
      warnings.push(`awareness.timezone「${cfg.awareness.timezone}」不是合法时区，将退回本机时区`);
    }
  }
  if (cfg.memory?.recall && Number(cfg.memory?.minScore) < 1) {
    warnings.push('memory.minScore 小于 1，几乎所有记忆都会被召回，建议保持默认 2');
  }
  if (cfg.vision?.enabled && Number(cfg.vision?.maxImages ?? 0) > 4) {
    warnings.push(
      `vision.maxImages = ${cfg.vision.maxImages}，一条消息最多会消耗约 ${cfg.vision.maxImages * 1024} token，建议不要超过 2`,
    );
  }
  if (cfg.vision?.enabled && Number(cfg.vision?.maxBytes ?? 0) > 20 * 1024 * 1024) {
    warnings.push('vision.maxBytes 超过 20MB，模型侧单图上限是 32MB，下载大图也会明显拖慢回复');
  }
  if (cfg.typing?.enabled) {
    const perChar = Number(cfg.typing?.perCharMs ?? 0);
    const cap = Number(cfg.typing?.maxDelayMs ?? 0);
    if (!Number.isFinite(perChar) || perChar < 0) warnings.push('typing.perCharMs 不是有效数字，打字延迟将按 0 处理');
    if (!Number.isFinite(cap) || cap < 0) warnings.push('typing.maxDelayMs 不是有效数字，打字延迟将按 0 处理');
    if (Number(cfg.rateLimit?.perSessionMinIntervalMs ?? 0) > 0) {
      // 对方"连发被丢掉"的窗口 ≈ max(这条回复占住 inflight 的时间, perSessionMinIntervalMs)，
      // 两者是重叠的，不是相加：perSessionMinIntervalMs 从 begin() 起算，
      // 而打字延迟就发生在 begin() 之后、end() 之前。
      const inflightMs = Number(cap || 0) + Number(cfg.typing.reactMaxMs || 0);
      if (inflightMs > 8000) {
        warnings.push(
          `typing 打字延迟最长约 ${Math.round(inflightMs / 1000)} 秒，这期间对方连发消息会被限速丢掉；` +
            '要么调小 typing.maxDelayMs，要么调小 rateLimit.perSessionMinIntervalMs',
        );
      }
    }
  }

  return { errors, warnings };
}
