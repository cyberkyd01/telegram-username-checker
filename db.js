import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "data");
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new DatabaseSync(path.join(DATA_DIR, "app.db"));
db.exec("PRAGMA journal_mode = WAL;");

db.exec(`
  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT
  );

  CREATE TABLE IF NOT EXISTS users (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    username     TEXT UNIQUE,
    display_name TEXT,
    status       TEXT,              -- verified | available | invalid | error
    tg_user_id   INTEGER,           -- filled once we see them in the group
    in_group     INTEGER DEFAULT 0,
    note         TEXT,
    verified_at  TEXT,
    added_at     TEXT
  );

  CREATE TABLE IF NOT EXISTS members (
    tg_user_id   INTEGER PRIMARY KEY,
    username     TEXT,
    display_name TEXT,
    is_bot       INTEGER DEFAULT 0,
    status       TEXT DEFAULT 'member',   -- member | left | banned
    msg_count    INTEGER DEFAULT 0,
    first_seen   TEXT,
    last_seen    TEXT
  );

  CREATE TABLE IF NOT EXISTS messages (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    tg_message_id INTEGER,
    from_id       INTEGER,
    from_name     TEXT,
    from_username TEXT,
    text          TEXT,
    kind          TEXT DEFAULT 'text',     -- text | join | leave | service
    via           TEXT DEFAULT 'telegram', -- telegram | interface
    date          INTEGER
  );

  CREATE TABLE IF NOT EXISTS counters (
    day  TEXT,
    kind TEXT,
    n    INTEGER DEFAULT 0,
    PRIMARY KEY(day, kind)
  );
`);

