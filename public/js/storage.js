const KEYS = {
  favorites: 'cactus:favorites:v2',
  history: 'cactus:history:v2',
  settings: 'cactus:settings:v3',
  sourceHealth: 'cactus:source-health:v1',
};

function read(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback; }
  catch { return fallback; }
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
    ...read('cactus:settings:v2', {}),
    ...read(KEYS.settings, {}),
  },
  sourceHealth: read(KEYS.sourceHealth, {}),
};

let favoriteKeys = new Set(state.favorites.map(item => item.key));
let historyMap = new Map(state.history.map(item => [item.key, item]));
const pendingWrites = new Map();
let writeScheduled = false;

function flush() {
  writeScheduled = false;
  for (const [key, value] of pendingWrites) {
    try { localStorage.setItem(key, JSON.stringify(value)); }
    catch {}
  }
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

function replaceFavorites(list) {
  state.favorites = Array.isArray(list) ? list.slice(0, 300) : [];
  favoriteKeys = new Set(state.favorites.map(item => item.key));
  scheduleWrite(KEYS.favorites, state.favorites);
}

function replaceHistory(list) {
  state.history = Array.isArray(list) ? list.slice(0, 200) : [];
  historyMap = new Map(state.history.map(item => [item.key, item]));
  scheduleWrite(KEYS.history, state.history);
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
  favorites() { return cloneList(state.favorites); },
  replaceFavorites,
  isFavorite(key) { return favoriteKeys.has(key); },
  setFavorite(item, enabled) {
    const next = state.favorites.filter(entry => entry.key !== item.key);
    if (enabled) next.unshift(item);
    replaceFavorites(next);
    return enabled;
  },
  toggleFavorite(item) { return this.setFavorite(item, !favoriteKeys.has(item.key)); },

  history() { return cloneList(state.history); },
  replaceHistory,
  upsertHistory(item) {
    if (!item?.key) return;
    const record = { ...(historyMap.get(item.key) || {}), ...item, watchedAt: Date.now() };
    const next = state.history.filter(entry => entry.key !== item.key);
    next.unshift(record);
    replaceHistory(next);
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

  flush,
};

window.addEventListener('pagehide', flush, { capture: true });
