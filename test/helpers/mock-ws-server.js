import crypto from 'node:crypto';
import http from 'node:http';
import { EventEmitter } from 'node:events';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

/**
 * 极简 WebSocket 服务端，仅用于离线测试 OneBot 客户端。
 * 支持文本帧、ping/pong、7/16/64 位长度；不支持分片。
 */
export class MockOneBotServer extends EventEmitter {
  constructor() {
    super();
    this.server = http.createServer((req, res) => {
      res.writeHead(426);
      res.end('Upgrade Required');
    });
    this.sockets = new Set();
    this.apiCalls = [];
    this.apiHandlers = new Map();
    this.port = 0;
    this.server.on('upgrade', (req, socket) => this.#handleUpgrade(req, socket));
  }

  listen(port = 0) {
    return new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(port, '127.0.0.1', () => {
        this.port = this.server.address().port;
        resolve(this.port);
      });
    });
  }

  get url() {
    return `ws://127.0.0.1:${this.port}`;
  }

  /** 注册某个 action 的响应。fn(params, call) 返回 data 对象或 Promise。 */
  onApi(action, fn) {
    this.apiHandlers.set(action, fn);
    return this;
  }

  /** 向所有已连接客户端推送事件对象。 */
  push(payload) {
    const text = JSON.stringify(payload);
    for (const socket of this.sockets) socket.write(encodeFrame(text));
  }

  /** 等待收到某个 action 的调用，返回 { params, data }。 */
  waitForApi(action, { timeoutMs = 5000 } = {}) {
    const existing = this.apiCalls.find((c) => c.action === action);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.off('api', onApi);
        reject(new Error(`等待 ${action} 超时（${timeoutMs}ms）`));
      }, timeoutMs);
      const onApi = (call) => {
        if (call.action !== action) return;
        clearTimeout(timer);
        this.off('api', onApi);
        resolve(call);
      };
      this.on('api', onApi);
    });
  }

  callsOf(action) {
    return this.apiCalls.filter((c) => c.action === action);
  }

  #handleUpgrade(req, socket) {
    const key = req.headers['sec-websocket-key'];
    if (!key) {
      socket.destroy();
      return;
    }
    const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    socket.setNoDelay(true);
    this.sockets.add(socket);
    this.emit('connection', socket);

    let buf = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      for (;;) {
        const frame = decodeFrame(buf);
        if (!frame) break;
        buf = buf.subarray(frame.totalLength);
        if (frame.opcode === 0x8) {
          socket.end();
          return;
        }
        if (frame.opcode === 0x9) {
          socket.write(encodeFrame(frame.payload, 0xa));
          continue;
        }
        if (frame.opcode !== 0x1) continue;
        let payload;
        try {
          payload = JSON.parse(frame.payload.toString('utf8'));
        } catch {
          continue;
        }
        this.#onClientMessage(socket, payload);
      }
    });
    socket.on('error', () => {});
    socket.on('close', () => this.sockets.delete(socket));
  }

  async #onClientMessage(socket, payload) {
    if (payload?.echo === undefined) return;
    const action = payload.action;
    const params = payload.params ?? {};
    const handlers = this.apiHandlers;
    let data = {};
    if (handlers.has(action)) {
      try {
        data = (await handlers.get(action)(params, payload)) ?? {};
      } catch (err) {
        socket.write(
          encodeFrame(JSON.stringify({ status: 'failed', retcode: 1, message: err.message, echo: payload.echo })),
        );
        return;
      }
    }
    const call = { action, params, data, raw: payload };
    this.apiCalls.push(call);
    this.emit('api', call);
    socket.write(encodeFrame(JSON.stringify({ status: 'ok', retcode: 0, data, echo: payload.echo })));
  }

  async close() {
    for (const socket of this.sockets) {
      try {
        socket.destroy();
      } catch {
        /* ignore */
      }
    }
    this.sockets.clear();
    await new Promise((resolve) => this.server.close(resolve));
  }
}

export function decodeFrame(buf) {
  if (buf.length < 2) return null;
  const b0 = buf[0];
  const b1 = buf[1];
  const opcode = b0 & 0x0f;
  const masked = (b1 & 0x80) === 0x80;
  let len = b1 & 0x7f;
  let offset = 2;
  if (len === 126) {
    if (buf.length < 4) return null;
    len = buf.readUInt16BE(2);
    offset = 4;
  } else if (len === 127) {
    if (buf.length < 10) return null;
    len = Number(buf.readBigUInt64BE(2));
    offset = 10;
  }
  let maskKey = null;
  if (masked) {
    if (buf.length < offset + 4) return null;
    maskKey = buf.subarray(offset, offset + 4);
    offset += 4;
  }
  if (buf.length < offset + len) return null;
  const payload = Buffer.from(buf.subarray(offset, offset + len));
  if (maskKey) for (let i = 0; i < payload.length; i += 1) payload[i] ^= maskKey[i % 4];
  return { opcode, payload, totalLength: offset + len };
}

export function encodeFrame(payload, opcode = 0x1) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'utf8');
  const len = data.length;
  let header;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  header[0] = 0x80 | opcode;
  return Buffer.concat([header, data]);
}

/** 轮询等待条件成立。 */
export async function waitFor(predicate, { timeoutMs = 5000, intervalMs = 20 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = predicate();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`waitFor 超时（${timeoutMs}ms）`);
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}
