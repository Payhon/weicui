import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { chromium, type Browser, type Page } from 'playwright';
import { db } from './db.js';

type MomentMediaRecord = {
  id: string;
  media_json: string | null;
};

type SnsMedia = {
  thumb?: string;
  url?: string;
  type?: string | number;
  width?: number;
  height?: number;
  video_duration?: number;
  total_size?: number;
  thumb_enc_idx?: string;
  thumb_key?: string;
  thumb_token?: string;
  url_enc_idx?: string;
  url_key?: string;
  url_token?: string;
};

type MomentMediaVariant = 'thumb' | 'full';

export type ResolvedMomentMedia = {
  path: string;
  mime: string;
  fileName: string;
};

const cacheDir = path.resolve(process.cwd(), 'data', 'moment-media-cache');
const keyStreamChunkSize = 131_072;
const keyStreamCache = new Map<string, Buffer>();

let wasmAssetBaseUrl = '';
let browser: Browser | null = null;
let page: Page | null = null;

export function configureMomentMediaResolver(baseUrl: string) {
  wasmAssetBaseUrl = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
}

export async function resolveMomentMedia(momentId: string, index: number, variant: MomentMediaVariant): Promise<ResolvedMomentMedia | null> {
  if (!Number.isInteger(index) || index < 0) return null;

  const row = db.prepare(`
    SELECT id, media_json
    FROM moments
    WHERE id = ?
  `).get(momentId) as MomentMediaRecord | undefined;
  if (!row) return null;

  const media = parseMediaJson(row.media_json)[index];
  if (!media) return null;

  const request = buildMediaRequest(media, variant);
  if (!request.url) return null;

  fs.mkdirSync(cacheDir, { recursive: true });
  const cacheKey = hash(JSON.stringify({ momentId, index, variant, request }));
  const cached = findCachedMedia(cacheKey);
  if (cached) return cached;

  const encrypted = await downloadMedia(request.url);
  if (!encrypted || encrypted.length === 0) return null;

  const isVideo = isMomentVideo(media, request.url);
  const plain = request.key ? await decryptMedia(encrypted, request.key, isVideo) : encrypted;
  const candidate = detectMime(plain);
  const fallback = detectMime(encrypted);
  const output = candidate.mime === 'application/octet-stream' && fallback.mime !== 'application/octet-stream' ? encrypted : plain;
  const mime = candidate.mime === 'application/octet-stream' && fallback.mime !== 'application/octet-stream' ? fallback.mime : candidate.mime;
  if (mime === 'application/octet-stream') return null;

  const filePath = path.join(cacheDir, `${cacheKey}.${extensionForMime(mime)}`);
  fs.writeFileSync(filePath, output);
  return {
    path: filePath,
    mime,
    fileName: `${momentId}-${index}.${extensionForMime(mime)}`
  };
}

function parseMediaJson(value: string | null) {
  try {
    const parsed = JSON.parse(value || '[]');
    return Array.isArray(parsed) ? parsed as SnsMedia[] : [];
  } catch {
    return [];
  }
}

function buildMediaRequest(media: SnsMedia, variant: MomentMediaVariant) {
  const useThumb = variant === 'thumb';
  const rawUrl = useThumb ? media.thumb || media.url || '' : media.url || media.thumb || '';
  const token = useThumb ? media.thumb_token || media.url_token || '' : media.url_token || media.thumb_token || '';
  const key = normalizeDecodeKey(useThumb ? media.thumb_key || media.url_key || '' : media.url_key || media.thumb_key || '');
  const encIdx = normalizeEncIdx(useThumb ? media.thumb_enc_idx || media.url_enc_idx : media.url_enc_idx || media.thumb_enc_idx);
  return {
    url: normalizeSnsUrl(rawUrl, token, encIdx, isMomentVideo(media, rawUrl), useThumb),
    key
  };
}

function normalizeSnsUrl(value: string, token: string, encIdx: string, isVideo: boolean, keepThumb: boolean) {
  if (!value) return '';
  let fixedUrl = value;
  if (!isVideo && !keepThumb) fixedUrl = fixedUrl.replace(/\/150($|\?)/, '/0$1');
  if (!token) return fixedUrl;

  const url = new URL(fixedUrl);
  if (isVideo) {
    const existing = Array.from(url.searchParams.entries());
    url.search = '';
    url.searchParams.set('token', token);
    url.searchParams.set('idx', encIdx || '1');
    for (const [key, entryValue] of existing) {
      if (key !== 'token' && key !== 'idx') url.searchParams.append(key, entryValue);
    }
    return url.toString();
  }

  url.searchParams.set('token', token);
  url.searchParams.set('idx', encIdx || '1');
  return url.toString();
}

function normalizeDecodeKey(value: string | undefined) {
  const normalized = String(value || '').trim();
  return normalized;
}

function normalizeEncIdx(value: string | undefined) {
  const normalized = String(value || '').trim();
  return normalized && normalized !== '0' ? normalized : '1';
}

