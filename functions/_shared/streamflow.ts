import { getSetting, setSetting } from './db';
import { HttpError } from './http';
import { fetchWithTimeout } from './providers';
import type { Env, Provider } from './types';

export const STREAMFLOW_MIN_RATIO = 1 / 3;
export const STREAMFLOW_OVERLAP_SECONDS = 18;
export const STREAMFLOW_CACHE_TTL_SECONDS = 7 * 24 * 60 * 60;
export const STREAMFLOW_HINT_TTL_SECONDS = 24 * 60 * 60;
export const STREAMFLOW_MAX_PREFETCH_OBJECTS = 12;

const GENERATION_SETTING = 'streamflow_cache_generation';
const MAX_PLAYLIST_BYTES = 3_000_000;
const MAX_PREFETCH_OBJECT_BYTES = 48 * 1024 * 1024;

type ByteRange = { start: number; length: number };
type PlannedObject = {
  url: string;
  objectId: string;
  range?: ByteRange;
  kind: 'segment' | 'map' | 'key';
};

type PlannedSegment = {
  start: number;
  end: number;
  object: PlannedObject;
  map?: PlannedObject;
  key?: PlannedObject;
};

type StreamflowHint = {
  provider: string;
  playlistUrl: string;
  trackId: string;
};

export type StreamflowPrefetchInput = {
  origin: string;
  sessionId: string;
  generation: number;
  provider: Provider;
  sourceUrl: string;
  position: number;
  duration: number;
  phase: string;
};

function allowedHosts(provider: Provider): Set<string> {
  return new Set([
    new URL(provider.baseUrl).hostname.toLowerCase(),
    ...provider.mediaHosts.map(host => host.toLowerCase()),
  ]);
}

export function providerAllowsUrl(provider: Provider, raw: string): URL {
  let url: URL;
  try { url = new URL(raw); } catch { throw new HttpError(400, '缓存源地址无效', 'STREAMFLOW_INVALID_SOURCE'); }
  if (url.protocol !== 'https:') throw new HttpError(400, '缓存仅支持 HTTPS 片源', 'STREAMFLOW_HTTPS_REQUIRED');
  if (!allowedHosts(provider).has(url.hostname.toLowerCase())) {
    throw new HttpError(403, `媒体主机 ${url.hostname} 不在数据源白名单中`, 'STREAMFLOW_HOST_BLOCKED');
  }
  url.hash = '';
  return url;
}

export function finiteNumber(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function cacheWindow(position: number, duration: number): { eligible: boolean; start: number; end: number } {
  if (!(duration > 0) || position / duration < STREAMFLOW_MIN_RATIO || position >= duration - 5) {
    return { eligible: false, start: 0, end: 0 };
  }
  const start = Math.max(0, position - STREAMFLOW_OVERLAP_SECONDS);
  const end = Math.min(duration, position + (duration - position) / 2);
  return { eligible: end > start + 5, start, end };
}

export function streamflowReady(): boolean {
  return typeof caches !== 'undefined' && Boolean(caches.default);
}

export function validStreamflowId(value: string): boolean {
  return /^[a-f0-9]{64}$/i.test(value);
}

export function validObjectId(value: string): boolean {
  return /^[a-zA-Z0-9._:-]{1,180}$/.test(value);
}

export function normalizeStreamflowGeneration(value: unknown): number {
  const parsed = Math.floor(finiteNumber(value, 1));
  return parsed > 0 && parsed <= Number.MAX_SAFE_INTEGER ? parsed : 1;
}

export async function getStreamflowGeneration(env: Env): Promise<number> {
  return normalizeStreamflowGeneration(await getSetting(env, GENERATION_SETTING, '1'));
}

export async function bumpStreamflowGeneration(env: Env): Promise<number> {
  if (!env.DB) throw new HttpError(503, '重置边缘缓存需要现有 D1 绑定', 'STREAMFLOW_DB_REQUIRED');
  const next = Date.now();
  await setSetting(env, GENERATION_SETTING, String(next));
  return next;
}

function rangeToken(range: string): string {
  if (!range) return 'full';
  return range.toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 80) || 'range';
}

export function streamflowObjectCacheRequest(
  origin: string,
  sessionId: string,
  objectId: string,
  generation: number,
  range = '',
): Request {
  if (!validStreamflowId(sessionId) || !validObjectId(objectId)) {
    throw new HttpError(400, 'CactusStreamflow 缓存标识无效', 'STREAMFLOW_INVALID_KEY');
  }
  const url = new URL(`/__cactus_streamflow_cache/v${normalizeStreamflowGeneration(generation)}/${sessionId}/${encodeURIComponent(objectId)}/${rangeToken(range)}`, origin);
  return new Request(url.toString(), { method: 'GET' });
}

