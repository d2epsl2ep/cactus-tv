let activeSession = null;
let hlsLoaderPromise = null;
let dashLoaderPromise = null;
let playbackGeneration = 0;
let subtitleUrls = [];
const preconnectedOrigins = new Set();

function emit(video, name, detail = {}) {
  video.dispatchEvent(new CustomEvent(`cactus:${name}`, { detail }));
}

function loadScript(src, ready, failureMessage) {
  if (ready()) return Promise.resolve(ready());
  return new Promise((resolve, reject) => {
    const existing = document.querySelector(`script[data-cactus-src="${src}"]`);
    if (existing) {
      existing.addEventListener('load', () => ready() ? resolve(ready()) : reject(new Error(failureMessage)), { once: true });
      existing.addEventListener('error', () => reject(new Error(failureMessage)), { once: true });
      return;
    }
    const script = document.createElement('script');
    script.src = src;
    script.async = true;
    script.dataset.cactusSrc = src;
    script.onload = () => ready() ? resolve(ready()) : reject(new Error(failureMessage));
    script.onerror = () => reject(new Error(failureMessage));
    document.head.appendChild(script);
  });
}

async function loadHls() {
  if (window.Hls) return window.Hls;
  if (!hlsLoaderPromise) {
    hlsLoaderPromise = loadScript('/vendor/hls.min.js?v=1.6.13', () => window.Hls, 'HLS 播放组件加载失败')
      .catch(error => { hlsLoaderPromise = null; throw error; });
  }
  return hlsLoaderPromise;
}

async function loadDash() {
  if (window.dashjs) return window.dashjs;
  if (!dashLoaderPromise) {
    dashLoaderPromise = loadScript('/vendor/dash.all.min.js?v=5.2.0', () => window.dashjs, 'DASH 播放组件加载失败')
      .catch(error => { dashLoaderPromise = null; throw error; });
  }
  return dashLoaderPromise;
}

function preloadPlayerEngine() {
  return loadHls().catch(() => null);
}

async function safePlay(video) {
  try {
    await video.play();
    return true;
  } catch (error) {
    if (error?.name === 'NotAllowedError' || error?.name === 'AbortError') return false;
    throw error;
  }
}

function decodedTarget(url) {
  try {
    const parsed = new URL(url, location.href);
    return parsed.searchParams.get('url') || decodeURIComponent(url);
  } catch {
    try { return decodeURIComponent(url); }
    catch { return url; }
  }
}

