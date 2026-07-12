const KEYS = {
  favorites: 'cactus:favorites:v2',
  history: 'cactus:history:v2',
  settings: 'cactus:settings:v3',
  sourceHealth: 'cactus:source-health:v1',
  d1Migrated: 'cactus:d1-library-migrated:v1',
  d1Pending: 'cactus:d1-library-pending:v1',
};

function read(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback; }
  catch { return fallback; }
}

function writeNow(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); }
  catch {}
}

const state = {
  favorites: read(KEYS.favorites, []),
  history: read(KEYS.history, []),
  settings: {
    recordHistory: true,
    preferNativeHls: true,
    resumePlayback: true,
    autoFailover: true,
    autoNext: true,
    cleanStreamEnabled: false,
    personalizedRecommendations: true,
    ...read('cactus:settings:v2', {}),
    ...read(KEYS.settings, {}),
  },
  sourceHealth: read(KEYS.sourceHealth, {}),
};

let favoriteKeys = new Set(state.favorites.map(item => item.key));
let historyMap = new Map(state.history.map(item => [item.key, item]));
const pendingWrites = new Map();
const remoteOperations = new Map(
  (Array.isArray(read(KEYS.d1Pending, [])) ? read(KEYS.d1Pending, []) : [])
    .filter(operation => operation?.type && (operation?.key || operation?.item?.key))
    .map(operation => [operationId(operation), operation]),
);
let writeScheduled = false;
let remoteFlushTimer = 0;
let remoteFlushPromise = null;
let remoteReadyPromise = null;
let remoteAvailable = false;

function operationId(operation) {
  return `${operation?.type || 'unknown'}:${operation?.key || operation?.item?.key || ''}`;
}

function flush() {
  writeScheduled = false;
  for (const [key, value] of pendingWrites) writeNow(key, value);
  pendingWrites.clear();
}

function scheduleWrite(key, value) {
  pendingWrites.set(key, value);
  if (writeScheduled) return;
  writeScheduled = true;
  if ('requestIdleCallback' in window) requestIdleCallback(flush, { timeout: 700 });
  else setTimeout(flush, 0);
}

function cloneList(list) { return list.map(item => ({ ...item })); }

function replaceFavoritesLocal(list) {
  state.favorites = Array.isArray(list) ? list.filter(item => item?.key).slice(0, 300) : [];
  favoriteKeys = new Set(state.favorites.map(item => item.key));
  scheduleWrite(KEYS.favorites, state.favorites);
}

function replaceHistoryLocal(list) {
  state.history = Array.isArray(list) ? list.filter(item => item?.key).slice(0, 200) : [];
  historyMap = new Map(state.history.map(item => [item.key, item]));
  scheduleWrite(KEYS.history, state.history);
}

function persistRemoteOperations() {
  writeNow(KEYS.d1Pending, [...remoteOperations.values()]);
}

function queueRemote(operation) {
  if (!operation?.type) return;
  const id = operationId(operation);
  if (!id.endsWith(':')) remoteOperations.set(id, operation);
  persistRemoteOperations();
  scheduleRemoteFlush();
}

function scheduleRemoteFlush(delay = 350) {
  clearTimeout(remoteFlushTimer);
  remoteFlushTimer = setTimeout(() => { flushRemote().catch(() => {}); }, delay);
}