export function streamflowHintCacheRequest(origin: string, sessionId: string, generation: number): Request {
  if (!validStreamflowId(sessionId)) throw new HttpError(400, '缓存会话 ID 无效', 'STREAMFLOW_INVALID_ID');
  const url = new URL(`/__cactus_streamflow_hint/v${normalizeStreamflowGeneration(generation)}/${sessionId}`, origin);
  return new Request(url.toString(), { method: 'GET' });
}

function cleanCachedHeaders(headers: Headers): Headers {
  const result = new Headers(headers);
  result.delete('set-cookie');
  result.delete('vary');
  result.delete('content-range');
  result.delete('transfer-encoding');
  result.set('access-control-allow-origin', '*');
  result.set('x-content-type-options', 'nosniff');
  return result;
}

export function cacheableStreamflowResponse(response: Response, objectId: string): Response {
  const headers = cleanCachedHeaders(response.headers);
  const contentRange = response.headers.get('content-range') || '';
  const ttl = objectId.includes('--key-') ? 6 * 60 * 60 : STREAMFLOW_CACHE_TTL_SECONDS;
  headers.set('cache-control', `public, max-age=${ttl}, immutable`);
  headers.set('x-cactus-upstream-status', String(response.status));
  if (contentRange) headers.set('x-cactus-content-range', contentRange);
  return new Response(response.body, { status: 200, headers });
}

export async function matchStreamflowObject(
  origin: string,
  sessionId: string,
  objectId: string,
  generation: number,
  range = '',
): Promise<Response | null> {
  if (!streamflowReady() || !validStreamflowId(sessionId) || !validObjectId(objectId)) return null;
  const cached = await caches.default.match(streamflowObjectCacheRequest(origin, sessionId, objectId, generation, range));
  if (!cached) return null;
  const headers = cleanCachedHeaders(cached.headers);
  const upstreamStatus = Number(cached.headers.get('x-cactus-upstream-status') || 200);
  const contentRange = cached.headers.get('x-cactus-content-range') || '';
  headers.delete('x-cactus-upstream-status');
  headers.delete('x-cactus-content-range');
  headers.set('x-cactus-streamflow', 'HIT');
  headers.set('cache-control', 'private, max-age=60');
  if (contentRange) headers.set('content-range', contentRange);
  if (upstreamStatus === 206 || contentRange) headers.set('accept-ranges', 'bytes');
  return new Response(cached.body, { status: upstreamStatus === 206 || contentRange ? 206 : 200, headers });
}

export async function storeStreamflowObject(
  origin: string,
  sessionId: string,
  objectId: string,
  generation: number,
  range: string,
  response: Response,
): Promise<void> {
  if (!streamflowReady() || !response.ok || !validStreamflowId(sessionId) || !validObjectId(objectId)) return;
  const length = Number(response.headers.get('content-length') || 0);
  if (length > MAX_PREFETCH_OBJECT_BYTES) return;
  const key = streamflowObjectCacheRequest(origin, sessionId, objectId, generation, range);
  await caches.default.put(key, cacheableStreamflowResponse(response, objectId));
}

export async function rememberStreamflowHint(
  origin: string,
  sessionId: string,
  generation: number,
  hint: StreamflowHint,
): Promise<void> {
  if (!streamflowReady() || !validStreamflowId(sessionId)) return;
  const response = new Response(JSON.stringify(hint), {
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': `public, max-age=${STREAMFLOW_HINT_TTL_SECONDS}`,
    },
  });
  await caches.default.put(streamflowHintCacheRequest(origin, sessionId, generation), response);
}

async function readStreamflowHint(origin: string, sessionId: string, generation: number): Promise<StreamflowHint | null> {
  if (!streamflowReady()) return null;
  const response = await caches.default.match(streamflowHintCacheRequest(origin, sessionId, generation));
  if (!response) return null;
  try {
    const hint = await response.json<StreamflowHint>();
    if (!hint?.playlistUrl || !hint?.trackId || !hint?.provider) return null;
    return hint;
  } catch { return null; }
}

async function fetchAllowed(provider: Provider, rawUrl: string, range = ''): Promise<Response> {
  let current = providerAllowsUrl(provider, rawUrl);
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const headers = new Headers({ Accept: '*/*', 'User-Agent': 'CactusTV/0.8', ...provider.requestHeaders });
    if (range) headers.set('range', range);
    const response = await fetchWithTimeout(current.toString(), { headers, redirect: 'manual' }, 14_000);
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    const location = response.headers.get('location');
    if (!location) return response;
    current = providerAllowsUrl(provider, new URL(location, current).toString());
  }
  throw new HttpError(502, '媒体地址重定向次数过多', 'TOO_MANY_REDIRECTS');
}

