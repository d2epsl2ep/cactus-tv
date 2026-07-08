import { HttpError } from './http';

export type MediaKind = 'jellyfin' | 'emby';

export interface MediaSession {
  id: string;
  kind: MediaKind;
  serverUrl: string;
  apiBase: string;
  token: string;
  userId: string;
  userName: string;
  deviceId: string;
  serverId: string;
  serverName: string;
  serverVersion: string;
  createdAt: number;
  expiresAt: number;
}

const SESSION_TTL_SECONDS = 24 * 60 * 60;
const PRIVATE_HOSTS = /^(localhost|127\.|0\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|\[?::1\]?$)/i;
const SESSION_ORIGIN = 'https://cactus-media-session.invalid';

function cleanSegment(value: unknown, max = 200): string {
  return String(value ?? '').trim().slice(0, max);
}

function escapeAuth(value: string): string {
  return value.replace(/["\\\r\n]/g, '');
}

export function normalizeMediaKind(value: unknown): MediaKind {
  const kind = cleanSegment(value, 20).toLowerCase();
  if (kind !== 'jellyfin' && kind !== 'emby') {
    throw new HttpError(400, '媒体库类型必须是 Jellyfin 或 Emby', 'INVALID_MEDIA_KIND');
  }
  return kind;
}

export function normalizeMediaServer(value: unknown, kind: MediaKind): { serverUrl: string; apiBase: string } {
  let url: URL;
  try { url = new URL(cleanSegment(value, 1000)); }
  catch { throw new HttpError(400, '服务器地址格式无效', 'INVALID_MEDIA_URL'); }

  if (url.protocol !== 'https:') {
    throw new HttpError(400, 'Cloudflare 部署仅支持可从公网访问的 HTTPS 媒体库', 'MEDIA_HTTPS_REQUIRED');
  }
  if (PRIVATE_HOSTS.test(url.hostname) || url.hostname.endsWith('.local')) {
    throw new HttpError(400, 'Cloudflare 无法连接局域网地址，请使用公网 HTTPS 反向代理地址', 'MEDIA_PRIVATE_NETWORK');
  }
  if (url.username || url.password) {
    throw new HttpError(400, '服务器地址中不要包含账号密码', 'MEDIA_URL_CREDENTIALS');
  }
  url.search = '';
  url.hash = '';
  url.pathname = url.pathname.replace(/\/+$/, '') || '/';
  const serverUrl = url.toString().replace(/\/$/, url.pathname === '/' ? '' : '');

  let apiBase = serverUrl.replace(/\/$/, '');
  if (kind === 'emby' && !/\/emby$/i.test(new URL(apiBase).pathname)) apiBase += '/emby';
  return { serverUrl, apiBase };
}

export function mediaApiUrl(session: Pick<MediaSession, 'apiBase'>, path: string, params: Record<string, unknown> = {}): string {
  const url = new URL(`${session.apiBase.replace(/\/$/, '')}/${String(path).replace(/^\/+/, '')}`);
  for (const [key, raw] of Object.entries(params)) {
    if (raw === undefined || raw === null || raw === '') continue;
    url.searchParams.set(key, String(raw));
  }
  return url.toString();
}

export function mediaAuthHeaders(session: Pick<MediaSession, 'token' | 'userId' | 'deviceId'>, extra: HeadersInit = {}): Headers {
  const headers = new Headers(extra);
  headers.set('Accept', headers.get('Accept') || 'application/json, text/plain;q=0.9, */*;q=0.8');
  const parts = [
    `Client="Cactus TV"`,
    `Device="Web"`,
    `DeviceId="${escapeAuth(session.deviceId)}"`,
    'Version="0.6.0"',
  ];
  if (session.userId) parts.push(`UserId="${escapeAuth(session.userId)}"`);
  if (session.token) parts.push(`Token="${escapeAuth(session.token)}"`);
  const authorization = `MediaBrowser ${parts.join(', ')}`;
  headers.set('Authorization', authorization);
  headers.set('X-Emby-Authorization', authorization);
  if (session.token) headers.set('X-Emby-Token', session.token);
  return headers;
}

export async function fetchMedia(
  session: Pick<MediaSession, 'apiBase' | 'token' | 'userId' | 'deviceId'>,
  path: string,
  options: RequestInit = {},
  params: Record<string, unknown> = {},
  timeoutMs = 15_000,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(mediaApiUrl(session, path, params), {
      ...options,
      headers: mediaAuthHeaders(session, options.headers),
      signal: controller.signal,
      redirect: 'follow',
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new HttpError(504, '媒体服务器响应超时', 'MEDIA_UPSTREAM_TIMEOUT');
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchMediaJson(
  session: Pick<MediaSession, 'apiBase' | 'token' | 'userId' | 'deviceId'>,
  path: string,
  options: RequestInit = {},
  params: Record<string, unknown> = {},
  timeoutMs = 15_000,
): Promise<any> {
  const response = await fetchMedia(session, path, options, params, timeoutMs);
  const text = await response.text();
  if (!response.ok) {
    let message = '';
    try {
      const payload = JSON.parse(text || '{}');
      message = payload?.Message || payload?.message || payload?.error || '';
    } catch {}
    if (response.status === 401 || response.status === 403) {
      throw new HttpError(401, message || '媒体库登录已失效，请重新连接', 'MEDIA_AUTH_FAILED');
    }
    throw new HttpError(502, message || `媒体服务器返回 HTTP ${response.status}`, 'MEDIA_UPSTREAM_ERROR');
  }
  if (!text) return {};
  if (text.length > 8_000_000) throw new HttpError(502, '媒体服务器响应过大', 'MEDIA_RESPONSE_TOO_LARGE');
  try { return JSON.parse(text); }
  catch { throw new HttpError(502, '媒体服务器没有返回有效 JSON', 'MEDIA_INVALID_JSON'); }
}

function sessionCacheKey(id: string): Request {
  return new Request(`${SESSION_ORIGIN}/${encodeURIComponent(id)}`);
}

function randomId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  let binary = '';
  bytes.forEach(byte => { binary += String.fromCharCode(byte); });
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

export async function saveMediaSession(input: Omit<MediaSession, 'id' | 'createdAt' | 'expiresAt'>): Promise<MediaSession> {
  const now = Date.now();
  const session: MediaSession = {
    ...input,
    id: randomId(),
    createdAt: now,
    expiresAt: now + SESSION_TTL_SECONDS * 1000,
  };
  await caches.default.put(sessionCacheKey(session.id), new Response(JSON.stringify(session), {
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': `public, max-age=${SESSION_TTL_SECONDS}`,
    },
  }));
  return session;
}

export async function getMediaSession(id: unknown): Promise<MediaSession> {
  const sessionId = cleanSegment(id, 100);
  if (!/^[A-Za-z0-9_-]{20,100}$/.test(sessionId)) {
    throw new HttpError(401, '媒体库会话无效，请重新连接', 'MEDIA_SESSION_INVALID');
  }
  const response = await caches.default.match(sessionCacheKey(sessionId));
  if (!response) throw new HttpError(401, '媒体库会话已过期，请重新连接', 'MEDIA_SESSION_EXPIRED');
  const session = (await response.json()) as MediaSession;
  if (!session?.token || !session?.userId || session.expiresAt <= Date.now()) {
    throw new HttpError(401, '媒体库会话已过期，请重新连接', 'MEDIA_SESSION_EXPIRED');
  }
  return session;
}

export function publicMediaSession(session: MediaSession) {
  return {
    sessionId: session.id,
    expiresAt: session.expiresAt,
    kind: session.kind,
    serverUrl: session.serverUrl,
    serverId: session.serverId,
    serverName: session.serverName,
    serverVersion: session.serverVersion,
    userId: session.userId,
    userName: session.userName,
    deviceId: session.deviceId,
  };
}

export function ticksToSeconds(value: unknown): number {
  const ticks = Number(value || 0);
  return Number.isFinite(ticks) && ticks > 0 ? ticks / 10_000_000 : 0;
}

export function secondsToTicks(value: unknown): number {
  const seconds = Number(value || 0);
  return Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds * 10_000_000) : 0;
}

export function mediaImageDescriptor(item: any) {
  return {
    primaryTag: String(item?.ImageTags?.Primary || ''),
    backdropTag: String(item?.BackdropImageTags?.[0] || ''),
    parentBackdropItemId: String(item?.ParentBackdropItemId || ''),
    parentBackdropTag: String(item?.ParentBackdropImageTags?.[0] || ''),
    seriesPrimaryItemId: String(item?.SeriesId || ''),
    seriesPrimaryTag: String(item?.SeriesPrimaryImageTag || ''),
  };
}

export function mapMediaItem(item: any) {
  const type = String(item?.Type || '');
  const isSeries = type === 'Series';
  const isEpisode = type === 'Episode';
  const userData = item?.UserData || {};
  const season = Number(item?.ParentIndexNumber || 0);
  const episode = Number(item?.IndexNumber || 0);
  const episodeLabel = isEpisode
    ? `${season ? `S${String(season).padStart(2, '0')}` : ''}${episode ? `E${String(episode).padStart(2, '0')}` : ''}`
    : '';
  const isPlaylist = type === 'Playlist';
  const isFolder = ['Folder', 'CollectionFolder', 'BoxSet', 'UserView'].includes(type);
  return {
    id: String(item?.Id || ''),
    name: String(item?.Name || '未命名'),
    rawType: type,
    mediaContainer: isPlaylist ? 'playlist' : isFolder ? 'folder' : '',
    originalName: String(item?.OriginalTitle || ''),
    mediaType: isPlaylist ? 'playlist' : isSeries || isEpisode ? 'tv' : type === 'Movie' ? 'movie' : 'other',
    type: isPlaylist ? '播放列表' : isSeries ? '剧集' : isEpisode ? '单集' : type === 'Movie' ? '电影' : type || '视频',
    year: String(item?.ProductionYear || ''),
    overview: String(item?.Overview || ''),
    rating: Number(item?.CommunityRating || item?.CriticRating || 0),
    officialRating: String(item?.OfficialRating || ''),
    genres: Array.isArray(item?.Genres) ? item.Genres.slice(0, 8).map(String) : [],
    runTime: ticksToSeconds(item?.RunTimeTicks),
    remarks: episodeLabel || String(item?.ProductionYear || ''),
    seriesName: String(item?.SeriesName || ''),
    seasonName: String(item?.SeasonName || ''),
    indexNumber: episode,
    parentIndexNumber: season,
    played: Boolean(userData?.Played),
    playbackPosition: ticksToSeconds(userData?.PlaybackPositionTicks),
    playedPercentage: Number(userData?.PlayedPercentage || 0),
    favorite: Boolean(userData?.IsFavorite),
    images: mediaImageDescriptor(item),
  };
}

export function encodeProxyTarget(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  bytes.forEach(byte => { binary += String.fromCharCode(byte); });
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

export function decodeProxyTarget(value: string): string {
  try {
    const padded = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4);
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, char => char.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  } catch {
    throw new HttpError(400, '媒体代理地址无效', 'MEDIA_PROXY_TARGET_INVALID');
  }
}

export function validateProxyTarget(session: MediaSession, raw: string): URL {
  let target: URL;
  try { target = new URL(raw); }
  catch { throw new HttpError(400, '媒体代理地址无效', 'MEDIA_PROXY_TARGET_INVALID'); }
  const server = new URL(session.serverUrl);
  if (target.protocol !== 'https:' || target.origin !== server.origin) {
    throw new HttpError(403, '媒体代理目标不在当前服务器', 'MEDIA_PROXY_TARGET_BLOCKED');
  }
  const prefix = server.pathname.replace(/\/+$/, '') || '/';
  if (prefix !== '/' && target.pathname !== prefix && !target.pathname.startsWith(`${prefix}/`)) {
    throw new HttpError(403, '媒体代理路径不在允许范围', 'MEDIA_PROXY_PATH_BLOCKED');
  }
  return target;
}
