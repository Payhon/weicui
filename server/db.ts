import Database from 'better-sqlite3';
import type BetterSqlite3 from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

const dataDir = path.resolve(process.cwd(), 'data');
const dbPath = path.join(dataDir, 'wxlocal.sqlite');

fs.mkdirSync(dataDir, { recursive: true });

export const db: BetterSqlite3.Database = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

export function ensureSchema() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS sync_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      mode TEXT NOT NULL,
      since TEXT NOT NULL,
      until TEXT NOT NULL,
      status TEXT NOT NULL,
      started_at TEXT NOT NULL,
      finished_at TEXT,
      error TEXT
    );

    CREATE TABLE IF NOT EXISTS groups (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      chat_type TEXT NOT NULL DEFAULT 'group',
      favorite INTEGER NOT NULL DEFAULT 0,
      collection TEXT NOT NULL DEFAULT '未分组',
      member_count INTEGER NOT NULL DEFAULT 0,
      last_message_at TEXT,
      raw_json TEXT
    );

    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
      group_name TEXT NOT NULL,
      sender TEXT NOT NULL,
      sent_at TEXT NOT NULL,
      type TEXT NOT NULL,
      content TEXT NOT NULL,
      mentions_me INTEGER NOT NULL DEFAULT 0,
      has_link INTEGER NOT NULL DEFAULT 0,
      raw_json TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS members (
      id TEXT PRIMARY KEY,
      group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      alias TEXT,
      raw_json TEXT
    );

    CREATE TABLE IF NOT EXISTS signals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      score INTEGER NOT NULL,
      title TEXT NOT NULL,
      tags TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS sources (
      sender TEXT PRIMARY KEY,
      score INTEGER NOT NULL,
      message_count INTEGER NOT NULL,
      group_count INTEGER NOT NULL,
      last_seen_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS moments (
      id TEXT PRIMARY KEY,
      author TEXT NOT NULL,
      author_username TEXT,
      content TEXT NOT NULL,
      sent_at TEXT NOT NULL,
      media_json TEXT NOT NULL DEFAULT '[]',
      media_count INTEGER NOT NULL DEFAULT 0,
      location TEXT,
      raw_json TEXT
    );

    CREATE TABLE IF NOT EXISTS moment_notifications (
      id TEXT PRIMARY KEY,
      author TEXT NOT NULL,
      content TEXT NOT NULL,
      sent_at TEXT NOT NULL,
      type TEXT NOT NULL,
      raw_json TEXT
    );

    CREATE TABLE IF NOT EXISTS contact_profiles (
      username TEXT PRIMARY KEY,
      remark_name TEXT,
      nickname TEXT,
      display_name TEXT NOT NULL,
      avatar_url TEXT,
      source TEXT NOT NULL DEFAULT 'local',
      raw_json TEXT,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_messages_group_sent ON messages(group_id, sent_at);
    CREATE INDEX IF NOT EXISTS idx_messages_sent ON messages(sent_at);
    CREATE INDEX IF NOT EXISTS idx_groups_chat_type ON groups(chat_type, last_message_at);
    CREATE INDEX IF NOT EXISTS idx_signals_kind_score ON signals(kind, score DESC);
    CREATE INDEX IF NOT EXISTS idx_moments_sent ON moments(sent_at);
    CREATE INDEX IF NOT EXISTS idx_moments_author ON moments(author);
    CREATE INDEX IF NOT EXISTS idx_contact_profiles_display ON contact_profiles(display_name);
  `);
}

export function resetDerivedTables() {
  db.exec('DELETE FROM signals; DELETE FROM sources;');
}

export function resetAllSyncedData() {
  db.exec('DELETE FROM moment_notifications; DELETE FROM moments; DELETE FROM signals; DELETE FROM sources; DELETE FROM members; DELETE FROM messages; DELETE FROM groups;');
}

export function resetChatTypeData(chatType: 'group' | 'private') {
  const ids = db.prepare('SELECT id FROM groups WHERE chat_type = ?').all(chatType) as Array<{ id: string }>;
  const tx = db.transaction(() => {
    for (const row of ids) {
      db.prepare('DELETE FROM signals WHERE message_id IN (SELECT id FROM messages WHERE group_id = ?)').run(row.id);
      db.prepare('DELETE FROM members WHERE group_id = ?').run(row.id);
      db.prepare('DELETE FROM messages WHERE group_id = ?').run(row.id);
      db.prepare('DELETE FROM groups WHERE id = ?').run(row.id);
    }
    db.exec('DELETE FROM sources;');
  });
  tx();
}

export function resetMomentsData() {
  db.exec('DELETE FROM moment_notifications; DELETE FROM moments;');
}
