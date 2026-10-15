/**
 * 文本相似度：判断两条长期记忆是不是「同一件事换了种说法」。
 *
 * 为什么需要它：`store.addMemory` 原来只用归一化后的**精确**匹配去重，
 * 换个说法就抓不住。实测真机记忆库 73 条里有 33 条冗余（45%），
 * 典型的一组是「阿澈在下午三点四十下课，上午加半个下午都有课」这类
 * 同一件事的 6 种说法 —— 后果是检索时 6 个名额被同一件事占满，
 * 模型会误判"这件事特别重要"从而反复提。
 *
 * 为什么是 2-gram 而不是别的：
 *   - FTS5 默认分词器对中文完全失效（整句一个 token），trigram 又要 ≥3 字；
 *   - 真正的语义相似度要 embeddings，而实测 DeepSeek 不提供（HTTP 404）。
 *
 * 【判定参数是实测出来的，不要凭感觉调】为什么这么保守：
 * 相似度只看字面，而字面像不等于同一件事。实测的反例：
 *   「阿澈养了一只猫」vs「阿澈养了一只狗」 → Jaccard 0.71，比很多真重复对还高；
 *   「阿澈不喜欢被催着去睡觉」vs「阿澈喜欢被催着去睡觉」 → shared 8、Jaccard 0.73。
 * 所以**不能只看 Jaccard**，必须同时要求绝对共享数足够高（长句）或用包含率兜住
 * （短句加长版）。另外还必须加极性守卫，否则"喜欢/不喜欢"会被并成一条 ——
 * 那比不合并严重得多：**合错了会把两个相反的事实永久变成一个**。
 *
 * 宁可漏合并，不可错合并：漏了只是多占一个名额，错了是信息永久损坏。
 */

/** 中文按 2-gram 切分。实测：FTS5 默认分词器对中文完全失效，trigram 又要求 ≥3 字，只剩这条路。 */
export function grams(text, n = 2) {
  const clean = String(text ?? '').replace(/[\s\p{P}\p{S}]+/gu, '');
  const out = new Set();
  for (let i = 0; i + n <= clean.length; i += 1) out.add(clean.slice(i, i + n));
  return [...out];
}

/** 从一段话里挑出信息量高的 n-gram，避免"的了呢吗"这类噪声词占满查询预算。 */
export function queryGrams(text, { max = 24, n = 2 } = {}) {
  const all = grams(text, n);
  const out = [];
  for (const g of all) {
    if (g.length < n) continue;
    out.push(g);
    if (out.length >= max) break;
  }
  return out;
}

/** 去掉标点与空白，只留汉字/字母/数字。 */
function clean(text) {
  return String(text ?? '').replace(/[\s\p{P}\p{S}]+/gu, '');
}

function gramSet(text) {
  const c = clean(text);
  const out = new Set();
  for (let i = 0; i + 2 <= c.length; i += 1) out.add(c.slice(i, i + 2));
  return out;
}

const NEG = /[不没无非未莫]/;

/** 每条文本里「否定词 + 紧跟的两个字」，用来判断极性有没有被翻转。 */
function negPhrases(text) {
  const c = clean(text);
  const out = new Set();
  for (let i = 0; i < c.length; i += 1) {
    if (!NEG.test(c[i])) continue;
    const after = c.slice(i + 1, i + 3);
    if (after.length === 2) out.add(`${c[i]}|${after}`);
  }
  return out;
}

/**
 * 极性守卫：只有当「多出来的那个否定」修饰了**双方都提到过**的内容时才判定为不同。
 *
 * 这样区分开两种情况：
 *   「喜欢吃辣」 vs 「不喜欢吃辣」    → 「喜欢」两边都有，一边多了否定 → 不是同一条
 *   「…还不确定」 vs 「…感兴趣的东西」→ 「确定」另一条没提 → 可以合并（只是多了个从句）
 *   「无法运行」 vs 「就无法运行」    → 两边都有同一个否定 → 可以合并
 */
export function polarityDiffers(a, b) {
  const setA = gramSet(a);
  const setB = gramSet(b);
  const pA = negPhrases(a);
  const pB = negPhrases(b);
  for (const [setOther, pSelf, pOther] of [
    [setB, pA, pB],
    [setA, pB, pA],
  ]) {
    for (const key of pSelf) {
      const after = key.split('|')[1];
      if (!setOther.has(after)) continue;
      if (pOther.has(key)) continue;
      return true;
    }
  }
  return false;
}

const NUM_CHARS = '0-9０-９一二三四五六七八九十百千万亿两';
/** 单独一个汉字数字只有后面跟着量词时才算"数量"：「上了一上午」里的"一"不算。 */
const NUM_UNITS = '月点号岁次天年个层楼班路周星期分秒块元角日时本杯件张只条套台部册';