async function requestLibrary(path = '/api/library', options = {}) {
  const response = await fetch(path, {
    credentials: 'same-origin',
    headers: {
      Accept: 'application/json',
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(options.headers || {}),
    },
    ...options,
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `片单同步失败（${response.status}）`);
  return payload;
}

async function flushRemote(options = {}) {
  if (remoteFlushPromise) return remoteFlushPromise;
  if (!remoteOperations.size) return true;

  remoteFlushPromise = (async () => {
    while (remoteOperations.size) {
      const batch = [...remoteOperations.entries()].slice(0, 20);
      const operations = batch.map(([, operation]) => operation);
      await requestLibrary('/api/library', {
        method: 'POST',
        body: JSON.stringify({ action: 'batch', operations }),
        keepalive: Boolean(options.keepalive),
      });
      for (const [id, sent] of batch) {
        if (remoteOperations.get(id) === sent) remoteOperations.delete(id);
      }
      persistRemoteOperations();
      remoteAvailable = true;
    }
    return true;
  })().catch(error => {
    remoteAvailable = false;
    throw error;
  }).finally(() => {
    remoteFlushPromise = null;
  });

  return remoteFlushPromise;
}

function mergeByKey(primary, secondary) {
  const map = new Map();
  for (const item of [...(primary || []), ...(secondary || [])]) {
    if (item?.key && !map.has(item.key)) map.set(item.key, item);
  }
  return [...map.values()];
}

async function syncRemote() {
  try {
    if (remoteOperations.size) await flushRemote();
    const payload = await requestLibrary();
    const remoteFavorites = Array.isArray(payload.favorites) ? payload.favorites : [];
    const remoteHistory = Array.isArray(payload.history) ? payload.history : [];
    const migrated = localStorage.getItem(KEYS.d1Migrated) === '1';

    if (!migrated) {
      const mergedFavorites = mergeByKey(remoteFavorites, state.favorites).slice(0, 300);
      const mergedHistory = mergeByKey(
        [...remoteHistory].sort((a, b) => Number(b?.watchedAt || 0) - Number(a?.watchedAt || 0)),
        [...state.history].sort((a, b) => Number(b?.watchedAt || 0) - Number(a?.watchedAt || 0)),
      ).sort((a, b) => Number(b?.watchedAt || 0) - Number(a?.watchedAt || 0)).slice(0, 200);

      const remoteFavoriteKeys = new Set(remoteFavorites.map(item => item?.key));
      const remoteHistoryKeys = new Set(remoteHistory.map(item => item?.key));
      for (const item of state.favorites) {
        if (item?.key && !remoteFavoriteKeys.has(item.key)) queueRemote({ type: 'favorite', enabled: true, item });
      }
      for (const item of state.history) {
        if (item?.key && !remoteHistoryKeys.has(item.key)) queueRemote({ type: 'history', item });
      }

      replaceFavoritesLocal(mergedFavorites);
      replaceHistoryLocal(mergedHistory);
      try { localStorage.setItem(KEYS.d1Migrated, '1'); } catch {}
    } else {
      replaceFavoritesLocal(remoteFavorites);
      replaceHistoryLocal(remoteHistory);
    }

    remoteAvailable = true;
    await flushRemote().catch(() => {});
    return true;
  } catch {
    remoteAvailable = false;
    scheduleRemoteFlush(2500);
    return false;
  }
}

function healthId(provider, resource = '') {
  const base = String(provider || '').trim();
  const detail = String(resource || '').trim();
  if (!base) return '';
  return detail ? `resource:${detail}` : `provider:${base}`;
}

function healthEntry(provider, resource = '') {
  const id = healthId(provider, resource);
  if (!id) return null;
  const legacy = state.sourceHealth[provider];
  return state.sourceHealth[id] || (!resource && legacy) || {
    score: 0, successes: 0, failures: 0, lastSuccess: 0, lastFailure: 0, updatedAt: 0,
  };
}

function decayedScore(entry, now = Date.now()) {
  const updatedAt = Number(entry?.updatedAt || Math.max(entry?.lastSuccess || 0, entry?.lastFailure || 0));
  const legacy = Number.isFinite(Number(entry?.score))
    ? Number(entry.score)
    : Number(entry?.successes || 0) * 2 - Number(entry?.failures || 0) * 3;
  if (!updatedAt) return legacy;
  const ageDays = Math.max(0, now - updatedAt) / 864e5;
  return legacy * Math.exp(-ageDays / 14);
}

function saveHealth(provider, resource, success) {
  const id = healthId(provider, resource);
  if (!id) return;
  const current = healthEntry(provider, resource);
  const now = Date.now();
  const nextScore = Math.max(-30, Math.min(30, decayedScore(current, now) + (success ? 2 : -3)));
  state.sourceHealth[id] = {
    ...current,
    score: nextScore,
    successes: Number(current.successes || 0) + (success ? 1 : 0),
    failures: Number(current.failures || 0) + (success ? 0 : 1),
    lastSuccess: success ? now : Number(current.lastSuccess || 0),
    lastFailure: success ? Number(current.lastFailure || 0) : now,
    updatedAt: now,
  };
  const entries = Object.entries(state.sourceHealth)
    .sort((a, b) => Number(b[1].updatedAt || Math.max(b[1].lastSuccess || 0, b[1].lastFailure || 0)) - Number(a[1].updatedAt || Math.max(a[1].lastSuccess || 0, a[1].lastFailure || 0)))
    .slice(0, 160);
  state.sourceHealth = Object.fromEntries(entries);
  scheduleWrite(KEYS.sourceHealth, state.sourceHealth);
}

export const store = {
  ready() {
    if (!remoteReadyPromise) remoteReadyPromise = syncRemote();
    return remoteReadyPromise;
  },
  remoteAvailable() { return remoteAvailable; },

  favorites() { return cloneList(state.favorites); },
  replaceFavorites(list) { replaceFavoritesLocal(list); },
  isFavorite(key) { return favoriteKeys.has(key); },
  setFavorite(item, enabled) {
    if (!item?.key) return false;
    const next = state.favorites.filter(entry => entry.key !== item.key);
    if (enabled) next.unshift(item);
    replaceFavoritesLocal(next);
    queueRemote(enabled
      ? { type: 'favorite', enabled: true, item }
      : { type: 'favorite', enabled: false, key: item.key });
    return enabled;
  },
  toggleFavorite(item) { return this.setFavorite(item, !favoriteKeys.has(item.key)); },

  history() { return cloneList(state.history); },
  replaceHistory(list) { replaceHistoryLocal(list); },
  upsertHistory(item) {
    if (!item?.key) return;
    const record = { ...(historyMap.get(item.key) || {}), ...item, watchedAt: Date.now() };
    const next = state.history.filter(entry => entry.key !== item.key);
    next.unshift(record);
    replaceHistoryLocal(next);
    queueRemote({ type: 'history', item: record });
  },
  repairHistory(item) {
    if (!item?.key) return;
    const existing = historyMap.get(item.key) || {};
    const record = {
      ...existing,
      ...item,
      watchedAt: Number(item.watchedAt || existing.watchedAt || Date.now()),
    };
    const next = state.history.filter(entry => entry.key !== item.key);
    next.push(record);
    next.sort((a, b) => Number(b?.watchedAt || 0) - Number(a?.watchedAt || 0));
    replaceHistoryLocal(next);
    queueRemote({ type: 'history', item: record });
  },
  deleteHistory(key) {
    const value = String(key || '').trim();
    if (!value || !historyMap.has(value)) return false;
    replaceHistoryLocal(state.history.filter(entry => entry.key !== value));
    queueRemote({ type: 'history-delete', key: value });
    return true;
  },
  addHistory(item) { this.upsertHistory(item); },
  updateProgress(key, position, duration, url, extra = {}) {
    const existing = historyMap.get(key);
    if (!existing) return;
    this.upsertHistory({
      ...existing,
      position,
      duration,
      ...(url ? { url } : {}),
      ...extra,
    });
  },
  progress(key) {
    const entry = historyMap.get(key);
    return entry ? { ...entry } : null;
  },

  settings() { return { ...state.settings }; },
  saveSettings(settings) {
    state.settings = { ...state.settings, ...settings };
    scheduleWrite(KEYS.settings, state.settings);
  },

  recordSourceSuccess(provider, resource = '') {
    saveHealth(provider, '', true);
    if (resource) saveHealth(provider, resource, true);
  },
  recordSourceFailure(provider, resource = '') {
    saveHealth(provider, '', false);
    if (resource) saveHealth(provider, resource, false);
  },
  sourceScore(provider, resource = '') {
    const providerScore = decayedScore(healthEntry(provider));
    if (!resource) return providerScore;
    const resourceScore = decayedScore(healthEntry(provider, resource));
    return providerScore * 0.45 + resourceScore * 0.55;
  },

  flush() {
    flush();
    return flushRemote().catch(() => false);
  },
};

window.addEventListener('online', () => {
  remoteReadyPromise = null;
  store.ready().catch(() => {});
});
window.addEventListener('pagehide', () => {
  flush();
  flushRemote({ keepalive: true }).catch(() => {});
}, { capture: true });
