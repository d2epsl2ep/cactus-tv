const memoryCache = new Map();
const inflight = new Map();
const CACHE_PREFIX = 'cactus:api:v5:';

function now() { return Date.now(); }

function readCache(key) {
  const memory = memoryCache.get(key);
  if (memory && memory.expires > now()) return memory.value;
  if (memory) memoryCache.delete(key);

  try {
    const stored = JSON.parse(sessionStorage.getItem(CACHE_PREFIX + key));
    if (stored?.expires > now()) {
      memoryCache.set(key, stored);
      return stored.value;
    }
    sessionStorage.removeItem(CACHE_PREFIX + key);
  } catch {}
  return null;
}

function writeCache(key, value, ttl) {
  if (!ttl) return;
  const entry = { value, expires: now() + ttl };
  memoryCache.set(key, entry);
  if (ttl < 60_000) return;
  try {
    const serialized = JSON.stringify(entry);
    if (serialized.length < 320_000) sessionStorage.setItem(CACHE_PREFIX + key, serialized);
  } catch {}
}

async function requestJson(path, options = {}) {
  const {
    cacheTtl = 0,
    dedupe = true,
    timeout = 12_000,
    signal,
    ...fetchOptions
  } = options;
  const method = String(fetchOptions.method || 'GET').toUpperCase();
  const cacheKey = `${method}:${path}`;

  if (method === 'GET' && cacheTtl) {
    const cached = readCache(cacheKey);
    if (cached) return cached;
  }
  if (method === 'GET' && dedupe && inflight.has(cacheKey)) return inflight.get(cacheKey);

  const controller = new AbortController();
  const abortFromCaller = () => controller.abort(signal?.reason);
  if (signal) {
    if (signal.aborted) abortFromCaller();
    else signal.addEventListener('abort', abortFromCaller, { once: true });
  }
  const timer = setTimeout(() => controller.abort(new DOMException('请求超时', 'TimeoutError')), timeout);

  const promise = (async () => {
    try {
      const response = await fetch(path, {
        credentials: 'same-origin',
        headers: {
          Accept: 'application/json',
          ...(fetchOptions.body ? { 'Content-Type': 'application/json' } : {}),
          ...(fetchOptions.headers || {}),
        },
        ...fetchOptions,
        signal: controller.signal,
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        const error = new Error(payload.error || `请求失败（${response.status}）`);
        error.code = payload.code;
        error.status = response.status;
        error.requestId = payload.requestId;
        throw error;
      }
      if (method === 'GET') writeCache(cacheKey, payload, cacheTtl);
      return payload;
    } catch (error) {
      if (controller.signal.aborted && error?.name === 'AbortError') {
        throw new DOMException('请求已取消', 'AbortError');
      }
      throw error;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener?.('abort', abortFromCaller);
      inflight.delete(cacheKey);
    }
  })();

  if (method === 'GET' && dedupe) inflight.set(cacheKey, promise);
  return promise;
}

export const api = {
  health: () => requestJson('/api/health', { cacheTtl: 60_000, timeout: 8_000 }),
  home: () => requestJson('/api/home', { cacheTtl: 5 * 60_000, timeout: 12_000 }),
  search: (query, signal) => requestJson(`/api/search?q=${encodeURIComponent(query)}`, {
    cacheTtl: 2 * 60_000,
    dedupe: false,
    signal,
    timeout: 20_000,
  }),
  detail: (provider, id, signal) => requestJson(`/api/detail?provider=${encodeURIComponent(provider)}&id=${encodeURIComponent(id)}`, {
    cacheTtl: 2 * 60_000,
    dedupe: false,
    signal,
    timeout: 14_000,
  }),
  mediaSession: connection => requestJson('/api/media/session', {
    method: 'POST',
    body: JSON.stringify(connection),
    dedupe: false,
    timeout: 22_000,
  }),
  mediaLibrary: (sessionId, options = {}, signal) => {
    const params = new URLSearchParams({ session: sessionId, mode: options.mode || 'home' });
    if (options.q) params.set('q', options.q);
    if (options.parent) params.set('parent', options.parent);
    if (options.start != null) params.set('start', String(options.start));
    if (options.limit != null) params.set('limit', String(options.limit));
    return requestJson(`/api/media/library?${params.toString()}`, {
      dedupe: false,
      signal,
      timeout: options.mode === 'home' ? 35_000 : 24_000,
    });
  },
  mediaDetail: (sessionId, id, signal) => requestJson(`/api/media/detail?session=${encodeURIComponent(sessionId)}&id=${encodeURIComponent(id)}`, {
    dedupe: false,
    signal,
    timeout: 35_000,
  }),
  mediaPlayback: (sessionId, id, signal) => requestJson(`/api/media/playback?session=${encodeURIComponent(sessionId)}&id=${encodeURIComponent(id)}`, {
    dedupe: false,
    signal,
    timeout: 24_000,
  }),
  mediaProgress: payload => requestJson('/api/media/progress', {
    method: 'POST',
    body: JSON.stringify(payload),
    dedupe: false,
    timeout: 10_000,
  }),
  clear() {
    memoryCache.clear();
    try {
      Object.keys(sessionStorage)
        .filter(key => key.startsWith(CACHE_PREFIX))
        .forEach(key => sessionStorage.removeItem(key));
    } catch {}
  },
};