async function fetchPlaylist(provider: Provider, rawUrl: string): Promise<{ text: string; url: URL }> {
  const response = await fetchAllowed(provider, rawUrl);
  if (!response.ok) throw new HttpError(502, `播放列表上游返回 HTTP ${response.status}`, 'STREAMFLOW_PLAYLIST_ERROR');
  const length = Number(response.headers.get('content-length') || 0);
  if (length > MAX_PLAYLIST_BYTES) throw new HttpError(502, '播放列表过大', 'PLAYLIST_TOO_LARGE');
  const text = await response.text();
  if (text.length > MAX_PLAYLIST_BYTES || !text.trimStart().startsWith('#EXTM3U')) {
    throw new HttpError(415, 'CactusStreamflow 目前只预取 HLS 点播', 'STREAMFLOW_HLS_REQUIRED');
  }
  const finalUrl = response.url ? providerAllowsUrl(provider, response.url) : providerAllowsUrl(provider, rawUrl);
  return { text, url: finalUrl };
}

function parseAttributes(input: string): Record<string, string> {
  const result: Record<string, string> = {};
  const regex = /([A-Z0-9-]+)=("(?:[^"\\]|\\.)*"|[^,]*)/gi;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(input))) {
    let value = match[2].trim();
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1).replace(/\\"/g, '"');
    result[match[1].toUpperCase()] = value;
  }
  return result;
}

function parseByteRange(value: string): { length: number; offset?: number } | null {
  const match = String(value || '').trim().match(/^(\d+)(?:@(\d+))?$/);
  if (!match) return null;
  const length = Number(match[1]);
  const offset = match[2] == null ? undefined : Number(match[2]);
  if (!(length > 0) || (offset != null && offset < 0)) return null;
  return { length, offset };
}

function rangeSuffix(range?: ByteRange): string {
  return range ? `-br-${range.start}-${range.length}` : '';
}

function rangeHeader(range?: ByteRange): string {
  return range ? `bytes=${range.start}-${range.start + range.length - 1}` : '';
}

function chooseVariant(text: string, base: URL): { url: string; trackId: string } | null {
  const lines = text.split(/\r?\n/);
  const variants: Array<{ url: string; trackId: string; height: number; bandwidth: number }> = [];
  let pending: Record<string, string> | null = null;
  let index = 0;
  for (const raw of lines) {
    const line = raw.trim();
    if (line.startsWith('#EXT-X-STREAM-INF:')) {
      pending = parseAttributes(line.slice(line.indexOf(':') + 1));
      continue;
    }
    if (!pending || !line || line.startsWith('#')) continue;
    try {
      const resolution = String(pending.RESOLUTION || '').split('x');
      variants.push({
        url: new URL(line, base).toString(),
        trackId: `v${index}`,
        height: Number(resolution[1] || 0),
        bandwidth: Number(pending.BANDWIDTH || pending['AVERAGE-BANDWIDTH'] || 0),
      });
      index += 1;
    } catch {}
    pending = null;
  }
  if (!variants.length) return null;
  const sensible = variants.filter(item => !item.height || item.height <= 1080);
  return (sensible.length ? sensible : variants)
    .sort((a, b) => (b.height - a.height) || (b.bandwidth - a.bandwidth))[0];
}

