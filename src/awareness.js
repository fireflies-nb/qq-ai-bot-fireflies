import { logger } from './logger.js';

/**
 * 实时感知：让她知道自己"现在处在什么时间、外面什么天气、跟这个人多久没说话了"。
 *
 * 设计要点：
 * 1. 时间不用联网，本机时钟就够（按 timezone 换算成当地时间）。
 * 2. 天气用 open-meteo，免费、不需要 key。但**必须缓存**：绝对不能每来一条消息就查一次，
 *    那会把回复延迟拖到 1 秒以上，而且毫无意义（天气 30 分钟才变一次）。
 * 3. 天气刷新是后台定时做的，不进回复主链路 —— snapshot() 只读缓存，永远是同步、零延迟的。
 * 4. 定位写死在配置里。实测 ip-api.com 三次请求里两次超时（12s），拿它做实时定位
 *    会让回复要么卡死要么没天气，不可靠。
 */

const WEATHER_CODE_TEXT = {
  0: '晴',
  1: '晴间多云',
  2: '多云',
  3: '阴',
  45: '有雾',
  48: '雾凇',
  51: '毛毛雨',
  53: '毛毛雨',
  55: '较密的毛毛雨',
  56: '冻毛毛雨',
  57: '强冻毛毛雨',
  61: '小雨',
  63: '中雨',
  65: '大雨',
  66: '冻雨',
  67: '强冻雨',
  71: '小雪',
  73: '中雪',
  75: '大雪',
  77: '米雪',
  80: '阵雨',
  81: '较强阵雨',
  82: '强阵雨',
  85: '小阵雪',
  86: '大阵雪',
  95: '雷阵雨',
  96: '雷阵雨夹冰雹',
  99: '强雷阵雨夹冰雹',
};

/** WMO 天气码 → 中文。认不出来的码返回空串，宁可不说也不要瞎说。 */
export function weatherCodeText(code) {
  const n = Number(code);
  if (!Number.isFinite(n)) return '';
  return WEATHER_CODE_TEXT[n] ?? '';
}

function periodOf(hour) {
  if (hour < 5) return '凌晨';
  if (hour < 8) return '早上';
  if (hour < 11) return '上午';
  if (hour < 13) return '中午';
  if (hour < 17) return '下午';
  if (hour < 19) return '傍晚';
  if (hour < 23) return '晚上';
  return '深夜';
}

function seasonOf(month) {
  if (month >= 3 && month <= 5) return '春天';
  if (month >= 6 && month <= 8) return '夏天';
  if (month >= 9 && month <= 11) return '秋天';
  return '冬天';
}

/** 按指定时区拆出年月日时分与星期。时区写错时退回本机时区，不能让感知模块把程序搞崩。 */
export function zonedParts(date, timeZone) {
  const build = (tz) => {
    const fmt = new Intl.DateTimeFormat('zh-CN', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      weekday: 'long',
    });
    const out = {};
    for (const p of fmt.formatToParts(date)) if (p.type !== 'literal') out[p.type] = p.value;
    return out;
  };
  try {
    return build(timeZone);
  } catch {
    try {
      return build(Intl.DateTimeFormat().resolvedOptions().timeZone);
    } catch {
      const pad = (n) => String(n).padStart(2, '0');
      return {
        year: String(date.getFullYear()),
        month: pad(date.getMonth() + 1),
        day: pad(date.getDate()),
        hour: pad(date.getHours()),
        minute: pad(date.getMinutes()),
        weekday: '星期' + '日一二三四五六'[date.getDay()],
      };
    }
  }
}

/** 「现在是 2026年10月13日 星期二 晚上 19:30（秋天）」。 */
export function describeTime(date = new Date(), timeZone = 'Asia/Shanghai') {
  const p = zonedParts(date, timeZone);
  const hour = Number(p.hour);
  const month = Number(p.month);
  const day = Number(p.day);
  const period = periodOf(hour);
  const season = seasonOf(month);
  const today = `${Number(p.year)}年${month}月${day}日`;
  return `现在是 ${today} ${p.weekday} ${period} ${p.hour}:${p.minute}（${season}）`;
}

