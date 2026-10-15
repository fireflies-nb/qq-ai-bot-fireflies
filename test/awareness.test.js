import test from 'node:test';
import assert from 'node:assert/strict';

const {
  Awareness, describeGap, describeTime, formatWeather, weatherCodeText, zonedParts,
} = await import('../src/awareness.js');
const { DEFAULTS, deepMerge } = await import('../src/config.js');

function makeCfg(overrides = {}) {
  return deepMerge(DEFAULTS, overrides);
}

/** 极简 open-meteo 假响应。 */
function fakeWeather() {
  return {
    current: {
      time: '2026-10-13T19:30',
      temperature_2m: 23.8,
      apparent_temperature: 23.8,
      relative_humidity_2m: 59,
      weather_code: 0,
      wind_speed_10m: 12.3,
      is_day: 0,
    },
    daily: {
      temperature_2m_max: [29, 27],
      temperature_2m_min: [21.6, 20.1],
      weather_code: [2, 61],
    },
  };
}

/** 临时替换全局 fetch，返回一个固定的 open-meteo 响应。 */
async function withFetch(impl, fn) {
  const real = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (...args) => {
    calls.push(args[0]);
    return impl(...args);
  };
  try {
    return await fn(calls);
  } finally {
    globalThis.fetch = real;
  }
}

function okJson(body) {
  return { ok: true, status: 200, json: async () => body };
}

// ---------------------------------------------------------------------------
// 纯函数
// ---------------------------------------------------------------------------

test('weatherCodeText：认识的码给中文，不认识的返回空串（宁可不说也不瞎说）', () => {
  assert.equal(weatherCodeText(0), '晴');
  assert.equal(weatherCodeText(2), '多云');
  assert.equal(weatherCodeText(61), '小雨');
  assert.equal(weatherCodeText(95), '雷阵雨');
  // 99 在表里，100 不在
  assert.equal(weatherCodeText(99), '强雷阵雨夹冰雹');
  assert.equal(weatherCodeText(100), '');
  assert.equal(weatherCodeText(undefined), '');
  assert.equal(weatherCodeText('abc'), '');
});

test('describeTime：按指定时区换算，北京时间比 UTC 早 8 小时', () => {
  // UTC 23:05 → 北京次日 07:05（早上）
  const s = describeTime(new Date(Date.UTC(2026, 9, 13, 23, 5)), 'Asia/Shanghai');
  assert.match(s, /2026年10月14日/);
  assert.match(s, /早上/);
  assert.match(s, /07:05/);
  assert.match(s, /秋天/);
});

test('describeTime：时段划分覆盖凌晨/早上/上午/中午/下午/傍晚/晚上/深夜', () => {
  const at = (utcHour) => describeTime(new Date(Date.UTC(2026, 9, 13, utcHour, 0)), 'UTC');
  assert.match(at(3), /凌晨/);
  assert.match(at(6), /早上/);
  assert.match(at(9), /上午/);
  assert.match(at(12), /中午/);
  assert.match(at(15), /下午/);
  assert.match(at(18), /傍晚/);
  assert.match(at(20), /晚上/);
  assert.match(at(23), /深夜/);
});

test('describeTime：季节按月份判定', () => {
  const at = (month) => describeTime(new Date(Date.UTC(2026, month - 1, 15, 4, 0)), 'UTC');
  assert.match(at(4), /春天/);
  assert.match(at(7), /夏天/);
  assert.match(at(10), /秋天/);
  assert.match(at(1), /冬天/);
  assert.match(at(12), /冬天/);
});

test('zonedParts：时区非法时退回本机时区，不抛错（感知模块不能把程序搞崩）', () => {
  const parts = zonedParts(new Date('2026-10-13T11:30:00Z'), 'Not/AZone');
  assert.ok(parts.year, '应该有年份');
  assert.ok(parts.hour !== undefined, '应该有小时');
  assert.match(parts.weekday, /星期/);
});

test('describeGap：分钟/小时/天/月/年，以及"不到 1 分钟就不提"', () => {
  const base = 1_800_000_000_000;
  assert.equal(describeGap(base, base + 30_000), '', '不到 1 分钟应该返回空串');
  assert.equal(describeGap(0, base), '', '没有上一条消息时返回空串');
  assert.match(describeGap(base, base + 5 * 60000), /5 分钟前/);
  assert.match(describeGap(base, base + 3 * 3600_000), /3 小时前/);
  assert.match(describeGap(base, base + 2 * 86400_000), /2 天前/);
  assert.match(describeGap(base, base + 65 * 86400_000), /约 2 个月前/);
  assert.match(describeGap(base, base + 400 * 86400_000), /约 1 年前/);
});

test('formatWeather：压成一句人话，含今天与明天', () => {
  const s = formatWeather(fakeWeather(), '杭州');
  assert.match(s, /^杭州 现在 23\.8°C/);
  assert.match(s, /晴/);
  assert.match(s, /湿度 59%/);
  assert.match(s, /风 12\.3km\/h/);
  assert.match(s, /今天 21\.6～29°C 多云/);
  assert.match(s, /明天 20\.1～27°C 小雨/);
  // 体感 23.8 与实测 23.8 只差 0，应该省略
  assert.doesNotMatch(s, /体感/);
});

test('formatWeather：体感差得明显才报，风太小不报（少说废话）', () => {
  const data = fakeWeather();
  data.current.apparent_temperature = 19.5;
  data.current.wind_speed_10m = 0.4;
  const s = formatWeather(data, '杭州');
  assert.match(s, /体感 19\.5°C/);
  assert.doesNotMatch(s, /风 /);
});

test('formatWeather：数据不可用时返回空串，不编造', () => {
  assert.equal(formatWeather(null, '杭州'), '');
  assert.equal(formatWeather({}, '杭州'), '');
  assert.equal(formatWeather({ current: {} }, '杭州'), '');
});