function parseMediaPlaylist(text: string, base: URL, trackId: string): PlannedSegment[] {
  const lines = text.split(/\r?\n/);
  const previousRangeEnd = new Map<string, number>();
  let mediaSequence = 0;
  let segmentIndex = 0;
  let mapIndex = 0;
  let keyIndex = 0;
  let pendingDuration = 0;
  let pendingRange: { length: number; offset?: number } | null = null;
  let currentTime = 0;
  let currentMap: PlannedObject | undefined;
  let currentKey: PlannedObject | undefined;
  const segments: PlannedSegment[] = [];

  const materializeRange = (absolute: string, raw: { length: number; offset?: number } | null): ByteRange | undefined => {
    if (!raw) return undefined;
    const start = raw.offset == null ? (previousRangeEnd.get(absolute) || 0) : raw.offset;
    previousRangeEnd.set(absolute, start + raw.length);
    return { start, length: raw.length };
  };

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) {
      mediaSequence = Math.max(0, Number(line.slice(line.indexOf(':') + 1)) || 0);
      continue;
    }
    if (line.startsWith('#EXTINF:')) {
      pendingDuration = Math.max(0, Number(line.slice(line.indexOf(':') + 1).split(',')[0]) || 0);
      continue;
    }
    if (line.startsWith('#EXT-X-BYTERANGE:')) {
      pendingRange = parseByteRange(line.slice(line.indexOf(':') + 1));
      continue;
    }
    if (line.startsWith('#EXT-X-MAP:')) {
      const attrs = parseAttributes(line.slice(line.indexOf(':') + 1));
      if (!attrs.URI) continue;
      try {
        const absolute = new URL(attrs.URI, base).toString();
        const range = materializeRange(absolute, parseByteRange(attrs.BYTERANGE || ''));
        currentMap = { url: absolute, objectId: `${trackId}--map-${mapIndex++}${rangeSuffix(range)}`, range, kind: 'map' };
      } catch {}
      continue;
    }
    if (line.startsWith('#EXT-X-KEY:')) {
      const attrs = parseAttributes(line.slice(line.indexOf(':') + 1));
      if (String(attrs.METHOD || '').toUpperCase() === 'NONE' || !attrs.URI) {
        currentKey = undefined;
      } else {
        try {
          currentKey = { url: new URL(attrs.URI, base).toString(), objectId: `${trackId}--key-${keyIndex++}`, kind: 'key' };
        } catch { currentKey = undefined; }
      }
      continue;
    }
    if (line.startsWith('#')) continue;
    try {
      const absolute = new URL(line, base).toString();
      const range = materializeRange(absolute, pendingRange);
      const duration = pendingDuration > 0 ? pendingDuration : 6;
      const start = currentTime;
      const end = start + duration;
      segments.push({
        start,
        end,
        object: {
          url: absolute,
          objectId: `${trackId}--seg-${mediaSequence + segmentIndex}${rangeSuffix(range)}`,
          range,
          kind: 'segment',
        },
        map: currentMap,
        key: currentKey,
      });
      currentTime = end;
      segmentIndex += 1;
      pendingDuration = 0;
      pendingRange = null;
    } catch {}
  }
  return segments;
}

function prefetchLimit(phase: string): number {
  if (phase === 'exit' || phase === 'hidden') return STREAMFLOW_MAX_PREFETCH_OBJECTS;
  if (phase === 'paused') return 9;
  return 7;
}

async function cachePlannedObject(input: StreamflowPrefetchInput, object: PlannedObject): Promise<'hit' | 'stored' | 'skipped'> {
  const range = rangeHeader(object.range);
  const key = streamflowObjectCacheRequest(input.origin, input.sessionId, object.objectId, input.generation, range);
  if (await caches.default.match(key)) return 'hit';
  const response = await fetchAllowed(input.provider, object.url, range);
  if (!response.ok && response.status !== 206) return 'skipped';
  const length = Number(response.headers.get('content-length') || 0);
  if (length > MAX_PREFETCH_OBJECT_BYTES) {
    try { await response.body?.cancel(); } catch {}
    return 'skipped';
  }
  await caches.default.put(key, cacheableStreamflowResponse(response, object.objectId));
  return 'stored';
}

export async function prefetchStreamflow(input: StreamflowPrefetchInput): Promise<void> {
  if (!streamflowReady() || !validStreamflowId(input.sessionId)) return;
  const window = cacheWindow(input.position, input.duration);
  if (!window.eligible) return;

  const hint = await readStreamflowHint(input.origin, input.sessionId, input.generation);
  let playlistUrl = hint?.provider === input.provider.id ? hint.playlistUrl : input.sourceUrl;
  let trackId = hint?.provider === input.provider.id ? hint.trackId : 'main';
  let playlist = await fetchPlaylist(input.provider, playlistUrl);

  const variant = chooseVariant(playlist.text, playlist.url);
  if (variant) {
    playlistUrl = variant.url;
    trackId = variant.trackId;
    playlist = await fetchPlaylist(input.provider, playlistUrl);
  }

  const segments = parseMediaPlaylist(playlist.text, playlist.url, trackId)
    .filter(segment => segment.end >= window.start && segment.start <= window.end);
  if (!segments.length) return;

  const planned: PlannedObject[] = [];
  const seen = new Set<string>();
  const push = (object?: PlannedObject) => {
    if (!object || seen.has(object.objectId)) return;
    seen.add(object.objectId);
    planned.push(object);
  };
  for (const segment of segments) {
    push(segment.map);
    push(segment.key);
    push(segment.object);
  }

  const limit = prefetchLimit(input.phase);
  let attempted = 0;
  const scan = planned.slice(0, 72);
  for (let index = 0; index < scan.length && attempted < limit; index += 3) {
    const batch = scan.slice(index, index + 3);
    const results = await Promise.allSettled(batch.map(object => cachePlannedObject(input, object)));
    attempted += results.filter(result => result.status === 'fulfilled' && result.value !== 'hit').length;
  }
}