/**
 * 抽出文本里的"数量词"。
 * 数字是**最容易把两件事混成一件**的东西，而字面相似度完全看不出来：
 * 「下午三点四十下课」和「下午四点四十下课」的 shared 高达 13、Jaccard 0.76，
 * 比很多真正的重复对还像。
 */
function numberTokens(text) {
  const c = clean(text);
  const out = [];
  const re = new RegExp(`[${NUM_CHARS}]+`, 'g');
  let m = re.exec(c);
  while (m) {
    const run = m[0];
    if (run.length >= 2) {
      out.push(run);
    } else {
      const next = c[m.index + run.length];
      if (next && NUM_UNITS.includes(next)) out.push(run + next);
    }
    m = re.exec(c);
  }
  return out.sort();
}

/**
 * 数字守卫：两边的数量词不一致就不是同一件事。
 *
 * 只在**双方都提到数量**时比较 —— 一边有、一边没有的情况（「接一个」vs「接入」）
 * 不算冲突，否则会把正常的改写挡在外面。
 */
export function numberDiffers(a, b) {
  const ta = numberTokens(a);
  const tb = numberTokens(b);
  if (!ta.length || !tb.length) return false;
  if (ta.length !== tb.length) return true;
  return ta.some((t, i) => t !== tb[i]);
}

/**
 * 虚词。只在两边的字符**都是虚词**时，这个差异才算"语法变体"而不是"换了内容"。
 *
 * 这条是实测补上的：第一版把「阿澈…并拍了照片」和「阿澈…并拍过照片」判成了两件事
 * （同长度、只差一个「了/过」），于是真库里重庆那件事合并完还剩 3 条变体。
 * 而「养了一只猫 / 养了一只狗」差的「猫/狗」是实词，必须继续拦住。
 */
const FUNCTION_CHARS = new Set('了过着的得地是就都也还又再才会被把和与在很才');

/**
 * 替换守卫：两条**长度相同**、只差一两个字的多半是「换了个名词/动词」而不是「换了个说法」。
 *
 * 包含率这条通道必须放得比较松（0.85）才能抓住"加了个字"的改写，
 * 但松到 0.85 就离「阿澈养了一只猫 / 阿澈养了一只狗」（包含率 0.83）太近了，
 * 这道守卫是补上的第二层保险：字面几乎逐位相同、只在固定位置替换了内容，
 * 那就当成不同的事。
 *
 * 代价：同一个事实里的错别字、或者"学吉他/练吉他"这类实词替换也会被拒。
 * 这是刻意选的方向 —— 漏合并只是多占一个名额，错合并是信息永久损坏。
 */
export function substitutionDiffers(a, b) {
  const ca = clean(a);
  const cb = clean(b);
  if (ca.length !== cb.length || ca.length < 4) return false;
  let contentDiff = 0;
  for (let i = 0; i < ca.length; i += 1) {
    if (ca[i] === cb[i]) continue;
    // 两边都是虚词 → 只是"了/过""的/得"这种语法差异，不算换了内容。
    if (FUNCTION_CHARS.has(ca[i]) && FUNCTION_CHARS.has(cb[i])) continue;
    contentDiff += 1;
    if (contentDiff > 2) return false;
  }
  return contentDiff >= 1;
}

/** 三条指标：共享 gram 数、Jaccard、包含率（较小的那条被覆盖了多少）。 */
export function similarity(a, b) {
  const A = gramSet(a);
  const B = gramSet(b);
  let shared = 0;
  for (const g of A) if (B.has(g)) shared += 1;
  const union = A.size + B.size - shared;
  const minSize = Math.min(A.size, B.size);
  return {
    shared,
    jaccard: union ? shared / union : 0,
    containment: minSize ? shared / minSize : 0,
    minSize,
    sizeA: A.size,
    sizeB: B.size,
  };
}

/** 实测调出来的参数。改之前先跑 test/memory.test.js 里那组「必须拒绝 / 必须合并」用例。 */
export const MERGE_DEFAULTS = {
  // ① 长句用「共享数 + Jaccard」（词序打乱、两边都改了措辞的情况）
  minShared: 10,
  minJaccard: 0.5,
  // ② 短句用「包含率」：加长版/截短版，如「…为"萤宝"，并表达爱意」与「…为"萤宝"」。
  //    0.85 是实测定出来的：真实库里 7 对「只加了个字/加了个从句」的改写包含率落在
  //    0.86~1.00，再紧就抓不住；而"猫/狗"这种坏对是 0.83，靠 substitutionDiffers 拦。
  minContainment: 0.85,
  minGramsForContainment: 3,
  // ③ 长句的兜底：改写得比较狠，Jaccard 会掉到 0.5 以下，这时看绝对共享数
  longShared: 12,
  longContainment: 0.65,
  longMinSize: 12,
};

/**
 * 两条记忆是不是同一件事。返回 `{ same, reason, metrics }`，
 * reason 会写进日志和接口返回，方便事后核对「为什么被合并了」。
 */