async function downloadMedia(url: string) {
  try {
    const response = await fetch(url, {
      headers: {
        Accept: '*/*',
        'User-Agent': 'MicroMessenger Client'
      }
    });
    if (!response.ok) return null;
    return Buffer.from(await response.arrayBuffer());
  } catch {
    return null;
  }
}

async function decryptMedia(input: Buffer, key: string, isVideo: boolean) {
  const decryptLength = isVideo ? Math.min(input.length, keyStreamChunkSize) : input.length;
  const keyStream = await generateKeyStream(key, decryptLength);
  const output = Buffer.from(input);
  for (let index = 0; index < decryptLength; index += 1) {
    output[index] = input[index] ^ keyStream[index];
  }
  return output;
}

async function generateKeyStream(key: string, length: number) {
  const chunks = Math.max(1, Math.ceil(length / keyStreamChunkSize));
  const cacheKey = `${key}:${chunks}`;
  const cached = keyStreamCache.get(cacheKey);
  if (cached) return cached.subarray(0, length);

  const streamPage = await ensureWasmPage();
  const base64 = await streamPage.evaluate(async ({ decodeKey, chunkCount, chunkSize }) => {
    const target = globalThis as unknown as {
      __generateWeicuiSnsKeyStream: (decodeKey: string, chunkCount: number, chunkSize: number) => Promise<string>;
    };
    return await target.__generateWeicuiSnsKeyStream(decodeKey, chunkCount, chunkSize);
  }, { decodeKey: key, chunkCount: chunks, chunkSize: keyStreamChunkSize });
  const buffer = Buffer.from(base64, 'base64');
  keyStreamCache.set(cacheKey, buffer);
  if (keyStreamCache.size > 24) {
    const first = keyStreamCache.keys().next().value;
    if (first) keyStreamCache.delete(first);
  }
  return buffer.subarray(0, length);
}

async function ensureWasmPage() {
  if (!wasmAssetBaseUrl) throw new Error('moment media wasm base url is not configured');
  if (page && !page.isClosed() && await isWasmPageReady(page)) return page;
  if (page && !page.isClosed()) await page.close().catch(() => undefined);

  if (!browser) browser = await chromium.launch({ headless: true });
  page = await browser.newPage();
  await page.goto(`${wasmAssetBaseUrl}sns-worker.html`, { waitUntil: 'load' });
  await page.waitForFunction('typeof window.__generateWeicuiSnsKeyStream === "function" && typeof Module !== "undefined" && !!Module.WxIsaac64', null, { timeout: 60_000 });
  return page;
}

async function isWasmPageReady(candidate: Page) {
  try {
    return await candidate.evaluate(() => {
      const target = globalThis as unknown as {
        Module?: { WxIsaac64?: unknown };
        __generateWeicuiSnsKeyStream?: unknown;
      };
      return typeof target.__generateWeicuiSnsKeyStream === 'function' && Boolean(target.Module?.WxIsaac64);
    });
  } catch {
    return false;
  }
}

function findCachedMedia(cacheKey: string): ResolvedMomentMedia | null {
  for (const extension of ['jpg', 'png', 'gif', 'webp', 'mp4']) {
    const filePath = path.join(cacheDir, `${cacheKey}.${extension}`);
    if (fs.existsSync(filePath) && fs.statSync(filePath).size > 0) {
      const mime = mimeFromExtension(extension);
      return {
        path: filePath,
        mime,
        fileName: `${cacheKey}.${extension}`
      };
    }
  }
  return null;
}

function isMomentVideo(media: SnsMedia, url = '') {
  const type = String(media.type || '').toLowerCase();
  if (Number(media.video_duration || 0) > 0) return true;
  if (type === 'video' || type === '4' || type === '6' || type === '15') return true;
  if (/vweixinthumb/i.test(url)) return false;
  return /snsvideodownload|video|\.mp4/i.test(url);
}

function detectMime(buffer: Buffer) {
  if (buffer.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) return { mime: 'image/jpeg' };
  if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { mime: 'image/png' };
  if (buffer.subarray(0, 6).toString('ascii') === 'GIF87a' || buffer.subarray(0, 6).toString('ascii') === 'GIF89a') return { mime: 'image/gif' };
  if (buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP') return { mime: 'image/webp' };
  if (buffer.subarray(4, 8).toString('ascii') === 'ftyp') return { mime: 'video/mp4' };
  return { mime: 'application/octet-stream' };
}

function extensionForMime(mime: string) {
  if (mime === 'image/jpeg') return 'jpg';
  if (mime === 'image/png') return 'png';
  if (mime === 'image/gif') return 'gif';
  if (mime === 'image/webp') return 'webp';
  if (mime === 'video/mp4') return 'mp4';
  return 'bin';
}

function mimeFromExtension(extension: string) {
  const map: Record<string, string> = {
    jpg: 'image/jpeg',
    png: 'image/png',
    gif: 'image/gif',
    webp: 'image/webp',
    mp4: 'video/mp4'
  };
  return map[extension] || 'application/octet-stream';
}

function hash(value: string) {
  return crypto.createHash('sha1').update(value).digest('hex');
}