function extensionKind(url) {
  const target = decodedTarget(url);
  if (/\.m3u8(?:$|[?#])/i.test(target)) return 'hls';
  if (/\.mpd(?:$|[?#])/i.test(target)) return 'dash';
  return '';
}

function isSameOriginProxy(url) {
  try {
    const parsed = new URL(url, location.href);
    return parsed.origin === location.origin && parsed.pathname === '/api/stream';
  } catch { return false; }
}

function preconnect(url) {
  try {
    const origin = new URL(decodedTarget(url), location.href).origin;
    if (!/^https?:/i.test(origin) || preconnectedOrigins.has(origin)) return;
    preconnectedOrigins.add(origin);
    const link = document.createElement('link');
    link.rel = 'preconnect';
    link.href = origin;
    link.crossOrigin = 'anonymous';
    document.head.appendChild(link);
  } catch {}
}

async function probeStreamKind(url, timeoutMs = 6000) {
  const known = extensionKind(url);
  if (known) return known;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    if (isSameOriginProxy(url)) {
      const probe = new URL(url, location.href);
      probe.searchParams.set('probe', '1');
      const response = await fetch(probe, {
        credentials: 'same-origin',
        cache: 'no-store',
        signal: controller.signal,
        headers: { Accept: 'application/json' },
      });
      if (!response.ok) return 'media';
      const payload = await response.json();
      return ['hls', 'dash', 'media'].includes(payload.kind) ? payload.kind : 'media';
    }

    // Some Apple CMS providers return an extensionless URL with a generic MIME type.
    // Probe only the first chunk; CORS failures safely fall back to native media playback.
    const response = await fetch(url, {
      credentials: 'omit',
      cache: 'no-store',
      referrerPolicy: 'no-referrer',
      signal: controller.signal,
      headers: {
        Accept: 'application/vnd.apple.mpegurl, application/dash+xml, video/*, audio/*, */*;q=0.5',
        Range: 'bytes=0-65535',
      },
    });
    if (!response.ok && response.status !== 206) return 'media';
    const contentType = (response.headers.get('content-type') || '').toLowerCase();
    if (contentType.includes('mpegurl')) { try { await response.body?.cancel(); } catch {} return 'hls'; }
    if (contentType.includes('dash+xml')) { try { await response.body?.cancel(); } catch {} return 'dash'; }
    const reader = response.body?.getReader();
    if (!reader) return 'media';
    const first = await reader.read();
    try { await reader.cancel(); } catch {}
    const sample = new TextDecoder('utf-8', { fatal: false }).decode(first.value || new Uint8Array()).trimStart();
    if (sample.startsWith('#EXTM3U')) return 'hls';
    if (/^<\?xml[\s\S]{0,500}<MPD\b|^<MPD\b/i.test(sample)) return 'dash';
    return 'media';
  } catch { return 'media'; }
  finally { clearTimeout(timer); }
}

async function preloadStream(url) {
  const value = String(url || '').trim();
  if (!value) return false;
  preconnect(value);
  if (navigator.connection?.saveData) return false;
  const kind = await probeStreamKind(value, 4500);
  if (kind === 'dash') loadDash().catch(() => null);
  if (kind !== 'hls' && kind !== 'dash') return false;
  try {
    const response = await fetch(value, {
      credentials: isSameOriginProxy(value) ? 'same-origin' : 'omit',
      cache: 'force-cache',
      priority: 'low',
      referrerPolicy: 'no-referrer',
      headers: { Accept: kind === 'hls' ? 'application/vnd.apple.mpegurl, application/x-mpegURL, */*;q=0.8' : 'application/dash+xml, application/xml, */*;q=0.8' },
    });
    if (!response.ok) return false;
    await response.text();
    return true;
  } catch { return false; }
}

function supportsNativeHls(video) {
  const userAgent = navigator.userAgent || '';
  const appleMobile = /iP(?:hone|ad|od)/i.test(userAgent)
    || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const safari = /Safari/i.test(userAgent)
    && !/(?:Chrome|Chromium|CriOS|FxiOS|Edg|OPR|Android)/i.test(userAgent);
  const canPlay = video.canPlayType('application/vnd.apple.mpegurl')
    || video.canPlayType('application/x-mpegURL');
  return Boolean(canPlay && (appleMobile || safari));
}

function mediaError(video, fallback) {
  const code = video.error?.code;
  const messages = { 1: '播放已中止', 2: '媒体网络请求失败', 3: '媒体解码失败', 4: '浏览器不支持该媒体格式' };
  return new Error(messages[code] || video.error?.message || fallback);
}

function clearSubtitleTracks(video) {
  if (!video) return;
  [...video.querySelectorAll('track')].forEach(track => track.remove());
  try { [...video.textTracks].forEach(track => { track.mode = 'disabled'; }); } catch {}
  subtitleUrls.forEach(URL.revokeObjectURL);
  subtitleUrls = [];
}

function cleanupSession(session, clearSource = true) {
  if (!session || session.cleaned) return;
  session.cleaned = true;
  session.timers.forEach(timer => { clearTimeout(timer); clearInterval(timer); });
  session.timers.clear();
  session.listeners.forEach(([target, name, listener, options]) => target.removeEventListener(name, listener, options));
  session.listeners.length = 0;
  try { session.hls?.destroy(); } catch {}
  try { session.dash?.reset(); } catch {}
  session.hls = null;
  session.dash = null;
  if (clearSource) {
    session.video.pause();
    session.video.removeAttribute('src');
    session.video.load();
  }
}

function createSession(video, url, resumeAt) {
  const generation = ++playbackGeneration;
  const session = {
    generation, video, url,
    resumeAt: Math.max(0, Number(resumeAt) || 0),
    hls: null, dash: null, engine: 'native',
    listeners: [], timers: new Set(), cleaned: false, failed: false,
    started: false, verified: false, stable: false, autoplayBlocked: false,
    recoveredPosition: false, ready: false, networkRecoveries: 0, mediaRecoveries: 0,
    stallSince: 0, stallRecoveries: 0, stallCount: 0, lastProgressAt: performance.now(),
    lastCurrentTime: 0, startedAt: performance.now(), firstFrameAt: 0, bandwidth: 0,
  };
  activeSession = session;
  return session;
}

function listen(session, target, name, listener, options) {
  target.addEventListener(name, listener, options);
  session.listeners.push([target, name, listener, options]);
}

function addTimer(session, callback, delay, repeat = false) {
  const wrapped = () => {
    if (!repeat) session.timers.delete(timer);
    if (!session.cleaned && session.generation === playbackGeneration) callback();
  };
  const timer = repeat ? setInterval(wrapped, delay) : setTimeout(wrapped, delay);
  session.timers.add(timer);
  return timer;
}

function applyResume(session) {
  const { video, resumeAt } = session;
  if (session.recoveredPosition || resumeAt <= 3 || !Number.isFinite(video.duration)) return;
  if (resumeAt < video.duration - 5) {
    try { video.currentTime = resumeAt; } catch {}
  }
  session.recoveredPosition = true;
}

function bufferAhead(video) {
  const current = Number(video.currentTime || 0);
  let end = current;
  try {
    for (let index = 0; index < video.buffered.length; index += 1) {
      if (video.buffered.start(index) <= current + 0.5) end = Math.max(end, video.buffered.end(index));
    }
  } catch {}
  return Math.max(0, end - current);
}

function diagnostics(session) {
  const { video } = session;
  let dropped = 0;
  let total = 0;
  try {
    const quality = video.getVideoPlaybackQuality?.();
    dropped = Number(quality?.droppedVideoFrames || video.webkitDroppedFrameCount || 0);
    total = Number(quality?.totalVideoFrames || video.webkitDecodedFrameCount || 0);
  } catch {}
  emit(video, 'diagnostics', {
    engine: session.engine,
    state: video.ended ? 'ended' : video.paused ? 'paused' : session.stallSince ? 'buffering' : 'playing',
    resolution: video.videoWidth && video.videoHeight ? `${video.videoWidth}×${video.videoHeight}` : '—',
    bandwidth: Math.round(Number(session.bandwidth || session.hls?.bandwidthEstimate || 0)),
    buffer: Number(bufferAhead(video).toFixed(1)),
    currentTime: Number((video.currentTime || 0).toFixed(1)),
    dropped, total,
    stalls: session.stallCount,
    startupMs: session.firstFrameAt ? Math.round(session.firstFrameAt - session.startedAt) : 0,
    urlHost: (() => { try { return new URL(decodedTarget(session.url), location.href).host; } catch { return ''; } })(),
  });
}

function failSession(session, error, recoverable = true) {
  if (session.cleaned || session.failed) return;
  session.failed = true;
  emit(session.video, 'error', { error: error instanceof Error ? error : new Error(String(error)), recoverable });
}

function recoverStall(session) {
  const { video } = session;
  session.stallRecoveries += 1;
  emit(video, 'state', { state: 'reconnecting', attempt: session.stallRecoveries });
  try {
    if (session.hls) {
      if (session.stallRecoveries === 1 && bufferAhead(video) > 0.4) video.currentTime = Math.min(video.duration || Infinity, video.currentTime + 0.12);
      session.hls.startLoad(Math.max(0, video.currentTime - 0.25));
    } else if (session.dash) {
      const position = video.currentTime || 0;
      session.dash.seek(position);
      session.dash.play();
    } else {
      const position = video.currentTime || 0;
      video.load();
      listen(session, video, 'loadedmetadata', () => { try { video.currentTime = position; safePlay(video); } catch {} }, { once: true });
    }
  } catch {}
}

function bindStallMonitor(session) {
  const { video } = session;
  const markProgress = () => {
    const now = performance.now();
    const current = Number(video.currentTime || 0);
    if (current > session.lastCurrentTime + 0.08) {
      session.lastProgressAt = now;
      session.lastCurrentTime = current;
      session.stallSince = 0;
      session.stallRecoveries = 0;
    }
  };
  const markStall = () => {
    if (!session.verified || video.paused || video.seeking) return;
    if (!session.stallSince) {
      session.stallSince = performance.now();
      session.stallCount += 1;
    }
  };
  listen(session, video, 'timeupdate', markProgress);
  listen(session, video, 'progress', markProgress);
  listen(session, video, 'playing', markProgress);
  listen(session, video, 'seeked', () => {
    session.lastCurrentTime = Number(video.currentTime || 0);
    session.lastProgressAt = performance.now();
    session.stallSince = 0;
    session.stallRecoveries = 0;
  });
  listen(session, video, 'waiting', markStall);
  listen(session, video, 'stalled', markStall);
  addTimer(session, () => {
    diagnostics(session);
    if (!session.verified || video.paused || video.ended || video.seeking || session.failed) return;
    const now = performance.now();
    const noProgress = now - session.lastProgressAt;
    const starving = bufferAhead(video) < 0.25;
    if (noProgress < 6500 || (!starving && !session.stallSince)) return;
    if (!session.stallSince) {
      session.stallSince = now;
      session.stallCount += 1;
      emit(video, 'state', { state: 'buffering' });
      return;
    }
    const stalledFor = now - session.stallSince;
    if (stalledFor > 6500 && session.stallRecoveries < 2) recoverStall(session);
    if (stalledFor > 15000) failSession(session, new Error('播放持续卡住，正在切换备用线路'));
  }, 2000, true);
}

function verifySession(session) {
  if (session.verified || session.cleaned) return;
  session.verified = true;
  session.firstFrameAt = performance.now();
  emit(session.video, 'verified', { startupMs: Math.round(session.firstFrameAt - session.startedAt), engine: session.engine });
  const verifiedAt = Number(session.video.currentTime || 0);
  const markStable = () => {
    if (session.stable || session.cleaned || session.failed || !session.verified) return;
    if (Number(session.video.currentTime || 0) < verifiedAt + 0.8) return;
    session.stable = true;
    emit(session.video, 'stable', { engine: session.engine });
  };
  listen(session, session.video, 'timeupdate', markStable);
  listen(session, session.video, 'playing', markStable);
  addTimer(session, markStable, 3500);
}

function waitForFirstFrame(session, timeoutMs) {
  const { video } = session;
  return new Promise((resolve, reject) => {
    let settled = false;
    let frameRequested = false;
    const finish = error => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (error) reject(error);
      else { verifySession(session); resolve(); }
    };
    const confirm = () => {
      if (session.cleaned) return finish(new DOMException('播放已取消', 'AbortError'));
      if (video.readyState < 2) return;
      if (!session.started && !session.autoplayBlocked && video.paused) return;
      if ('requestVideoFrameCallback' in video && !frameRequested && !session.autoplayBlocked) {
        frameRequested = true;
        video.requestVideoFrameCallback(() => finish());
        return;
      }
      finish();
    };
    listen(session, video, 'playing', () => { session.started = true; confirm(); });
    listen(session, video, 'loadeddata', confirm);
    listen(session, video, 'canplay', confirm);
    listen(session, video, 'timeupdate', confirm);
    listen(session, video, 'error', () => finish(mediaError(video, '媒体加载失败')), { once: true });
    const timeout = addTimer(session, () => finish(new Error('首帧加载超时')), timeoutMs);
    confirm();
  });
}

function bindMediaState(session) {
  const { video } = session;
  const state = value => emit(video, 'state', { state: value });
  listen(session, video, 'loadstart', () => state('loading'));
  listen(session, video, 'waiting', () => { if (!video.paused && !video.seeking) state('buffering'); });
  listen(session, video, 'stalled', () => { if (!video.paused) state('buffering'); });
  listen(session, video, 'seeking', () => state('buffering'));
  listen(session, video, 'playing', () => { session.started = true; state('playing'); });
  listen(session, video, 'canplay', () => state(video.paused ? 'ready' : 'playing'));
  listen(session, video, 'pause', () => { if (!video.ended && !video.error) state('paused'); });
  listen(session, video, 'ended', () => state('ended'));
  listen(session, video, 'loadedmetadata', () => { session.ready = true; applyResume(session); });
  listen(session, video, 'error', () => {
    if (!session.verified || session.hls || session.dash) return;
    failSession(session, mediaError(video, '媒体播放失败'));
  });
  bindStallMonitor(session);
}

async function playNative(session) {
  const { video, url } = session;
  session.engine = 'native';
  emit(video, 'engine', { engine: 'native' });
  emit(video, 'levels', { levels: [], currentLevel: -1, auto: true });
  emit(video, 'audioTracks', { tracks: [], current: -1 });
  emit(video, 'subtitleTracks', { tracks: [], current: -1 });
  video.src = url;
  video.load();
  session.autoplayBlocked = !(await safePlay(video));
  await waitForFirstFrame(session, 11000);
}

function deviceProfile() {
  const connection = navigator.connection || {};
  const slowNetwork = /(^|-)2g$|3g/i.test(connection.effectiveType || '')
    || (Number(connection.downlink || 10) < 2)
    || (Number(connection.rtt || 0) > 450);
  const constrained = Boolean(connection.saveData || slowNetwork
    || (navigator.deviceMemory && navigator.deviceMemory <= 4)
    || (navigator.hardwareConcurrency && navigator.hardwareConcurrency <= 4));
  const mobile = matchMedia('(max-width: 800px)').matches;
  return { constrained, mobile, slowNetwork, downlink: Number(connection.downlink || 0) };
}

function levelPayload(hls) {
  const levels = (hls.levels || []).map((level, index) => {
    const height = Number(level.height || 0);
    const bitrate = Number(level.bitrate || 0);
    return { index, height, bitrate, label: height ? `${height}p` : bitrate ? `${Math.round(bitrate / 1000)} kbps` : `清晰度 ${index + 1}` };
  });
  return { levels, currentLevel: Number(hls.currentLevel ?? -1), auto: hls.autoLevelEnabled !== false && hls.currentLevel === -1 };
}

function emitHlsTracks(session, Hls) {
  const hls = session.hls;
  const audio = (hls.audioTracks || []).map((track, index) => ({ index, label: track.name || track.lang || `音轨 ${index + 1}`, lang: track.lang || '' }));
  const subtitles = (hls.subtitleTracks || []).map((track, index) => ({ index, label: track.name || track.lang || `字幕 ${index + 1}`, lang: track.lang || '' }));
  emit(session.video, 'audioTracks', { tracks: audio, current: Number(hls.audioTrack ?? -1) });
  emit(session.video, 'subtitleTracks', { tracks: subtitles, current: Number(hls.subtitleTrack ?? -1) });
}

async function playWithHls(session) {
  const Hls = await loadHls();
  if (session.cleaned || session.generation !== playbackGeneration) throw new DOMException('播放已取消', 'AbortError');
  if (!Hls.isSupported()) throw new Error('当前浏览器不支持 HLS 播放');
  const { constrained, mobile, slowNetwork, downlink } = deviceProfile();
  const hls = new Hls({
    enableWorker: true, lowLatencyMode: false, capLevelToPlayerSize: true,
    startLevel: slowNetwork ? 0 : -1, startFragPrefetch: true, testBandwidth: true,
    abrEwmaDefaultEstimate: downlink ? Math.max(350000, downlink * 750000) : 1000000,
    abrBandWidthFactor: slowNetwork ? 0.75 : 0.85, abrBandWidthUpFactor: slowNetwork ? 0.55 : 0.7,
    maxStarvationDelay: slowNetwork ? 2 : 4, maxLoadingDelay: slowNetwork ? 2 : 4,
    backBufferLength: constrained ? 8 : 24,
    maxBufferLength: constrained ? 14 : mobile ? 24 : 38,
    maxMaxBufferLength: constrained ? 26 : mobile ? 46 : 70,
    maxBufferSize: constrained ? 18 * 1024 * 1024 : mobile ? 38 * 1024 * 1024 : 56 * 1024 * 1024,
    maxBufferHole: 0.5, highBufferWatchdogPeriod: 2, nudgeOffset: 0.1, nudgeMaxRetry: 5,
    manifestLoadingTimeOut: 9000, manifestLoadingMaxRetry: 2,
    levelLoadingTimeOut: 10000, levelLoadingMaxRetry: 3,
    fragLoadingTimeOut: 14000, fragLoadingMaxRetry: 3, appendErrorMaxRetry: 3,
  });
  session.hls = hls;
  session.engine = 'hls.js';
  emit(session.video, 'engine', { engine: 'hls.js' });

  await new Promise((resolve, reject) => {
    let settled = false;
    let manifestReady = false;
    const finish = error => {
      if (settled) return;
      settled = true;
      clearTimeout(startupTimer);
      error ? reject(error) : resolve();
    };
    const fatal = data => {
      const error = new Error(`播放失败：${data.details || data.type || '未知错误'}`);
      if (!session.verified) finish(error); else failSession(session, error, false);
    };
    const startupTimer = addTimer(session, () => finish(new Error(manifestReady ? '首个视频分片加载超时' : '播放列表加载超时')), 16000);
    hls.on(Hls.Events.MEDIA_ATTACHED, () => { if (!session.cleaned) hls.loadSource(session.url); });
    hls.on(Hls.Events.MANIFEST_PARSED, async () => {
      manifestReady = true;
      emit(session.video, 'levels', levelPayload(hls));
      emitHlsTracks(session, Hls);
      applyResume(session);
      try {
        session.autoplayBlocked = !(await safePlay(session.video));
        await waitForFirstFrame(session, 13000);
        finish();
      } catch (error) { finish(error); }
    });
    hls.on(Hls.Events.LEVEL_SWITCHED, (_event, data) => emit(session.video, 'quality', { currentLevel: Number(data.level ?? -1), auto: hls.autoLevelEnabled }));
    hls.on(Hls.Events.FRAG_LOADED, (_event, data) => {
      const loaded = Number(data?.stats?.loaded || 0);
      const durationMs = Math.max(1, Number(data?.stats?.loading?.end || 0) - Number(data?.stats?.loading?.start || 0));
      if (loaded) session.bandwidth = Math.round((loaded * 8 * 1000) / durationMs);
    });
    hls.on(Hls.Events.FRAG_BUFFERED, () => {
      session.networkRecoveries = 0; session.mediaRecoveries = 0;
      emit(session.video, 'state', { state: session.video.paused ? 'ready' : 'playing' });
    });
    hls.on(Hls.Events.AUDIO_TRACKS_UPDATED, () => emitHlsTracks(session, Hls));
    hls.on(Hls.Events.AUDIO_TRACK_SWITCHED, () => emitHlsTracks(session, Hls));
    hls.on(Hls.Events.SUBTITLE_TRACKS_UPDATED, () => emitHlsTracks(session, Hls));
    hls.on(Hls.Events.SUBTITLE_TRACK_SWITCH, () => emitHlsTracks(session, Hls));
    hls.on(Hls.Events.ERROR, (_event, data) => {
      if (!data.fatal || session.cleaned) return;
      if (data.type === Hls.ErrorTypes.NETWORK_ERROR && session.networkRecoveries < 3) {
        const attempt = ++session.networkRecoveries;
        emit(session.video, 'state', { state: 'reconnecting', attempt });
        addTimer(session, () => { try { hls.startLoad(Math.max(0, session.video.currentTime || -1)); } catch { fatal(data); } }, Math.min(500 * (2 ** (attempt - 1)), 2500));
        return;
      }
      if (data.type === Hls.ErrorTypes.MEDIA_ERROR && session.mediaRecoveries < 2) {
        const attempt = ++session.mediaRecoveries;
        emit(session.video, 'state', { state: 'recovering', attempt });
        try { if (attempt === 2) hls.swapAudioCodec(); hls.recoverMediaError(); return; } catch { fatal(data); return; }
      }
      fatal(data);
    });
    hls.attachMedia(session.video);
  });
}

function dashRequestMapper(sourceUrl) {
  try {
    const source = new URL(sourceUrl, location.href);
    if (source.origin !== location.origin || source.pathname !== '/api/stream') return null;
    const provider = source.searchParams.get('provider');
    const original = source.searchParams.get('url');
    if (!provider || !original) return null;
    const originalBase = new URL('.', original);
    return requestUrl => {
      try {
        const request = new URL(requestUrl, originalBase);
        if (request.origin === location.origin && request.pathname === '/api/stream') return request.toString();
        if (!/^https?:$/.test(request.protocol)) return requestUrl;
        return `/api/stream?provider=${encodeURIComponent(provider)}&url=${encodeURIComponent(request.toString())}`;
      } catch { return requestUrl; }
    };
  } catch { return null; }
}

async function playWithDash(session) {
  const dashjs = await loadDash();
  if (session.cleaned || session.generation !== playbackGeneration) throw new DOMException('播放已取消', 'AbortError');
  const player = dashjs.MediaPlayer().create();
  const mapDashRequest = dashRequestMapper(session.url);
  if (mapDashRequest && typeof player.addRequestInterceptor === 'function') {
    player.addRequestInterceptor(async request => ({ ...request, url: mapDashRequest(request.url) }));
  } else if (mapDashRequest && typeof player.extend === 'function') {
    // Compatibility with older dash.js versions.
    player.extend('RequestModifier', () => ({
      modifyRequestURL: mapDashRequest,
      modifyRequestHeader: xhr => xhr,
    }), true);
  }
  session.dash = player;
  session.engine = 'dash.js';
  emit(session.video, 'engine', { engine: 'dash.js' });
  const profile = deviceProfile();
  player.updateSettings({ streaming: {
    abr: { autoSwitchBitrate: { video: true, audio: true }, initialBitrate: { video: profile.slowNetwork ? 350 : -1 } },
    buffer: { bufferTimeAtTopQuality: profile.constrained ? 12 : 24, bufferTimeAtTopQualityLongForm: profile.constrained ? 18 : 36, bufferToKeep: profile.constrained ? 8 : 20 },
    retryAttempts: { MPD: 2, MediaSegment: 3, InitializationSegment: 3 },
  }});
  await new Promise((resolve, reject) => {
    let settled = false;
    const finish = error => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      error ? reject(error) : resolve();
    };
    const events = dashjs.MediaPlayer.events;
    player.on(events.STREAM_INITIALIZED, async () => {
      try {
        const levels = (player.getBitrateInfoListFor('video') || []).map((level, index) => ({ index, height: level.height || 0, bitrate: level.bitrate || 0, label: level.height ? `${level.height}p` : `${Math.round((level.bitrate || 0) / 1000)} kbps` }));
        emit(session.video, 'levels', { levels, currentLevel: -1, auto: true });
        const audio = (player.getTracksFor('audio') || []).map((track, index) => ({ index, label: track.labels?.[0]?.text || track.lang || `音轨 ${index + 1}`, lang: track.lang || '' }));
        const subtitles = (player.getTracksFor('text') || []).map((track, index) => ({ index, label: track.labels?.[0]?.text || track.lang || `字幕 ${index + 1}`, lang: track.lang || '' }));
        emit(session.video, 'audioTracks', { tracks: audio, current: -1 });
        emit(session.video, 'subtitleTracks', { tracks: subtitles, current: -1 });
        applyResume(session);
        session.autoplayBlocked = !(await safePlay(session.video));
        await waitForFirstFrame(session, 14000);
        finish();
      } catch (error) { finish(error); }
    });
    player.on(events.QUALITY_CHANGE_RENDERED, data => {
      if (data?.mediaType === 'video') emit(session.video, 'quality', { currentLevel: Number(data.newQuality ?? -1), auto: true });
    });
    player.on(events.ERROR, data => {
      const error = new Error(data?.error?.message || data?.event?.message || 'DASH 播放失败');
      if (!session.verified) finish(error); else failSession(session, error);
    });
    const timeout = addTimer(session, () => finish(new Error('DASH 首帧加载超时')), 17000);
    player.initialize(session.video, session.url, false);
  });
}

async function playStream(video, url, preferNativeHls = true, resumeAt = 0) {
  stopStream(video);
  const value = String(url || '').trim();
  if (!/^https?:\/\//i.test(value) && !value.startsWith('/api/stream?')) throw new Error('播放地址格式无效');
  preconnect(value);
  const session = createSession(video, value, resumeAt);
  video.preload = 'auto';
  bindMediaState(session);
  emit(video, 'state', { state: 'loading' });
  try {
    const kind = await probeStreamKind(value);
    if (session.cleaned) return;
    if (kind === 'dash') await playWithDash(session);
    else if (kind === 'hls') {
      if (preferNativeHls && supportsNativeHls(video)) {
        try { await playNative(session); }
        catch (error) {
          if (session.cleaned) return;
          session.listeners.splice(0).forEach(([target, name, listener, options]) => target.removeEventListener(name, listener, options));
          session.timers.forEach(timer => { clearTimeout(timer); clearInterval(timer); });
          session.timers.clear();
          video.pause(); video.removeAttribute('src'); video.load();
          session.failed = false; session.verified = false; session.started = false; session.ready = false;
          bindMediaState(session);
          emit(video, 'state', { state: 'loading', fallback: 'hls.js' });
          await playWithHls(session);
        }
      } else await playWithHls(session);
    } else await playNative(session);
    diagnostics(session);
  } catch (error) {
    if (!session.cleaned && session.generation === playbackGeneration) failSession(session, error);
    throw error;
  }
}

function setPlaybackQuality(level) {
  const session = activeSession;
  if (!session) return false;
  const value = Number(level);
  if (session.hls) {
    if (!Number.isInteger(value) || value < 0) { session.hls.currentLevel = -1; session.hls.nextLevel = -1; }
    else if (value < session.hls.levels.length) session.hls.nextLevel = value;
    else return false;
    emit(session.video, 'quality', { currentLevel: value < 0 ? -1 : value, auto: value < 0 });
    return true;
  }
  if (session.dash) {
    try {
      if (value < 0) session.dash.updateSettings({ streaming: { abr: { autoSwitchBitrate: { video: true } } } });
      else { session.dash.updateSettings({ streaming: { abr: { autoSwitchBitrate: { video: false } } } }); session.dash.setRepresentationForTypeByIndex('video', value, true); }
      emit(session.video, 'quality', { currentLevel: value, auto: value < 0 });
      return true;
    } catch { return false; }
  }
  return false;
}

function setPlaybackAudioTrack(index) {
  const session = activeSession;
  const value = Number(index);
  if (session?.hls && value >= 0 && value < session.hls.audioTracks.length) { session.hls.audioTrack = value; return true; }
  if (session?.dash) {
    try { const track = session.dash.getTracksFor('audio')?.[value]; if (track) { session.dash.setCurrentTrack(track); return true; } } catch {}
  }
  return false;
}

function setPlaybackSubtitleTrack(index) {
  const session = activeSession;
  const value = Number(index);
  if (session?.hls) { session.hls.subtitleTrack = Number.isInteger(value) ? value : -1; session.hls.subtitleDisplay = value >= 0; return true; }
  if (session?.dash) {
    try {
      if (value < 0) session.dash.enableText(false);
      else { const track = session.dash.getTracksFor('text')?.[value]; if (track) { session.dash.enableText(true); session.dash.setCurrentTrack(track); } }
      return true;
    } catch {}
  }
  return false;
}

function srtToVtt(text) {
  return `WEBVTT\n\n${text.replace(/^\uFEFF/, '').replace(/\r+/g, '').replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2')}`;
}

function decodeSubtitle(buffer) {
  const bytes = new Uint8Array(buffer);
  const attempts = [];
  if (bytes[0] === 0xff && bytes[1] === 0xfe) attempts.push('utf-16le');
  if (bytes[0] === 0xfe && bytes[1] === 0xff) attempts.push('utf-16be');
  attempts.push('utf-8', 'gb18030', 'big5');
  let best = '';
  let bestBad = Infinity;
  for (const encoding of attempts) {
    try {
      const text = new TextDecoder(encoding, { fatal: false }).decode(buffer);
      const bad = (text.match(/�/g) || []).length;
      if (bad < bestBad) { best = text; bestBad = bad; }
      if (!bad) break;
    } catch {}
  }
  return best;
}

async function remoteSubtitle(subtitle) {
  const format = String(subtitle.format || '').toLowerCase();
  if (!['vtt', 'srt', ''].includes(format)) throw new Error('当前仅支持 VTT 和 SRT 字幕');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 9000);
  try {
    const endpoint = new URL('/api/subtitle', location.origin);
    endpoint.searchParams.set('url', subtitle.url);
    const response = await fetch(endpoint, { credentials: 'same-origin', signal: controller.signal, cache: 'force-cache' });
    if (!response.ok) throw new Error(`字幕加载失败（${response.status}）`);
    const length = Number(response.headers.get('content-length') || 0);
    if (length > 5_000_000) throw new Error('远程字幕不能超过 5 MB');
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > 5_000_000) throw new Error('远程字幕不能超过 5 MB');
    let text = decodeSubtitle(buffer);
    if (format === 'srt' || /\.srt(?:$|\?)/i.test(subtitle.url) || !/^\s*WEBVTT/i.test(text)) text = srtToVtt(text);
    const url = URL.createObjectURL(new Blob([text], { type: 'text/vtt' }));
    subtitleUrls.push(url);
    return url;
  } catch (error) {
    if (error?.name === 'AbortError') throw new Error('字幕加载超时');
    throw error;
  } finally { clearTimeout(timer); }
}

async function loadSubtitle(video, subtitle) {
  clearSubtitleTracks(video);
  if (!subtitle) return;
  const track = document.createElement('track');
  track.kind = 'subtitles';
  track.label = subtitle.name || subtitle.lang || '字幕';
  track.srclang = subtitle.lang || 'zh';
  track.src = subtitle.localUrl || await remoteSubtitle(subtitle);
  track.default = true;
  video.appendChild(track);
  track.addEventListener('load', () => {
    [...video.textTracks].forEach(item => { item.mode = item === track.track ? 'showing' : 'disabled'; });
  }, { once: true });
}

async function localSubtitle(file) {
  if (!/\.(vtt|srt)$/i.test(file.name)) throw new Error('请选择 VTT 或 SRT 字幕文件');
  if (file.size > 5_000_000) throw new Error('字幕文件不能超过 5 MB');
  let text = decodeSubtitle(await file.arrayBuffer());
  if (/\.srt$/i.test(file.name)) text = srtToVtt(text);
  const url = URL.createObjectURL(new Blob([text], { type: 'text/vtt' }));
  subtitleUrls.push(url);
  return { name: file.name, lang: 'local', format: 'vtt', localUrl: url };
}

function stopStream(video) {
  playbackGeneration += 1;
  if (activeSession) cleanupSession(activeSession, true);
  activeSession = null;
  if (video && !video.paused) video.pause();
  clearSubtitleTracks(video);
}

export {
  clearSubtitleTracks,
  loadSubtitle,
  localSubtitle,
  playStream,
  preloadPlayerEngine,
  preloadStream,
  setPlaybackAudioTrack,
  setPlaybackQuality,
  setPlaybackSubtitleTrack,
  stopStream,
};
