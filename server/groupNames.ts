import Database from 'better-sqlite3';
import type BetterSqlite3 from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { db } from './db.js';

type CacheName = {
  name: string;
  source: string;
};

type GroupNameRow = {
  id: string;
  name: string;
  raw_json: string | null;
};

let cachedNames: Map<string, CacheName> | null = null;
let cachedAt = 0;
const cacheTtlMs = 60_000;

export function getWxCacheGroupName(groupId: string) {
  return getWxCacheGroupNames().get(groupId)?.name || '';
}

export function refreshGroupNamesFromWxCache() {
  cachedNames = null;
  const names = getWxCacheGroupNames();
  const rows = db.prepare("SELECT id, name, raw_json FROM groups WHERE chat_type = 'group'").all() as GroupNameRow[];
  const updateGroup = db.prepare('UPDATE groups SET name = ?, raw_json = ? WHERE id = ?');
  const updateMessages = db.prepare('UPDATE messages SET group_name = ? WHERE group_id = ?');
  let renamed = 0;
  let matched = 0;

  const tx = db.transaction(() => {
    for (const row of rows) {
      const resolved = names.get(row.id);
      if (!resolved) continue;
      matched += 1;
      if (row.name === resolved.name) continue;
      if (!isPlaceholderGroupName(row.name, row.id) && row.name.trim()) continue;
      updateGroup.run(resolved.name, mergeResolvedName(row.raw_json, resolved), row.id);
      updateMessages.run(resolved.name, row.id);
      renamed += 1;
    }
  });
  tx();

  return {
    available: names.size > 0,
    cachedNames: names.size,
    matched,
    renamed,
    unresolved: rows.length - matched
  };
}

export function isPlaceholderGroupName(name: string | null | undefined, groupId: string) {
  const value = String(name || '').trim();
  if (!value) return true;
  if (value === '未命名群') return true;
  if (value === groupId) return true;
  if (/@chatroom$/i.test(value)) return true;
  return false;
}

function getWxCacheGroupNames() {
  const now = Date.now();
  if (cachedNames && now - cachedAt < cacheTtlMs) return cachedNames;

  const names = new Map<string, CacheName>();
  for (const file of listWxCacheDbs()) {
    let cacheDb: BetterSqlite3.Database | null = null;
    try {
      cacheDb = new Database(file, { readonly: true, fileMustExist: true });
      if (!hasTable(cacheDb, 'contact')) continue;
      const rows = cacheDb.prepare(`
        SELECT username, remark, nick_name
        FROM contact
        WHERE username LIKE '%@chatroom'
      `).all() as Array<{ username: string; remark: string | null; nick_name: string | null }>;

      for (const row of rows) {
        const id = cleanText(row.username);
        const name = cleanGroupName(row.remark) || cleanGroupName(row.nick_name);
        if (!id || !name || names.has(id)) continue;
        names.set(id, { name, source: `${path.basename(file)}:contact` });
      }
    } catch {
      // wx-cli cache may be rebuilding while the local app is reading it.
    } finally {
      cacheDb?.close();
    }
  }

  cachedNames = names;
  cachedAt = now;
  return names;
}

function listWxCacheDbs() {
  const cacheDir = path.join(os.homedir(), '.wx-cli', 'cache');
  try {
    return fs.readdirSync(cacheDir)
      .filter((name) => name.endsWith('.db'))
      .map((name) => path.join(cacheDir, name))
      .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  } catch {
    return [];
  }
}

function hasTable(cacheDb: BetterSqlite3.Database, table: string) {
  const row = cacheDb.prepare(`
    SELECT name
    FROM sqlite_master
    WHERE type = 'table' AND name = ?
  `).get(table) as { name: string } | undefined;
  return Boolean(row);
}

function cleanGroupName(value: string | null | undefined) {
  const text = cleanText(value);
  if (!text || text === '未命名群' || /@chatroom$/i.test(text)) return '';
  return text;
}

function cleanText(value: string | null | undefined) {
  return String(value || '').replace(/\u0000/g, '').trim();
}

function mergeResolvedName(rawJson: string | null, resolved: CacheName) {
  let raw: Record<string, unknown> = {};
  try {
    raw = rawJson ? JSON.parse(rawJson) as Record<string, unknown> : {};
  } catch {
    raw = {};
  }
  return JSON.stringify({
    ...raw,
    resolved_name: resolved.name,
    name_source: resolved.source
  });
}
