'use strict';

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { MemoryStore } = require('./memory-store');

class SQLiteMemoryStore extends MemoryStore {
  constructor(userDataDir) {
    super();
    const dir = path.join(userDataDir, 'data');
    fs.mkdirSync(dir, { recursive: true });
    this.db = new Database(path.join(dir, 'agent.db'));
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS agent_sessions (id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS agent_messages (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, run_id TEXT, role TEXT NOT NULL, content TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS agent_runs (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, agent_id TEXT NOT NULL, status TEXT NOT NULL, usage TEXT, error TEXT, created_at INTEGER NOT NULL, completed_at INTEGER);
      CREATE TABLE IF NOT EXISTS agent_tool_calls (run_id TEXT NOT NULL, tool_call_id TEXT NOT NULL, name TEXT NOT NULL, arguments TEXT NOT NULL, status TEXT NOT NULL, result TEXT, error TEXT, idempotency_key TEXT NOT NULL, created_at INTEGER NOT NULL, completed_at INTEGER, PRIMARY KEY (run_id, tool_call_id));
      CREATE INDEX IF NOT EXISTS idx_agent_messages_session ON agent_messages(session_id, created_at);
    `);
  }
  async createSession(s) {
    this.db
      .prepare('INSERT OR IGNORE INTO agent_sessions (id, agent_id, created_at) VALUES (?, ?, ?)')
      .run(s.id, s.agentId, s.createdAt);
    return this.getSession(s.id);
  }
  async getSession(id) {
    return (
      this.db
        .prepare(
          'SELECT id, agent_id AS agentId, created_at AS createdAt FROM agent_sessions WHERE id = ?'
        )
        .get(id) || null
    );
  }
  async appendMessage(id, m) {
    this.db
      .prepare(
        'INSERT INTO agent_messages (session_id, run_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)'
      )
      .run(id, m.runId || null, m.role, JSON.stringify(m.content), m.createdAt || Date.now());
    return m;
  }
  async listMessages(id) {
    return this.db
      .prepare(
        'SELECT role, content, run_id AS runId, created_at AS createdAt FROM agent_messages WHERE session_id = ? ORDER BY id'
      )
      .all(id)
      .map((m) => ({ ...m, content: JSON.parse(m.content) }));
  }
  async createRun(r) {
    this.db
      .prepare(
        'INSERT INTO agent_runs (id, session_id, agent_id, status, created_at) VALUES (?, ?, ?, ?, ?)'
      )
      .run(r.id, r.sessionId, r.agentId, r.status, r.createdAt);
    return r;
  }
  async updateRun(id, patch) {
    const run = this.getRunSync(id);
    if (!run) return null;
    const next = { ...run, ...patch };
    this.db
      .prepare('UPDATE agent_runs SET status=?, usage=?, error=?, completed_at=? WHERE id=?')
      .run(
        next.status,
        next.usage ? JSON.stringify(next.usage) : null,
        next.error || null,
        next.completedAt || null,
        id
      );
    return next;
  }
  async getRun(id) {
    return this.getRunSync(id);
  }
  getRunSync(id) {
    const r = this.db
      .prepare(
        'SELECT id, session_id AS sessionId, agent_id AS agentId, status, usage, error, created_at AS createdAt, completed_at AS completedAt FROM agent_runs WHERE id=?'
      )
      .get(id);
    if (!r) return null;
    return { ...r, usage: r.usage ? JSON.parse(r.usage) : null };
  }
  async saveToolCall(c) {
    this.db
      .prepare(
        'INSERT INTO agent_tool_calls (run_id, tool_call_id, name, arguments, status, result, error, idempotency_key, created_at, completed_at) VALUES (@runId,@toolCallId,@name,@arguments,@status,@result,@error,@idempotencyKey,@createdAt,@completedAt) ON CONFLICT(run_id,tool_call_id) DO UPDATE SET status=@status,result=@result,error=@error,completed_at=@completedAt'
      )
      .run({
        ...c,
        arguments: JSON.stringify(c.arguments || {}),
        result: c.result === undefined ? null : JSON.stringify(c.result),
        error: c.error || null,
        completedAt: c.completedAt || null,
      });
    return c;
  }
  async getToolCall(runId, toolCallId) {
    const c = this.db
      .prepare(
        'SELECT run_id AS runId, tool_call_id AS toolCallId, name, arguments, status, result, error, idempotency_key AS idempotencyKey, created_at AS createdAt, completed_at AS completedAt FROM agent_tool_calls WHERE run_id=? AND tool_call_id=?'
      )
      .get(runId, toolCallId);
    if (!c) return null;
    return {
      ...c,
      arguments: JSON.parse(c.arguments),
      result: c.result ? JSON.parse(c.result) : undefined,
    };
  }
  close() {
    this.db.close();
  }
}

module.exports = { SQLiteMemoryStore };
