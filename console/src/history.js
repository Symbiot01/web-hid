'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { normalizeProblemType, canonicalFileName } = require('./syntaxCheck');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_TITLE = 200;
const MAX_STATEMENT = 16_000;
const MAX_APPROACH = 4_000;
const MAX_SOURCE = 64 * 1024;
const MAX_OUTPUT = 16_000;
const MAX_MESSAGES = 80;
const MAX_CASES = 16;

function clip(value, max) {
  if (typeof value !== 'string') return '';
  return value.replace(/\0/g, '').trim().slice(0, max);
}

function escapeLike(raw) {
  if (typeof raw !== 'string') return '';
  return raw.replace(/[\\%_]/g, '\\$&');
}

function safeJsonParse(raw, fallback) {
  if (typeof raw !== 'string' || !raw) return fallback;
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function sanitizeMessages(messages) {
  if (!Array.isArray(messages)) return [];
  return messages.slice(-MAX_MESSAGES).map((item) => ({
    role: item && item.role === 'user' ? 'user' : 'assistant',
    text: clip(item && item.text, 4_000),
    kind: item && typeof item.kind === 'string' ? clip(item.kind, 32) : item && item.role === 'user' ? 'user' : 'step',
  }));
}

function sanitizeCases(cases) {
  if (!Array.isArray(cases)) return [];
  return cases.slice(0, MAX_CASES).map((item) => ({
    input: typeof item?.input === 'string' ? item.input.replace(/\0/g, '').slice(0, 8_000) : '',
    expected: typeof item?.expected === 'string' ? item.expected.replace(/\0/g, '').slice(0, 8_000) : '',
    actual: typeof item?.actual === 'string' ? item.actual.replace(/\0/g, '').slice(0, 8_000) : '',
    stderr: typeof item?.stderr === 'string' ? item.stderr.replace(/\0/g, '').slice(0, 4_000) : '',
    reason: item?.reason || null,
    timeMs: typeof item?.timeMs === 'number' && Number.isFinite(item.timeMs) ? Math.max(0, Math.trunc(item.timeMs)) : 0,
    status: item?.status === 'pass' || item?.status === 'fail' ? item.status : 'idle',
  }));
}

function formatSummaryRow(row) {
  if (!row) return null;
  const cases = safeJsonParse(row.cases_json, []);
  const messages = safeJsonParse(row.messages_json, []);
  const passCount = Array.isArray(cases) ? cases.filter((c) => c && c.status === 'pass').length : 0;
  const caseCount = Array.isArray(cases) ? cases.length : 0;
  return {
    id: row.id,
    title: row.title || 'Untitled Problem',
    problemType: row.problem_type,
    fileName: row.file_name,
    entry: row.entry,
    signature: row.signature,
    format: row.format,
    phase: row.phase,
    statementPreview: clip(row.statement, 240),
    approach: row.approach,
    passCount,
    caseCount,
    messageCount: Array.isArray(messages) ? messages.length : 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function formatDetailRow(row) {
  if (!row) return null;
  const cases = safeJsonParse(row.cases_json, []);
  const messages = safeJsonParse(row.messages_json, []);
  const passCount = Array.isArray(cases) ? cases.filter((c) => c && c.status === 'pass').length : 0;
  const caseCount = Array.isArray(cases) ? cases.length : 0;
  return {
    id: row.id,
    title: row.title || 'Untitled Problem',
    problemType: row.problem_type,
    fileName: row.file_name,
    entry: row.entry,
    signature: row.signature,
    format: row.format,
    phase: row.phase,
    statement: row.statement,
    approach: row.approach,
    source: row.source,
    messages,
    cases,
    output: row.output,
    passCount,
    caseCount,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function createHistoryStore({ dbPath }) {
  const resolvedPath = dbPath || ':memory:';
  if (resolvedPath !== ':memory:') {
    const dir = path.dirname(resolvedPath);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  const db = new DatabaseSync(resolvedPath);
  if (resolvedPath !== ':memory:') {
    try {
      fs.chmodSync(resolvedPath, 0o600);
    } catch {
      // ignore chmod errors on special filesystems
    }
  }

  db.exec('PRAGMA busy_timeout = 5000;');
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;

    CREATE TABLE IF NOT EXISTS solved_history (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      problem_type TEXT NOT NULL,
      file_name TEXT NOT NULL,
      entry TEXT NOT NULL,
      signature TEXT NOT NULL,
      format TEXT NOT NULL,
      phase TEXT NOT NULL,
      statement TEXT NOT NULL,
      approach TEXT NOT NULL,
      source TEXT NOT NULL,
      messages_json TEXT NOT NULL,
      cases_json TEXT NOT NULL,
      output TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_history_updated ON solved_history(updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_history_type ON solved_history(problem_type, updated_at DESC);
  `);

  const upsertStmt = db.prepare(`
    INSERT INTO solved_history (
      id, title, problem_type, file_name, entry, signature, format,
      phase, statement, approach, source, messages_json, cases_json, output,
      created_at, updated_at
    ) VALUES (
      ?, ?, ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ?, ?, ?,
      ?, ?
    )
    ON CONFLICT(id) DO UPDATE SET
      title = excluded.title,
      problem_type = excluded.problem_type,
      file_name = excluded.file_name,
      entry = excluded.entry,
      signature = excluded.signature,
      format = excluded.format,
      phase = excluded.phase,
      statement = excluded.statement,
      approach = excluded.approach,
      source = excluded.source,
      messages_json = excluded.messages_json,
      cases_json = excluded.cases_json,
      output = excluded.output,
      updated_at = excluded.updated_at
  `);

  const getStmt = db.prepare(`
    SELECT * FROM solved_history WHERE id = ?
  `);

  const deleteStmt = db.prepare(`
    DELETE FROM solved_history WHERE id = ?
  `);

  function save(record) {
    if (!record || typeof record !== 'object') return null;
    const rawId = typeof record.id === 'string' && UUID_RE.test(record.id.trim()) ? record.id.trim().toLowerCase() : crypto.randomUUID();
    const problemType = normalizeProblemType(record.problemType, record.fileName);
    const fileName = canonicalFileName(problemType, record.fileName);
    const title = clip(record.title, MAX_TITLE) || 'Untitled Problem';
    const entry = clip(record.entry, 64) || 'solve';
    const signature = clip(record.signature, 200);
    const format = clip(record.format, 1_000);
    const validPhases = new Set(['solved', 'needs_human', 'blocked', 'working', 'idle']);
    const phase = validPhases.has(record.phase) ? record.phase : 'solved';
    const statement = clip(record.statement, MAX_STATEMENT);
    const approach = clip(record.approach, MAX_APPROACH);
    const source = typeof record.source === 'string' ? record.source.replace(/\0/g, '').slice(0, MAX_SOURCE) : '';
    const messagesJson = JSON.stringify(sanitizeMessages(record.messages));
    const casesJson = JSON.stringify(sanitizeCases(record.cases));
    const output = clip(record.output, MAX_OUTPUT);
    const now = Date.now();

    upsertStmt.run(
      rawId,
      title,
      problemType,
      fileName,
      entry,
      signature,
      format,
      phase,
      statement,
      approach,
      source,
      messagesJson,
      casesJson,
      output,
      now,
      now,
    );
    return get(rawId);
  }

  function list({ q = '', type = '', limit = 50, offset = 0 } = {}) {
    const cleanQ = clip(q, 120);
    const cleanType = typeof type === 'string' && type.trim() && type.trim() !== 'all' ? normalizeProblemType(type.trim()) : '';
    const safeLimit = Number.isFinite(Number(limit)) ? Math.min(100, Math.max(1, Math.trunc(Number(limit)))) : 50;
    const safeOffset = Number.isFinite(Number(offset)) ? Math.max(0, Math.trunc(Number(offset))) : 0;

    const where = [];
    const params = [];

    if (cleanType) {
      where.push('problem_type = ?');
      params.push(cleanType);
    }
    if (cleanQ) {
      const pattern = `%${escapeLike(cleanQ)}%`;
      where.push("(title LIKE ? ESCAPE '\\' OR statement LIKE ? ESCAPE '\\' OR approach LIKE ? ESCAPE '\\' OR file_name LIKE ? ESCAPE '\\')");
      params.push(pattern, pattern, pattern, pattern);
    }

    const whereClause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
    const countRow = db
      .prepare(`SELECT COUNT(*) AS total FROM solved_history ${whereClause}`)
      .get(...params);
    const rows = db
      .prepare(
        `SELECT id, title, problem_type, file_name, entry, signature, format, phase, statement, approach, cases_json, messages_json, created_at, updated_at
         FROM solved_history
         ${whereClause}
         ORDER BY updated_at DESC
         LIMIT ? OFFSET ?`,
      )
      .all(...params, safeLimit, safeOffset);

    return {
      total: countRow && typeof countRow.total === 'number' ? countRow.total : 0,
      items: rows.map(formatSummaryRow),
    };
  }

  function get(id) {
    if (typeof id !== 'string' || !UUID_RE.test(id.trim())) return null;
    const row = getStmt.get(id.trim().toLowerCase());
    return formatDetailRow(row);
  }

  function remove(id) {
    if (typeof id !== 'string' || !UUID_RE.test(id.trim())) return false;
    const res = deleteStmt.run(id.trim().toLowerCase());
    return Boolean(res && res.changes > 0);
  }

  function close() {
    try {
      db.close();
    } catch {
      // ignore
    }
  }

  return {
    save,
    list,
    get,
    remove,
    close,
  };
}

module.exports = {
  createHistoryStore,
  UUID_RE,
  escapeLike,
};
