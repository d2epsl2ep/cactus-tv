import { api } from './api.js?v=0.5.0';
import { store } from './storage.js?v=0.5.0';

const sessionPromises = new Map();

export function mediaProvider(connectionId) {
  return `media:${connectionId}`;
}

export function isMediaProvider(provider) {
  return String(provider || '').startsWith('media:');
}

export function mediaConnectionId(provider) {
  return isMediaProvider(provider) ? String(provider).slice(6) : '';
}

export function mediaConnectionFromProvider(provider) {
  const id = mediaConnectionId(provider);
  return id ? store.mediaConnection(id) : null;
}

function newConnectionId() {
  return crypto.randomUUID?.() || `media-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export async function ensureMediaSession(connectionOrId, force = false) {
  const connection = typeof connectionOrId === 'string'
    ? store.mediaConnection(connectionOrId)
    : connectionOrId;
  if (!connection) throw new Error('媒体库配置不存在');
  if (!force && connection.sessionId && Number(connection.sessionExpires || 0) > Date.now() + 120_000) return connection;
  if (sessionPromises.has(connection.id)) return sessionPromises.get(connection.id);

  const promise = (async () => {
    const payload = await api.mediaSession({
      kind: connection.kind,
      serverUrl: connection.serverUrl,
      token: connection.token,
      userId: connection.userId,
      deviceId: connection.deviceId,
    });
    const remote = payload.connection;
    return store.updateMediaSession(connection.id, {
      token: remote.token || connection.token,
      userId: remote.userId || connection.userId,
      userName: remote.userName || connection.userName,
      serverName: remote.serverName || connection.serverName,
      serverVersion: remote.serverVersion || connection.serverVersion,
      sessionId: remote.sessionId,
      sessionExpires: remote.expiresAt,
      deviceId: remote.deviceId || connection.deviceId,
    });
  })().finally(() => sessionPromises.delete(connection.id));
  sessionPromises.set(connection.id, promise);
  return promise;
}


function sessionExpired(error) {
  return Number(error?.status || 0) === 401
    && ['MEDIA_SESSION_INVALID', 'MEDIA_SESSION_EXPIRED'].includes(String(error?.code || ''));
}

async function withMediaSession(connection, operation) {
  let active = await ensureMediaSession(connection);
  try {
    return await operation(active);
  } catch (error) {
    if (!sessionExpired(error)) throw error;
    active = await ensureMediaSession(connection, true);
    return operation(active);
  }
}

export async function connectMediaServer(input, existingId = '') {
  const id = existingId || newConnectionId();
  const deviceId = input.deviceId || `cactus-${id}`;
  const payload = await api.mediaSession({ ...input, deviceId });
  const remote = payload.connection;
  return store.saveMediaConnection({
    id,
    kind: remote.kind || input.kind,
    name: String(input.name || remote.serverName || (input.kind === 'jellyfin' ? 'Jellyfin' : 'Emby')).trim(),
    serverUrl: remote.serverUrl || input.serverUrl,
    token: remote.token || input.token,
    userId: remote.userId,
    userName: remote.userName,
    serverName: remote.serverName,
    serverVersion: remote.serverVersion,
    deviceId: remote.deviceId || deviceId,
    sessionId: remote.sessionId,
    sessionExpires: remote.expiresAt,
  });
}

function imageTarget(item, type) {
  const images = item?.images || {};
  if (type === 'Backdrop') {
    if (images.backdropTag) return { id: item.id, tag: images.backdropTag };
    if (images.parentBackdropItemId && images.parentBackdropTag) return { id: images.parentBackdropItemId, tag: images.parentBackdropTag };
    return null;
  }
  if (images.primaryTag) return { id: item.id, tag: images.primaryTag };
  if (images.seriesPrimaryItemId && images.seriesPrimaryTag) return { id: images.seriesPrimaryItemId, tag: images.seriesPrimaryTag };
  return null;
}

export function mediaImageUrl(connection, item, type = 'Primary') {
  if (!connection?.sessionId || !item?.id) return '';
  const target = imageTarget(item, type);
  if (!target) return '';
  const params = new URLSearchParams({
    session: connection.sessionId,
    id: target.id,
    type,
    tag: target.tag || '',
    maxWidth: type === 'Backdrop' ? '1600' : '700',
  });
  return `${location.origin}/api/media/image?${params.toString()}`;
}

export function decorateMediaItem(item, connection) {
  const provider = mediaProvider(connection.id);
  return {
    ...item,
    provider,
    providerName: connection.name,
    key: `media:${connection.id}:${item.id}`,
    mediaLibrary: true,
    mediaConnectionId: connection.id,
    mediaItemId: item.id,
    pic: mediaImageUrl(connection, item, 'Primary'),
    backdrop: mediaImageUrl(connection, item, 'Backdrop'),
  };
}

export function decorateMediaDetail(detail, connection) {
  const base = decorateMediaItem(detail, connection);
  return {
    ...detail,
    ...base,
    provider: mediaProvider(connection.id),
    providerName: connection.name,
    key: `media:${connection.id}:${detail.id}`,
    mediaConnectionId: connection.id,
    mediaLibrary: true,
    lines: (detail.lines || []).map(line => ({
      ...line,
      episodes: (line.episodes || []).map(episode => ({
        ...episode,
        mediaConnectionId: connection.id,
        mediaItemId: episode.mediaItemId || episode.id,
        pic: mediaImageUrl(connection, episode, 'Primary'),
        backdrop: mediaImageUrl(connection, episode, 'Backdrop'),
      })),
    })),
  };
}

export async function loadMediaLibrary() {
  const connections = store.mediaConnections();
  const settled = await Promise.allSettled(connections.map(connection => withMediaSession(connection, async active => {
    const payload = await api.mediaLibrary(active.sessionId, { mode: 'home' });
    return {
      connection: active,
      sections: (payload.sections || []).map(section => ({
        ...section,
        id: `${active.id}-${section.id}`,
        serverName: active.name,
        items: (section.items || []).map(item => decorateMediaItem(item, active)),
      })),
    };
  })));
  const sections = [];
  const errors = [];
  settled.forEach((result, index) => {
    if (result.status === 'fulfilled') sections.push(...result.value.sections);
    else errors.push({ connection: connections[index], error: result.reason });
  });
  return { sections, errors };
}

export async function searchMediaLibraries(query, signal) {
  const connections = store.mediaConnections();
  const settled = await Promise.allSettled(connections.map(connection => withMediaSession(connection, async active => {
    const payload = await api.mediaLibrary(active.sessionId, { mode: 'search', q: query, limit: 50 }, signal);
    return (payload.items || []).map(item => decorateMediaItem(item, active));
  })));
  const items = [];
  const errors = [];
  settled.forEach((result, index) => {
    if (result.status === 'fulfilled') items.push(...result.value);
    else errors.push({ provider: connections[index]?.name || '媒体库', error: result.reason?.message || '连接失败' });
  });
  return { items, errors };
}

export async function fetchMediaDetail(provider, id, signal) {
  const connection = mediaConnectionFromProvider(provider);
  if (!connection) throw new Error('媒体库连接不存在，请在设置中重新添加');
  return withMediaSession(connection, async active => {
    const payload = await api.mediaDetail(active.sessionId, id, signal);
    return { item: decorateMediaDetail(payload.item, active), connection: active };
  });
}

export async function resolveMediaEpisode(detail, lineIndex, episodeIndex, signal) {
  const connection = store.mediaConnection(detail.mediaConnectionId || mediaConnectionId(detail.provider));
  if (!connection) throw new Error('媒体库连接不存在');
  const original = detail.lines?.[lineIndex]?.episodes?.[episodeIndex];
  if (!original?.mediaItemId) throw new Error('该条目没有可播放的媒体文件');
  if (Array.isArray(original.variants) && original.variants.length) return { detail, episode: original };

  return withMediaSession(connection, async active => {
    const payload = await api.mediaPlayback(active.sessionId, original.mediaItemId, signal);
    const lines = (detail.lines || []).map((line, lIndex) => ({
      ...line,
      episodes: (line.episodes || []).map((episode, eIndex) => lIndex === lineIndex && eIndex === episodeIndex
        ? {
            ...episode,
            variants: payload.variants || [],
            subtitles: payload.subtitles || [],
            mediaSource: payload.mediaSource || null,
          }
        : episode),
    }));
    const resolvedDetail = { ...detail, lines };
    return { detail: resolvedDetail, episode: lines[lineIndex].episodes[episodeIndex] };
  });
}

export function removeMediaConnection(id) {
  store.removeMediaConnection(id);
}