// --- settings -------------------------------------------------------------
export function getSetting(key, fallback = null) {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key);
  return row ? row.value : fallback;
}
export function setSetting(key, value) {
  db.prepare(
    "INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  ).run(key, value == null ? null : String(value));
}

// --- safe mode + daily counters ------------------------------------------
// Conservative defaults; all tunable from the Settings tab.
const SAFE_DEFAULTS = {
  enabled: true,
  verifyDelayMs: 1200,    // pause between public t.me checks
  verifyConcurrency: 1,   // one at a time
  verifyDailyCap: 200,    // max public checks per day
  actionMinGapMs: 1000,   // min gap between bot actions
  actionDailyCap: 500,    // max bot actions (send/ban/invite) per day
  onboardDailyCap: 25,    // manual-add budget you pace yourself against
};
const FAST = { verifyDelayMs: 150, verifyConcurrency: 5, actionMinGapMs: 0 };

export function getSafeConfig() {
  const raw = getSetting("safe_config");
  let stored = {};
  try { stored = raw ? JSON.parse(raw) : {}; } catch { stored = {}; }
  return { ...SAFE_DEFAULTS, ...stored };
}
export function setSafeConfig(patch) {
  const merged = { ...getSafeConfig(), ...patch };
  setSetting("safe_config", JSON.stringify(merged));
  return merged;
}
/** Active knobs given whether safe mode is on. Caps are null when off. */
export function effectiveLimits() {
  const c = getSafeConfig();
  if (!c.enabled) {
    return { safe: false, verifyDelayMs: FAST.verifyDelayMs, verifyConcurrency: FAST.verifyConcurrency,
      verifyDailyCap: null, actionMinGapMs: FAST.actionMinGapMs, actionDailyCap: null, onboardDailyCap: null };
  }
  return { safe: true, verifyDelayMs: c.verifyDelayMs, verifyConcurrency: c.verifyConcurrency,
    verifyDailyCap: c.verifyDailyCap, actionMinGapMs: c.actionMinGapMs, actionDailyCap: c.actionDailyCap,
    onboardDailyCap: c.onboardDailyCap };
}

const today = () => new Date().toISOString().slice(0, 10);
export function incrCounter(kind, by = 1) {
  db.prepare(
    "INSERT INTO counters(day, kind, n) VALUES(?, ?, ?) ON CONFLICT(day, kind) DO UPDATE SET n = n + excluded.n"
  ).run(today(), kind, by);
}
export function getCounter(kind) {
  const r = db.prepare("SELECT n FROM counters WHERE day = ? AND kind = ?").get(today(), kind);
  return r ? r.n : 0;
}

// --- users / roster -------------------------------------------------------
export function upsertUser({ username, display_name, status }) {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO users(username, display_name, status, verified_at, added_at)
     VALUES(?, ?, ?, ?, ?)
     ON CONFLICT(username) DO UPDATE SET
       display_name = excluded.display_name,
       status       = excluded.status,
       verified_at  = excluded.verified_at`
  ).run(username, display_name || null, status, now, now);
  return db.prepare("SELECT * FROM users WHERE username = ?").get(username);
}
export function listUsers() {
  return db.prepare("SELECT * FROM users ORDER BY added_at DESC, id DESC").all();
}
export function deleteUser(id) {
  return db.prepare("DELETE FROM users WHERE id = ?").run(id);
}
export function linkUserToMember(username, tgUserId) {
  if (!username) return;
  db.prepare(
    "UPDATE users SET tg_user_id = ?, in_group = 1 WHERE lower(username) = lower(?)"
  ).run(tgUserId, username);
}
export function markUserLeftGroup(tgUserId) {
  db.prepare("UPDATE users SET in_group = 0 WHERE tg_user_id = ?").run(tgUserId);
}

// --- members (seen in the group) -----------------------------------------
export function seenMember({ tg_user_id, username, display_name, is_bot }) {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO members(tg_user_id, username, display_name, is_bot, status, first_seen, last_seen)
     VALUES(?, ?, ?, ?, 'member', ?, ?)
     ON CONFLICT(tg_user_id) DO UPDATE SET
       username     = excluded.username,
       display_name = excluded.display_name,
       last_seen    = excluded.last_seen,
       status       = CASE WHEN members.status = 'banned' THEN 'banned' ELSE 'member' END`
  ).run(tg_user_id, username || null, display_name || null, is_bot ? 1 : 0, now, now);
  if (username) linkUserToMember(username, tg_user_id);
}
export function bumpMemberMessage(tgUserId) {
  db.prepare(
    "UPDATE members SET msg_count = msg_count + 1, last_seen = ? WHERE tg_user_id = ?"
  ).run(new Date().toISOString(), tgUserId);
}
export function setMemberStatus(tgUserId, status) {
  db.prepare("UPDATE members SET status = ? WHERE tg_user_id = ?").run(status, tgUserId);
  if (status === "left" || status === "banned") markUserLeftGroup(tgUserId);
}
export function listMembers() {
  return db.prepare("SELECT * FROM members ORDER BY last_seen DESC").all();
}
export function getMember(tgUserId) {
  return db.prepare("SELECT * FROM members WHERE tg_user_id = ?").get(tgUserId);
}

// --- messages (group feed) ------------------------------------------------
export function addMessage(m) {
  const info = db
    .prepare(
      `INSERT INTO messages(tg_message_id, from_id, from_name, from_username, text, kind, via, date)
       VALUES(?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      m.tg_message_id || null,
      m.from_id || null,
      m.from_name || null,
      m.from_username || null,
      m.text || null,
      m.kind || "text",
      m.via || "telegram",
      m.date || Math.floor(Date.now() / 1000)
    );
  return Number(info.lastInsertRowid);
}
export function messagesSince(sinceId = 0, limit = 200) {
  return db
    .prepare("SELECT * FROM messages WHERE id > ? ORDER BY id ASC LIMIT ?")
    .all(Number(sinceId) || 0, limit);
}
export function recentMessages(limit = 100) {
  const rows = db
    .prepare("SELECT * FROM messages ORDER BY id DESC LIMIT ?")
    .all(limit);
  return rows.reverse();
}

export default db;