export function isSameMemory(a, b, opts = {}) {
  const o = { ...MERGE_DEFAULTS, ...opts };
  const metrics = similarity(a, b);
  if (o.checkPolarity !== false && polarityDiffers(a, b)) {
    return { same: false, reason: 'polarity', metrics };
  }
  // 包含率的通道放得比较松，必须靠这两道守卫兜住"换一个名词"的情况。
  if (metrics.shared >= o.minShared && metrics.jaccard >= o.minJaccard) {
    if (o.checkNumber !== false && numberDiffers(a, b)) {
      return { same: false, reason: 'number', metrics };
    }
    if (o.checkSubstitution !== false && substitutionDiffers(a, b)) {
      return { same: false, reason: 'substitution', metrics };
    }
    return { same: true, reason: 'union', metrics };
  }
  if (metrics.minSize >= o.minGramsForContainment && metrics.containment >= o.minContainment) {
    if (o.checkNumber !== false && numberDiffers(a, b)) {
      return { same: false, reason: 'number', metrics };
    }
    if (o.checkSubstitution !== false && substitutionDiffers(a, b)) {
      return { same: false, reason: 'substitution', metrics };
    }
    return { same: true, reason: 'containment', metrics };
  }
  if (metrics.minSize >= o.longMinSize && metrics.shared >= o.longShared && metrics.containment >= o.longContainment) {
    if (o.checkNumber !== false && numberDiffers(a, b)) {
      return { same: false, reason: 'number', metrics };
    }
    return { same: true, reason: 'long', metrics };
  }
  return { same: false, reason: '', metrics };
}

/**
 * 从候选里挑出互不重复的一组。
 *
 * 每轮先选出**度数最高**的那条当锚点（跟最多候选互为"同一件事"的那条），
 * 把和它同义的都收走，再从剩下的里继续挑。
 *
 * 为什么要选度数最高的当锚点，而不是"先来的先当锚点"：
 * 真实库里的变体常常长成「一句主干 + 各自挂了不同的尾巴」——
 *   #1 阿澈称呼流萤为"萤宝"
 *   #2 阿澈称呼流萤为"萤宝"，并表达爱意
 *   #3 阿澈称呼流萤为"萤宝"，并说会慢慢治疗流萤
 * 这里 #1 跟 #2、#3 都同义，但 #2 和 #3 互相不同义（尾巴不一样）。
 * 如果按顺序拿 #3 当锚点，它就只收走 #1，#2 会被当成另一件事留下 ——
 * 实测就是这个原因让 3 个变体留下了 2 条。让"跟谁都像"的 #1 当锚点才能一次收干净。
 *
 * 仍然不做传递串联：成员必须**和锚点本人**同义，
 * 所以不会出现「萤宝」和「一起治疗」被一条复合记忆串成一组的情况。
 */
export function pickDistinct(items, { getText = (x) => x?.text, ...opts } = {}) {
  const pool = (items ?? []).filter((it) => getText(it));
  const kept = [];
  while (pool.length) {
    let anchorIdx = 0;
    let bestDeg = -1;
    for (let i = 0; i < pool.length; i += 1) {
      let deg = 0;
      for (let j = 0; j < pool.length; j += 1) {
        if (i === j) continue;
        if (isSameMemory(getText(pool[i]), getText(pool[j]), opts).same) deg += 1;
      }
      // 度数相同时取靠前的：候选本身已按得分/hits 排过序，靠前 = 更相关。
      if (deg > bestDeg) {
        bestDeg = deg;
        anchorIdx = i;
      }
    }
    const anchor = pool[anchorIdx];
    kept.push(anchor);
    const rest = [];
    for (let i = 0; i < pool.length; i += 1) {
      if (i === anchorIdx) continue;
      if (isSameMemory(getText(anchor), getText(pool[i]), opts).same) continue;
      rest.push(pool[i]);
    }
    pool.length = 0;
    pool.push(...rest);
  }
  return kept;
}

/**
 * 锚点式聚类：把一组记忆按「同一件事」分组，用于清理存量重复。
 *
 * 锚点优先取 hits 高的（被反复提到的更可能是"主版本"），
 * 然后只把**和锚点相似**的归到这一组 —— 不传递，避免跨事实串联。
 */
export function clusterMemories(items, { getText = (x) => x?.text, getHits = (x) => x?.hits ?? 0, ...opts } = {}) {
  const sorted = [...(items ?? [])].sort((a, b) => Number(getHits(b)) - Number(getHits(a)));
  const clusters = [];
  for (const it of sorted) {
    const text = getText(it);
    if (!text) continue;
    const hit = clusters.find((c) => isSameMemory(getText(c.anchor), text, opts).same);
    if (hit) hit.members.push(it);
    else clusters.push({ anchor: it, members: [it] });
  }
  return clusters;
}