/** 「距上次说话：3 天前」。不到 1 分钟就不提，免得每句话都说"刚刚"。 */
export function describeGap(fromTs, toTs) {
  const from = Number(fromTs) || 0;
  const to = Number(toTs) || 0;
  if (!from || !to || to <= from) return '';
  const minutes = Math.floor((to - from) / 60000);
  if (minutes < 1) return '';
  if (minutes < 60) return `距上次说话：${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `距上次说话：${hours} 小时前`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `距上次说话：${days} 天前`;
  const months = Math.floor(days / 30);
  if (months < 12) return `距上次说话：约 ${months} 个月前`;
  return `距上次说话：约 ${Math.floor(months / 12)} 年前`;
}

/** 把 open-meteo 的返回压成一句人话。 */
export function formatWeather(data, name) {
  const cur = data?.current;
  if (!cur || !Number.isFinite(Number(cur.temperature_2m))) return '';
  const parts = [`${name ? `${name} ` : ''}现在 ${round1(cur.temperature_2m)}°C`];
  const feel = Number(cur.apparent_temperature);
  if (Number.isFinite(feel) && Math.abs(feel - Number(cur.temperature_2m)) >= 1.5) {
    parts.push(`体感 ${round1(feel)}°C`);
  }
  const code = weatherCodeText(cur.weather_code);
  if (code) parts.push(code);
  const hum = Number(cur.relative_humidity_2m);
  if (Number.isFinite(hum)) parts.push(`湿度 ${Math.round(hum)}%`);
  const wind = Number(cur.wind_speed_10m);
  if (Number.isFinite(wind) && wind >= 1) parts.push(`风 ${round1(wind)}km/h`);

  const daily = data?.daily;
  const max = Number(daily?.temperature_2m_max?.[0]);
  const min = Number(daily?.temperature_2m_min?.[0]);
  const dayCode = weatherCodeText(daily?.weather_code?.[0]);
  if (Number.isFinite(max) && Number.isFinite(min)) {
    parts.push(`今天 ${round1(min)}～${round1(max)}°C${dayCode ? ` ${dayCode}` : ''}`);
  }
  const tMax = Number(daily?.temperature_2m_max?.[1]);
  const tMin = Number(daily?.temperature_2m_min?.[1]);
  const tCode = weatherCodeText(daily?.weather_code?.[1]);
  if (Number.isFinite(tMax) && Number.isFinite(tMin)) {
    parts.push(`明天 ${round1(tMin)}～${round1(tMax)}°C${tCode ? ` ${tCode}` : ''}`);
  }
  return parts.join('，');
}

function round1(v) {
  const n = Number(v);
  return Number.isFinite(n) ? String(Math.round(n * 10) / 10) : '';
}

export class Awareness {
  #cfg;
  #weatherText = '';
  #weatherAt = 0;
  #failUntil = 0;
  #timer = null;
  #refreshing = null;

  constructor(cfg) {
    this.#cfg = cfg?.awareness ?? {};
    this.timezone = this.#cfg.timezone || 'Asia/Shanghai';
    this.location = this.#cfg.location ?? {};
  }

  get enabled() {
    return this.#cfg.enabled !== false;
  }

  get weatherEnabled() {
    return this.enabled && this.#cfg.weather?.enabled !== false && this.#hasLocation();
  }

  #hasLocation() {
    return Number.isFinite(Number(this.location.latitude)) && Number.isFinite(Number(this.location.longitude));
  }

  /** 当前缓存到的天气文本（可能是空的，那是正常的 —— 第一条消息发出去时还没查到）。 */
  get weatherText() {
    return this.#weatherText;
  }

  get weatherAgeMs() {
    return this.#weatherAt ? Date.now() - this.#weatherAt : Infinity;
  }

  /**
   * 立刻取一次天气并写进缓存。失败不抛错 —— 天气拿不到只是少一句话，
   * 不该让整条回复链断掉。
   */
  async refreshWeather({ force = false } = {}) {
    if (!this.weatherEnabled) return '';
    const now = Date.now();
    const ttl = Number(this.#cfg.weather?.refreshMs ?? 1800000);
    if (!force && this.#weatherAt && now - this.#weatherAt < ttl) return this.#weatherText;
    if (!force && now < this.#failUntil) return this.#weatherText;
    if (this.#refreshing) return this.#refreshing;

    const timeoutMs = Number(this.#cfg.weather?.timeoutMs ?? 8000);
    this.#refreshing = (async () => {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      const tz = encodeURIComponent(this.timezone);
      const url =
        `https://api.open-meteo.com/v1/forecast?latitude=${encodeURIComponent(this.location.latitude)}` +
        `&longitude=${encodeURIComponent(this.location.longitude)}` +
        '&current=temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m' +
        `&daily=temperature_2m_max,temperature_2m_min,weather_code&timezone=${tz}&forecast_days=2`;
      try {
        const res = await fetch(url, { signal: ctrl.signal });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        const text = formatWeather(data, this.location.name ?? '');
        if (!text) throw new Error('返回数据里没有可用的天气字段');
        this.#weatherText = text;
        this.#weatherAt = Date.now();
        this.#failUntil = 0;
        logger.debug(`天气已更新：${text}`);
        return text;
      } catch (err) {
        // 失败后不要每条消息都重试：退避一段时间，等下一轮。
        this.#failUntil = Date.now() + Number(this.#cfg.weather?.retryOnFailMs ?? 120000);
        logger.warn(`取天气失败（${err.name === 'AbortError' ? `超时 ${timeoutMs}ms` : err.message}），先不报天气`);
        return this.#weatherText;
      } finally {
        clearTimeout(timer);
      }
    })();
    try {
      return await this.#refreshing;
    } finally {
      this.#refreshing = null;
    }
  }

  /** 后台定时刷新。定时器 unref，不阻止进程退出。 */
  start() {
    if (!this.weatherEnabled || this.#timer) return;
    const period = Math.max(60000, Number(this.#cfg.weather?.refreshMs ?? 1800000));
    void this.refreshWeather({ force: true });
    this.#timer = setInterval(() => void this.refreshWeather({ force: true }), period);
    if (typeof this.#timer.unref === 'function') this.#timer.unref();
  }

  stop() {
    if (this.#timer) {
      clearInterval(this.#timer);
      this.#timer = null;
    }
  }

  /**
   * 拼出"此刻的感知"。同步、纯读缓存，绝不发网络请求 —— 它跑在回复主链路上。
   * 返回事实行数组；为空表示这次什么也不用说（比如没配天气又没什么时间差）。
   */
  snapshot({ now = new Date(), lastTs = 0 } = {}) {
    if (!this.enabled) return [];
    const facts = [describeTime(now, this.timezone)];
    if (this.#weatherText) facts.push(`天气：${this.#weatherText}`);
    if (this.#cfg.gap !== false) {
      const gap = describeGap(lastTs, now.getTime());
      if (gap) facts.push(gap);
    }
    return facts;
  }
}