// ---------------------------------------------------------------------------
// Awareness
// ---------------------------------------------------------------------------

test('Awareness.snapshot：同步返回时间，且绝不发网络请求（它跑在回复主链路上）', async () => {
  const awareness = new Awareness(makeCfg());
  await withFetch(async () => {
    throw new Error('snapshot 不应该调用 fetch');
  }, async () => {
    const facts = awareness.snapshot({ now: new Date(Date.UTC(2026, 9, 13, 11, 30)) });
    assert.equal(facts.length, 1);
    assert.match(facts[0], /^现在是 /);
    assert.match(facts[0], /19:30/);
  });
});

test('Awareness.snapshot：天气抓回来后进快照；距上次说话按 lastTs 算', async () => {
  const awareness = new Awareness(makeCfg());
  await withFetch(async () => okJson(fakeWeather()), async () => {
    await awareness.refreshWeather();
  });
  const now = new Date(Date.UTC(2026, 9, 13, 11, 30));
  const facts = awareness.snapshot({ now, lastTs: now.getTime() - 3 * 3600_000 });
  assert.equal(facts.length, 3);
  assert.match(facts[1], /^天气：杭州 现在 23\.8°C/);
  assert.match(facts[2], /3 小时前/);
});

test('Awareness：gap 关掉后就不提"距上次说话"', async () => {
  const awareness = new Awareness(makeCfg({ awareness: { gap: false } }));
  await withFetch(async () => okJson(fakeWeather()), async () => {
    await awareness.refreshWeather();
  });
  const now = new Date(Date.UTC(2026, 9, 13, 11, 30));
  const facts = awareness.snapshot({ now, lastTs: now.getTime() - 3 * 3600_000 });
  assert.equal(facts.length, 2);
  assert.ok(!facts.some((f) => f.includes('距上次说话')));
});

test('Awareness.refreshWeather：TTL 内重复调用不打第二次网络请求', async () => {
  const awareness = new Awareness(makeCfg());
  await withFetch(async () => okJson(fakeWeather()), async (calls) => {
    await awareness.refreshWeather();
    await awareness.refreshWeather();
    await awareness.refreshWeather();
    assert.equal(calls.length, 1, '缓存命中时不该再发请求');
    assert.match(awareness.weatherText, /杭州/);
  });
});

test('Awareness.refreshWeather：取天气失败不抛错，只静默跳过（不能拖垮回复）', async () => {
  const awareness = new Awareness(makeCfg());
  await withFetch(async () => {
    throw new Error('network down');
  }, async () => {
    const out = await awareness.refreshWeather();
    assert.equal(out, '');
    assert.equal(awareness.weatherText, '');
    assert.equal(awareness.snapshot({ now: new Date() }).length, 1, '只剩时间那一行');
  });
});

test('Awareness.refreshWeather：HTTP 非 200 也走失败分支，不写脏缓存', async () => {
  const awareness = new Awareness(makeCfg());
  await withFetch(async () => ({ ok: false, status: 502, json: async () => ({}) }), async () => {
    await awareness.refreshWeather();
    assert.equal(awareness.weatherText, '');
  });
});

test('Awareness.refreshWeather：失败后进入退避，不每条消息都撞超时', async () => {
  const awareness = new Awareness(makeCfg());
  await withFetch(async () => {
    throw new Error('boom');
  }, async (calls) => {
    await awareness.refreshWeather();
    await awareness.refreshWeather();
    assert.equal(calls.length, 1, '退避期内不该重试');
  });
});

test('Awareness.refreshWeather：force 会无视 TTL 与退避重新拉', async () => {
  const awareness = new Awareness(makeCfg());
  await withFetch(async () => okJson(fakeWeather()), async (calls) => {
    await awareness.refreshWeather();
    await awareness.refreshWeather({ force: true });
    assert.equal(calls.length, 2);
  });
});

test('Awareness.refreshWeather：并发调用复用同一个请求，不会打两次', async () => {
  const awareness = new Awareness(makeCfg());
  await withFetch(async () => {
    await new Promise((r) => setTimeout(r, 30));
    return okJson(fakeWeather());
  }, async (calls) => {
    await Promise.all([
      awareness.refreshWeather(),
      awareness.refreshWeather(),
      awareness.refreshWeather(),
    ]);
    assert.equal(calls.length, 1);
  });
});

test('Awareness：天气关掉 / 坐标非法时不请求，也不报天气', async () => {
  const off = new Awareness(makeCfg({ awareness: { weather: { enabled: false } } }));
  assert.equal(off.weatherEnabled, false);
  const bad = new Awareness(makeCfg({ awareness: { location: { name: 'X', latitude: 'a', longitude: 'b' } } }));
  assert.equal(bad.weatherEnabled, false);
  await withFetch(async () => {
    throw new Error('不该请求');
  }, async () => {
    assert.equal(await off.refreshWeather({ force: true }), '');
    assert.equal(await bad.refreshWeather({ force: true }), '');
  });
});

test('Awareness：enabled=false 时快照为空（整块感知都能关掉）', () => {
  const awareness = new Awareness(makeCfg({ awareness: { enabled: false } }));
  assert.equal(awareness.enabled, false);
  assert.deepEqual(awareness.snapshot({ now: new Date() }), []);
});

test('Awareness.start/stop：定时器可停，且不阻止进程退出', () => {
  const awareness = new Awareness(makeCfg());
  // start 会立刻拉一次；不给网络，失败也无所谓
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error('no net');
  };
  try {
    awareness.start();
    awareness.stop();
    awareness.stop(); // 重复 stop 不应抛错
  } finally {
    globalThis.fetch = realFetch;
  }
});
