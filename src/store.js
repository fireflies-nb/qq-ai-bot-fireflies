import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { logger } from './logger.js';
import { clusterMemories, isSameMemory } from './textsim.js';

/**
 * 会话历史落盘。用 Node 自带的 node:sqlite，零依赖。
 * 只存文本，不存图片/文件原始内容。
 */
export class Store {
  constructor(dbPath, { retentionDays = 30 } = {}) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.retentionDays = retentionDays;
    this.#migrate();
  }

  #migrate() {
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS messages (
        id        INTEGER PRIMARY KEY AUTOINCREMENT,
        scope     TEXT NOT NULL,      -- 'group' | 'private'
        scope_id  TEXT NOT NULL,      -- group_id 或 user_id
        sender_id TEXT NOT NULL,
        sender    TEXT NOT NULL,      -- 显示名
        role      TEXT NOT NULL,      -- 'user' | 'assistant'
        origin    TEXT NOT NULL DEFAULT 'user', -- 'user' | 'ai' | 'human'
        text      TEXT NOT NULL,
        ts        INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_msg_scope ON messages(scope, scope_id, ts);

      CREATE TABLE IF NOT EXISTS state (
        k TEXT PRIMARY KEY,
        v TEXT NOT NULL
      );

      -- 长期记忆：从对话里抽取出来的、关于某个人的稳定事实。
      -- 它**不受 retentionDays 清理影响**，长期记忆的价值就在这里；用条数上限保护体积。
      CREATE TABLE IF NOT EXISTS memories (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        scope        TEXT NOT NULL,          -- 'group' | 'private'
        scope_id     TEXT NOT NULL,
        subject      TEXT NOT NULL,          -- 这条记忆是关于谁的（QQ 号，'self' 表示关于她自己）
        text         TEXT NOT NULL,          -- 一句话事实，会直接进模型上下文
        kind         TEXT NOT NULL DEFAULT 'fact', -- 'fact' | 'event' | 'preference' | 'relation'
        norm         TEXT NOT NULL,          -- 归一化文本，仅用于去重比对
        hits         INTEGER NOT NULL DEFAULT 1,   -- 被重复提到/强化的次数，作重要度信号
        created_at   INTEGER NOT NULL,
        updated_at   INTEGER NOT NULL,
        last_used_at INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_mem_scope ON memories(scope, scope_id, updated_at);
      CREATE INDEX IF NOT EXISTS idx_mem_subject ON memories(scope, scope_id, subject);
    `);
    // 兼容早期版本的库文件（缺 origin 列）
    const cols = this.db.prepare('PRAGMA table_info(messages)').all().map((c) => c.name);
    if (!cols.includes('origin')) {
      this.db.exec("ALTER TABLE messages ADD COLUMN origin TEXT NOT NULL DEFAULT 'user'");
    }
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_msg_origin ON messages(scope, scope_id, role, origin, ts)');
  }

  addMessage({ scope, scopeId, senderId, sender, role, origin = 'user', text, ts = Date.now() }) {
    this.db
      .prepare(
        `INSERT INTO messages (scope, scope_id, sender_id, sender, role, origin, text, ts)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        String(scope), String(scopeId), String(senderId), String(sender),
        String(role), String(origin), String(text), Number(ts),
      );
  }

  /** 取最近 limit 条，按时间正序返回（可直接喂给模型）。字段为 camelCase。 */
  recent(scope, scopeId, limit) {
    const rows = this.db
      .prepare(
        `SELECT sender_id AS senderId, sender, role, origin, text, ts FROM messages
         WHERE scope = ? AND scope_id = ?
         ORDER BY id DESC LIMIT ?`,
      )
      .all(String(scope), String(scopeId), Number(limit));
    return rows.map((r) => ({ ...r, ts: Number(r.ts) })).reverse();
  }

  /**
   * 取最近 turns 轮对话，按时间正序返回。
   *
   * 一轮 = 对方的一条消息 + 紧随其后的若干条助手回复。
   * 为什么要有它：`recent()` 按**行**取，而实测私聊里最近 20 行中 AI 自己占 13 行
   * （65%），窗口边界经常落在一轮中间 —— 开头那半条助手消息会被 buildMessages
   * 丢掉（首条非 system 不能是 assistant），等于白占额度。
   *
   * 实现：先按行多取一些（每轮最多算 maxPerTurn 条助手消息，留足余量），
   * 再从后往前数 turns 个"对方发言"的位置切一刀。多取的那部分由调用方的
   * 字数预算与 buildMessages 兜底，不会真的全部进模型。
   */
  recentTurns(scope, scopeId, turns, { maxPerTurn = 6 } = {}) {
    const want = Math.max(1, Number(turns) || 1);
    const cap = Math.max(1, Number(maxPerTurn) || 6);
    const rows = this.db
      .prepare(
        `SELECT sender_id AS senderId, sender, role, origin, text, ts FROM messages
         WHERE scope = ? AND scope_id = ?
         ORDER BY id DESC LIMIT ?`,
      )
      .all(String(scope), String(scopeId), want * (cap + 1))
      .map((r) => ({ ...r, ts: Number(r.ts) }))
      .reverse();

    let seen = 0;
    let start = -1;
    for (let i = rows.length - 1; i >= 0; i -= 1) {
      if (rows[i].role !== 'assistant') {
        seen += 1;
        start = i;
        if (seen >= want) break;
      }
    }
    // 一轮都不够（消息太少）就全给它，交给上层预算裁剪。
    return start >= 0 ? rows.slice(start) : rows;
  }

  /**
   * 取最近 turns 轮里"她自己说过的话"（origin='ai' 的助手消息）。
   *
   * 这条链路是实测逼出来的：模型只看得到拼接后的对话历史，而她自己的连发气泡
   * 会被合并成一条 assistant 消息；一旦某句话滑出窗口，她就完全不知道
   * 自己说过什么 —— 实测出现过"重复答应同一件事""编造共同的过去"两个症状。
   * 这里把最近几轮里她的话单独拎出来，让上层可以明确地告诉她"这是你刚说过的"。
   *
   * 只取 origin='ai'：origin='human' 是号主本人手打的，不算她说的。
   */
  recentSelfTexts(scope, scopeId, turns, { maxPerTurn = 6, limit = 20 } = {}) {
    return this.recentTurns(scope, scopeId, turns, { maxPerTurn })
      .filter((r) => r.role === 'assistant' && r.origin === 'ai')
      .slice(-Math.max(1, Number(limit) || 20))
      .map((r) => r.text);
  }

  /**
   * 该会话里最后一条"你本人手打"的消息时间戳（origin='human'）。
   * 用于主动接管判断：你自己在 QQ 客户端回过话后，AI 应退避一段时间。
   * 必须排除 origin='ai'，否则 AI 自己发的回复会把自己锁死。
   */
  lastSelfTs(scope, scopeId) {
    const row = this.db
      .prepare(
        `SELECT ts FROM messages
         WHERE scope = ? AND scope_id = ? AND role = 'assistant' AND origin = 'human'
         ORDER BY id DESC LIMIT 1`,
      )
      .get(String(scope), String(scopeId));
    return row ? Number(row.ts) : 0;
  }

  /** 记录已处理过的 message_id，避免重复触发。 */
  seenMessage(messageId, ttlMs) {
    const key = `seen:${messageId}`;
    const now = Date.now();
    const row = this.db.prepare('SELECT v FROM state WHERE k = ?').get(key);
    if (row) {
      if (now - Number(row.v) < ttlMs) return true;
    }
    this.db
      .prepare('INSERT INTO state (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v')
      .run(key, String(now));
    return false;
  }

  setState(k, v) {
    this.db
      .prepare('INSERT INTO state (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v')
      .run(String(k), JSON.stringify(v));
  }

  getState(k, fallback = null) {
    const row = this.db.prepare('SELECT v FROM state WHERE k = ?').get(String(k));
    if (!row) return fallback;
    try {
      return JSON.parse(row.v);
    } catch {
      return fallback;
    }
  }

  /** 归一化：去掉空格、标点、符号，转小写。用于判断两条记忆是不是同一件事。 */
  static normText(text) {
    return String(text ?? '')
      .replace(/[\s\p{P}\p{S}]+/gu, '')
      .toLowerCase();
  }

  /**
   * 写入一条记忆。
   *
   * 两道去重，按"代价从小到大"的顺序：
   *   ① 精确：同一会话 + 同一对象下归一化后完全相同 → 只强化（hits+1）。便宜且绝对安全。
   *   ② 近似（可选，传 `merge` 才开）：换个说法的同一条 → 也合并进已有那条。
   *      必要性是实测出来的：真机记忆库 73 条里 36% 是冗余，"阿澈在下午三点四十下课，
   *      上午加半个下午都有课"这一件事存了 6 种说法，检索时 6 个名额被同一件事占满，
   *      模型会误判"这件事特别重要"而反复提。
   *
   * 近似合并的取舍：**保留已有那条的文本**（它可能已被反复提到、更接近"主版本"），
   * 只把 hits+1。不覆盖文本是因为比较本身可能出错，覆盖会把错的那句永久写成正确答案；
   * 而合并错了顶多是少存一条细节，比损坏信息轻。
   * 判定规则见 textsim.js，阈值是实测调出来的，不要凭感觉改。
   */
  addMemory({ scope, scopeId, subject, text, kind = 'fact', ts = Date.now() }, { merge = null, maxCandidates = 200 } = {}) {
    const value = String(text ?? '').trim();
    if (!value) return null;
    const norm = Store.normText(value);
    if (!norm) return null;
    const at = Number(ts);
    const s = String(scope);
    const sid = String(scopeId);
    const subj = String(subject);
    const existing = this.db
      .prepare('SELECT id, hits FROM memories WHERE scope = ? AND scope_id = ? AND subject = ? AND norm = ?')
      .get(s, sid, subj, norm);
    if (existing) {
      this.db
        .prepare('UPDATE memories SET text = ?, kind = ?, hits = hits + 1, updated_at = ? WHERE id = ?')
        .run(value, String(kind), at, existing.id);
      return { id: Number(existing.id), updated: true, matched: 'exact' };
    }

    // ② 近似合并。只在同一个 subject 内比较 —— 跨主体合并没有意义，也更容易出错。
    if (merge && merge.enabled !== false) {
      const hit = this.#findSimilarMemory({ scope: s, scopeId: sid, subject: subj, text: value, limit: maxCandidates, opts: merge });
      if (hit) {
        this.db
          .prepare('UPDATE memories SET hits = hits + 1, kind = ?, updated_at = ? WHERE id = ?')
          .run(String(kind), at, hit.id);
        return { id: hit.id, updated: true, matched: hit.reason, similarTo: hit.id };
      }
    }

    const info = this.db
      .prepare(
        `INSERT INTO memories (scope, scope_id, subject, text, kind, norm, hits, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`,
      )
      .run(s, sid, subj, value, String(kind), norm, at, at);
    return { id: Number(info.lastInsertRowid), updated: false };
  }

  /**
   * 在同一 scope + subject 下找一条"和新文本是同一件事"的已有记忆。
   * 候选按 hits 降序取 —— 优先和"主版本"合并，避免新条目跟某个冷门变体抱团。
   */
  #findSimilarMemory({ scope, scopeId, subject, text, limit = 200, opts = {} }) {
    const rows = this.db
      .prepare(
        `SELECT id, text, hits FROM memories
         WHERE scope = ? AND scope_id = ? AND subject = ?
         ORDER BY hits DESC, id DESC LIMIT ?`,
      )
      .all(String(scope), String(scopeId), String(subject), Math.max(1, Number(limit) || 200));
    let best = null;
    for (const row of rows) {
      const r = isSameMemory(row.text, text, opts);
      if (!r.same) continue;
      // 命中多条时选最像的（shared 多、Jaccard 高）。
      if (!best || r.metrics.shared > best.shared || (r.metrics.shared === best.shared && r.metrics.jaccard > best.jaccard)) {
        best = { id: Number(row.id), reason: r.reason, shared: r.metrics.shared, jaccard: r.metrics.jaccard };
      }
    }
    return best;
  }

  /**
   * 按 n-gram 检索记忆。返回按得分排序的候选，字段为 camelCase。
   *
   * 为什么用 LIKE 而不是 FTS5：FTS5 默认分词器对中文完全失效（整句当一个 token），
   * trigram 分词器又只能匹配 3 个汉字以上，"吉他""火锅"这类两字词查不到。
   * 实测 5000 条记忆下 16 次 LIKE + 排序只要 1ms，够用。
   */
  searchMemories({ scope, scopeId, grams, extraSubjects = [], limit = 8 }) {
    const list = Array.isArray(grams) ? grams.filter(Boolean) : [];
    if (list.length === 0) return [];
    const score = new Map();
    const rowsById = new Map();

    const like = (gram) => `%${String(gram).replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
    const sameSession = this.db.prepare(
      `SELECT id, scope, scope_id AS scopeId, subject, text, kind, hits, updated_at AS updatedAt
       FROM memories WHERE scope = ? AND scope_id = ? AND text LIKE ? ESCAPE '\\' LIMIT 80`,
    );
    const bySubject = this.db.prepare(
      `SELECT id, scope, scope_id AS scopeId, subject, text, kind, hits, updated_at AS updatedAt
       FROM memories WHERE subject = ? AND text LIKE ? ESCAPE '\\' LIMIT 80`,
    );

    const subjects = ['self', ...extraSubjects.map((s) => String(s))].filter(Boolean);
    for (const g of list) {
      // 一个 gram 只算一分。
      // 注意：同一条记忆可能**同时**被 sameSession 和 bySubject 两条查询捞到
      // （比如它就是"关于这个人"的记忆）。如果按查询次数累加，一个 gram 会变成 2 分，
      // minScore=2 的过滤就形同虚设，弱相关的记忆也会被召回。所以这里按 gram 去重。
      const matched = new Set();
      for (const r of sameSession.all(String(scope), String(scopeId), like(g))) {
        matched.add(r.id);
        rowsById.set(r.id, r);
      }
      for (const s of subjects) {
        for (const r of bySubject.all(s, like(g))) {
          matched.add(r.id);
          rowsById.set(r.id, r);
        }
      }
      for (const id of matched) score.set(id, (score.get(id) ?? 0) + 1);
    }

    // 得分 = 命中的 n-gram 数，同分时被强化次数多、更新时间近的优先。
    return [...score.entries()]
      .map(([id, hitCount]) => {
        const r = rowsById.get(id);
        return { ...r, score: hitCount, hits: Number(r.hits), updatedAt: Number(r.updatedAt) };
      })
      .sort((a, b) => b.score - a.score || b.hits - a.hits || b.updatedAt - a.updatedAt)
      .slice(0, Math.max(1, Number(limit)));
  }

  listMemories(scope, scopeId, { limit = 100, offset = 0 } = {}) {
    return this.db
      .prepare(
        `SELECT id, scope, scope_id AS scopeId, subject, text, kind, hits,
                created_at AS createdAt, updated_at AS updatedAt, last_used_at AS lastUsedAt
         FROM memories WHERE scope = ? AND scope_id = ?
         ORDER BY updated_at DESC LIMIT ? OFFSET ?`,
      )
      .all(String(scope), String(scopeId), Number(limit), Number(offset))
      .map((r) => ({ ...r, hits: Number(r.hits) }));
  }

  countMemories(scope, scopeId) {
    const row = this.db
      .prepare('SELECT COUNT(*) AS c FROM memories WHERE scope = ? AND scope_id = ?')
      .get(String(scope), String(scopeId));
    return Number(row?.c ?? 0);
  }

  /**
   * 列出库里出现过的所有会话，带上各自的记忆/消息条数。
   * 给 `scripts/dedupe-memories.mjs` 用 —— 清理时需要先知道有哪些会话。
   * 以 messages 表为准（记忆只在聊过天的会话里才会产生）。
   */
  listSessions() {
    return this.db
      .prepare(
        `SELECT m.scope AS scope, m.scope_id AS scopeId,
                COUNT(*) AS messages,
                (SELECT COUNT(*) FROM memories me WHERE me.scope = m.scope AND me.scope_id = m.scope_id) AS memories
         FROM messages m GROUP BY m.scope, m.scope_id ORDER BY m.scope, m.scope_id`,
      )
      .all()
      .map((r) => ({
        scope: String(r.scope),
        scopeId: String(r.scopeId),
        messages: Number(r.messages),
        memories: Number(r.memories),
      }));
  }

  /** 标记记忆被用过（用于将来做"久未提及的记忆优先遗忘"之类的策略）。 */
  touchMemories(ids, ts = Date.now()) {
    if (!Array.isArray(ids) || ids.length === 0) return 0;
    const stmt = this.db.prepare('UPDATE memories SET last_used_at = ? WHERE id = ?');
    let n = 0;
    for (const id of ids) {
      stmt.run(Number(ts), Number(id));
      n += 1;
    }
    return n;
  }

  deleteMemory(id) {
    return this.db.prepare('DELETE FROM memories WHERE id = ?').run(Number(id)).changes > 0;
  }

  /** 该会话最后一条消息的时间（含 AI 自己发的）。用于算"距上次说话多久"。 */
  lastMessageTs(scope, scopeId) {
    const row = this.db
      .prepare('SELECT ts FROM messages WHERE scope = ? AND scope_id = ? ORDER BY id DESC LIMIT 1')
      .get(String(scope), String(scopeId));
    return row ? Number(row.ts) : 0;
  }

  /** 长期记忆只按条数保护体积（不按时间删 —— 那就不叫长期记忆了）。 */
  pruneMemories(scope, scopeId, maxRows = 500) {
    const total = this.countMemories(scope, scopeId);
    if (total <= maxRows) return 0;
    const res = this.db
      .prepare(
        `DELETE FROM memories WHERE id IN (
           SELECT id FROM memories WHERE scope = ? AND scope_id = ?
           ORDER BY hits ASC, updated_at ASC LIMIT ?
         )`,
      )
      .run(String(scope), String(scopeId), total - maxRows);
    return Number(res.changes ?? 0);
  }

  /**
   * 清理**存量**近似重复：把「同一件事的多种说法」合并成一条。
   *
   * 前面两道去重（精确 + 近似）只能拦住**新写入**的重复，历史库里的冗余还在 ——
   * 实测真机 73 条里 36% 是冗余。这个方法负责把它们收拢。
   *
   * 合并方向：锚点优先取 hits 高的（被反复提到的那个说法更像"主版本"），
   * 保留锚点的文本，把其余成员的 hits 累加过去再删掉它们 ——
   * **不删信息、不覆盖文本**，只是把"同一件事"从 N 行压成 1 行。
   *
   * 用锚点式而不是并查集：并查集会把 A~B、B~C 串成一组，
   * 于是「称呼萤宝」和「一起治疗」这两个不同事实会通过一条同时提到两者的
   * 复合记忆被串在一起（实测真数据上真的发生了，7 条被串成一组）。
   *
   * `dryRun: true` 只报告不落库，用于先看会发生什么。
   */
  dedupeMemories(scope, scopeId, { dryRun = false, subject = null, limit = 1000, opts = {} } = {}) {
    const s = String(scope);
    const sid = String(scopeId);
    const where = subject ? 'AND subject = ?' : '';
    const params = subject ? [s, sid, String(subject)] : [s, sid];
    const rows = this.db
      .prepare(
        `SELECT id, subject, text, kind, hits FROM memories
         WHERE scope = ? AND scope_id = ? ${where}
         ORDER BY id ASC LIMIT ?`,
      )
      .all(...params, Math.max(1, Number(limit) || 1000))
      .map((r) => ({ ...r, id: Number(r.id), hits: Number(r.hits) }));

    // 必须按 subject 分组后再聚类：跨主体合并没有意义。
    const bySubject = new Map();
    for (const r of rows) {
      if (!bySubject.has(r.subject)) bySubject.set(r.subject, []);
      bySubject.get(r.subject).push(r);
    }

    let merged = 0;
    const groups = [];
    for (const list of bySubject.values()) {
      for (const cluster of clusterMemories(list, opts)) {
        if (cluster.members.length < 2) continue;
        const anchor = cluster.anchor;
        const others = cluster.members.filter((m) => m.id !== anchor.id);
        let hits = 0;
        for (const m of others) hits += m.hits;
        groups.push({
          keep: anchor.id,
          keepText: anchor.text,
          mergedIds: others.map((m) => m.id),
          mergedTexts: others.map((m) => m.text),
          addedHits: hits,
        });
        merged += others.length;
        if (!dryRun) {
          const stmt = this.db.prepare('UPDATE memories SET hits = hits + ? WHERE id = ?');
          stmt.run(hits, anchor.id);
          const del = this.db.prepare('DELETE FROM memories WHERE id = ?');
          for (const m of others) del.run(m.id);
        }
      }
    }
    return { total: rows.length, kept: rows.length - merged, merged, groups };
  }

  prune() {
    const cutoff = Date.now() - this.retentionDays * 86400_000;
    const res = this.db.prepare('DELETE FROM messages WHERE ts < ?').run(cutoff);
    const staleKeys = this.db.prepare("DELETE FROM state WHERE k LIKE 'seen:%' AND CAST(v AS INTEGER) < ?").run(
      Date.now() - 86400_000,
    );
    if (res.changes || staleKeys.changes) {
      logger.debug(`清理历史：messages ${res.changes} 条，state ${staleKeys.changes} 条`);
    }
  }

  close() {
    try {
      this.db.close();
    } catch {
      /* ignore */
    }
  }
}
