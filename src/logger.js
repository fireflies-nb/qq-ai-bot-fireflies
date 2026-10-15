const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

let current = LEVELS[process.env.LOG_LEVEL] ?? LEVELS.info;

function stamp() {
  const d = new Date();
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function emit(level, args) {
  if (LEVELS[level] < current) return;
  const line = `[${stamp()}] ${level.toUpperCase().padEnd(5)} ${args
    .map((a) => (typeof a === 'string' ? a : inspect(a)))
    .join(' ')}`;
  if (level === 'error' || level === 'warn') console.error(line);
  else console.log(line);
}

function inspect(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export const logger = {
  debug: (...a) => emit('debug', a),
  info: (...a) => emit('info', a),
  warn: (...a) => emit('warn', a),
  error: (...a) => emit('error', a),
  setLevel(level) {
    if (LEVELS[level]) current = LEVELS[level];
  },
  get level() {
    return Object.keys(LEVELS).find((k) => LEVELS[k] === current) ?? 'info';
  },
};
