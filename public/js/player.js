let activeSession = null;
let hlsLoaderPromise = null;
let dashLoaderPromise = null;
let playbackGeneration = 0;
let subtitleUrls = [];
const preconnectedOrigins = new Set();
const MPEG_TS_WRAP_SECONDS = (2 ** 33) / 90000;
const MAX_REASONABLE_VOD_DURATION = 12 * 60 * 60;
const MAX_REASONABLE_SEGMENT_DURATION = 10 * 60;
const SEEK_FRAME_TIMEOUT_MS = 9000;
const RECOVERY_FRAME_TIMEOUT_MS = 5200;

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


async function requestSessionWakeLock(session) {
  if (!session || session.cleaned || session.wakeLock || !('wakeLock' in navigator) || document.hidden) return;
  try {
    session.wakeLock = await navigator.wakeLock.request('screen');
    session.wakeLock.addEventListener?.('release', () => {
      if (session) session.wakeLock = null;
    }, { once: true });
  } catch {}
}

function releaseSessionWakeLock(session) {
  const lock = session?.wakeLock;
  if (!lock) return;
  session.wakeLock = null;
  try { lock.release(); } catch {}
}

function cleanupSession(session, clearSource = true) {
  if (!session || session.cleaned) return;
  session.cleaned = true;
  session.timers.forEach(timer => { clearTimeout(timer); clearInterval(timer); });
  session.timers.clear();
  session.listeners.forEach(([target, name, listener, options]) => target.removeEventListener(name, listener, options));
  session.listeners.length = 0;
  releaseSessionWakeLock(session);
  if (session.videoFrameCallbackId && typeof session.video?.cancelVideoFrameCallback === 'function') {
    try { session.video.cancelVideoFrameCallback(session.videoFrameCallbackId); } catch {}
    session.videoFrameCallbackId = 0;
  }
  try { session.hls?.destroy(); } catch {}
  try { session.dash?.reset(); } catch {}
  session.hls = null;
  session.dash = null;
  if (clearSource) {
    try { session.video.__cactusTrustedDuration = 0; } catch {}
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
    lastEmergencyDownshiftAt: 0, emergencyDownshifts: 0, bufferTarget: 0,
    cleanStreamMarked: 0, cleanStreamInterstitials: 0, cleanStreamSkipped: 0,
    lastCleanStreamSignature: '', adSkipTarget: 0, adSkipTimer: 0,
    wakeLock: null, offlineSince: 0, lastNetworkRecoveryAt: 0, bufferRampStage: 0, bufferPressureCount: 0,
    bandwidthSamples: [], peakBandwidth: 0, lastAggressivePromotionAt: 0, qualityRecoveryHoldUntil: 0,
    lastVideoFrameAt: performance.now(), lastVideoFrameMediaTime: 0, videoFrameSerial: 0,
    videoFrameCallbackId: 0, lastDecodedFrames: 0, lastVisualCheckMediaTime: 0,
    visualFreezeSince: 0, visualRecoveries: 0, lastVisualRecoveryAt: 0,
    seekGeneration: 0, seekStartedAt: 0, seekFrameSerial: 0, seekWasPlaying: false,
    requestedPosition: Math.max(0, Number(resumeAt) || 0),
    lastGoodPosition: 0, hasPresentedFrame: false,
    seekTarget: Math.max(0, Number(resumeAt) || 0),
    trustedDuration: 0, durationAnomalyReported: false, seekRecoveryPending: false,
    timelineSuspect: false, startupFragmentRecoveries: 0, lastPositionEmitAt: 0,
    resumeAfterSeek: false, levelDetails: null, hlsLoadingStopped: false, lastExplicitSeekAt: 0,
    networkRecoveryTimestamps: [], mediaRecoveryTimestamps: [], visualRecoveryTimestamps: [],
  };
  try { video.__cactusTrustedDuration = 0; } catch {}
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

function playbackError(message, code, position = 0, extra = {}) {
  const error = new Error(message);
  error.code = code;
  error.position = Math.max(0, Number(position) || 0);
  Object.assign(error, extra);
  return error;
}

function finiteDuration(value) {
  const duration = Number(value);
  return Number.isFinite(duration) && duration > 0 ? duration : 0;
}

function effectiveDuration(session) {
  const trusted = finiteDuration(session?.trustedDuration);
  if (trusted) return trusted;
  const raw = finiteDuration(session?.video?.duration);
  return raw && raw <= MAX_REASONABLE_VOD_DURATION ? raw : 0;
}

function isDurationAnomaly(session, rawDuration) {
  const raw = finiteDuration(rawDuration);
  const trusted = finiteDuration(session?.trustedDuration);
  if (!raw || !trusted) return false;
  const ptsWrapLike = raw > 20 * 60 * 60 && trusted < MAX_REASONABLE_VOD_DURATION
    && Math.abs(raw - MPEG_TS_WRAP_SECONDS) < 3 * 60 * 60;
  const hugeJump = raw > Math.max(MAX_REASONABLE_VOD_DURATION, trusted * 3)
    && raw - trusted > 4 * 60 * 60;
  return ptsWrapLike || hugeJump;
}

function robustPlaylistDuration(details) {
  const direct = finiteDuration(details?.totalduration);
  const fragments = Array.isArray(details?.fragments) ? details.fragments : [];
  const durations = fragments.map(fragment => finiteDuration(fragment?.duration)).filter(Boolean);
  if (!durations.length) return direct && direct <= MAX_REASONABLE_VOD_DURATION ? direct : 0;
  const sorted = [...durations].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)] || 0;
  const segmentCeiling = Math.max(30, Math.min(MAX_REASONABLE_SEGMENT_DURATION, median * 20 || MAX_REASONABLE_SEGMENT_DURATION));
  const sane = durations.filter(duration => duration <= segmentCeiling);
  if (sane.length < Math.max(2, Math.ceil(durations.length * 0.85))) return 0;
  const summed = sane.reduce((sum, duration) => sum + duration, 0);
  const starts = fragments
    .map(fragment => ({ start: Number(fragment?.start), duration: finiteDuration(fragment?.duration) }))
    .filter(fragment => Number.isFinite(fragment.start) && fragment.duration > 0);
  const span = starts.length
    ? Math.max(...starts.map(fragment => fragment.start + fragment.duration)) - Math.min(...starts.map(fragment => fragment.start))
    : 0;
  const saneSum = finiteDuration(summed);
  const saneSpan = finiteDuration(span);
  const spanUsable = saneSpan > 0 && saneSpan <= MAX_REASONABLE_VOD_DURATION
    && (!saneSum || Math.abs(saneSpan - saneSum) <= Math.max(20, saneSum * 0.12));
  // Some malformed playlists expose a fragment start offset near the MPEG-TS
  // wrap boundary. In that case the span is huge even though every EXTINF is
  // sane; prefer the sum instead of discarding the only trustworthy duration.
  const computed = spanUsable ? saneSpan : saneSum;
  if (!computed || computed > MAX_REASONABLE_VOD_DURATION) return 0;
  if (direct && direct <= MAX_REASONABLE_VOD_DURATION) {
    const disagreement = Math.abs(direct - computed);
    if (disagreement <= Math.max(12, computed * 0.08)) return computed;
  }
  return computed;
}

function setTrustedDuration(session, value, source = 'media') {
  const duration = finiteDuration(value);
  if (!duration || session.cleaned) return false;
  // Never publish impossible VOD durations. A malformed TS timestamp can expose
  // the 33-bit PTS wrap (~26.5h), and some feeds report even larger values.
  if (duration > MAX_REASONABLE_VOD_DURATION) {
    session.timelineSuspect = true;
    if (!session.durationAnomalyReported) {
      session.durationAnomalyReported = true;
      emit(session.video, 'durationAnomaly', {
        rawDuration: duration,
        trustedDuration: session.trustedDuration,
        position: clampPlaybackPosition(session, session.seekTarget || session.lastGoodPosition || session.video.currentTime || 0),
      });
    }
    return false;
  }
  const current = finiteDuration(session.trustedDuration);
  if (source === 'media' && session.engine === 'hls.js' && !current) return false;
  if (source !== 'playlist' && (isDurationAnomaly(session, duration)
    || (current && Math.abs(duration - current) > Math.max(20, current * 0.12)))) {
    session.timelineSuspect = true;
    if (!session.durationAnomalyReported) {
      session.durationAnomalyReported = true;
      const position = Math.min(
        finiteDuration(session.trustedDuration) || duration,
        Math.max(0, Number(session.seekTarget || session.lastGoodPosition || session.video.currentTime || 0)),
      );
      emit(session.video, 'durationAnomaly', { rawDuration: duration, trustedDuration: session.trustedDuration, position });
    }
    return false;
  }
  if (!current || source === 'playlist' || Math.abs(duration - current) <= Math.max(8, current * 0.08)) {
    session.trustedDuration = duration;
    try { session.video.__cactusTrustedDuration = duration; } catch {}
    emit(session.video, 'duration', { duration, source });
    return true;
  }
  return false;
}

function normalizePlaybackPosition(session, value, fallback = 0) {
  const duration = effectiveDuration(session);
  let position = Math.max(0, Number(value) || 0);
  if (duration > 2 && position > duration + 30 && position > MPEG_TS_WRAP_SECONDS - 3 * 60 * 60) {
    const unwrapped = position - MPEG_TS_WRAP_SECONDS;
    if (unwrapped >= 0 && unwrapped <= duration + 30) position = unwrapped;
  }
  if (!duration && position > MAX_REASONABLE_VOD_DURATION) {
    const unwrapped = position - MPEG_TS_WRAP_SECONDS;
    if (unwrapped >= 0 && unwrapped <= MAX_REASONABLE_VOD_DURATION) position = unwrapped;
    else return Math.max(0, Number(fallback) || 0);
  }
  return duration > 2 ? Math.min(position, Math.max(0, duration - 1.5)) : position;
}

function clampPlaybackPosition(session, value) {
  return normalizePlaybackPosition(session, value, session?.lastGoodPosition || session?.seekTarget || 0);
}

function recoveryPosition(session, fallback = 0) {
  const preferred = session?.hasPresentedFrame
    ? session.lastGoodPosition
    : session?.seekTarget || session?.requestedPosition || session?.resumeAt || fallback;
  return normalizePlaybackPosition(session, preferred, fallback);
}

function bufferedAt(video, target, padding = 0.2) {
  try {
    for (let index = 0; index < video.buffered.length; index += 1) {
      if (video.buffered.start(index) <= target + 0.08 && video.buffered.end(index) >= target + padding) return true;
    }
  } catch {}
  return false;
}

function seekStream(video, value, options = {}) {
  const session = activeSession;
  if (!session || session.video !== video || session.cleaned || session.failed) return false;
  const target = clampPlaybackPosition(session, value);
  const resume = options.resume ?? !video.paused;
  session.seekGeneration += 1;
  session.lastExplicitSeekAt = performance.now();
  session.seekStartedAt = session.lastExplicitSeekAt;
  session.seekFrameSerial = Number(session.videoFrameSerial || 0);
  session.requestedPosition = target;
  session.seekTarget = target;
  session.seekWasPlaying = Boolean(resume);
  session.resumeAfterSeek = Boolean(resume && video.paused);
  session.seekRecoveryPending = true;
  session.visualFreezeSince = 0;
  session.lastVisualCheckMediaTime = target;
  emit(video, 'seekTarget', { position: target });
  emit(video, 'state', { state: 'buffering', reason: 'seek' });
  try {
    if (session.hls) {
      video.currentTime = target;
      if (session.hlsLoadingStopped) {
        session.hlsLoadingStopped = false;
        session.hls.startLoad(Math.max(0, target - 0.15));
      }
    } else if (session.dash) session.dash.seek(target);
    else video.currentTime = target;
    return target;
  } catch {
    try { video.currentTime = target; } catch { return false; }
    return target;
  }
}

function applyResume(session) {
  const { video, resumeAt } = session;
  if (session.recoveredPosition || resumeAt <= 3) return;
  const duration = effectiveDuration(session);
  if (!duration) return;
  const target = clampPlaybackPosition(session, resumeAt);
  session.requestedPosition = target;
  session.seekTarget = target;
  try {
    if (Math.abs(Number(video.currentTime || 0) - target) > 0.35) video.currentTime = target;
    session.recoveredPosition = true;
  } catch {}
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
    bufferTarget: Number(session.bufferTarget || 0),
    currentTime: Number((video.currentTime || 0).toFixed(1)),
    dropped, total,
    stalls: session.stallCount,
    startupMs: session.firstFrameAt ? Math.round(session.firstFrameAt - session.startedAt) : 0,
    urlHost: (() => { try { return new URL(decodedTarget(session.url), location.href).host; } catch { return ''; } })(),
  });
}

function consumeRecoveryBudget(session, key, limit, windowMs) {
  const now = performance.now();
  const recent = (Array.isArray(session[key]) ? session[key] : []).filter(value => now - Number(value || 0) < windowMs);
  if (recent.length >= limit) { session[key] = recent; return false; }
  recent.push(now); session[key] = recent; return true;
}

function failSession(session, error, recoverable = true) {
  if (session.cleaned || session.failed) return;
  session.failed = true;
  emit(session.video, 'error', { error: error instanceof Error ? error : new Error(String(error)), recoverable });
}

function emergencyDownshift(session) {
  const hls = session.hls;
  if (!hls || !Array.isArray(hls.levels) || hls.levels.length < 2) return false;
  const now = performance.now();
  if (now - session.lastEmergencyDownshiftAt < 3500) return false;
  const current = Number.isInteger(hls.currentLevel) && hls.currentLevel >= 0
    ? hls.currentLevel
    : Number.isInteger(hls.nextLoadLevel) && hls.nextLoadLevel >= 0
      ? hls.nextLoadLevel
      : hls.levels.length - 1;
  const next = Math.max(0, current - 1);
  if (next >= current) return false;
  session.lastEmergencyDownshiftAt = now;
  session.qualityRecoveryHoldUntil = Math.max(Number(session.qualityRecoveryHoldUntil || 0), now + 12_000);
  session.emergencyDownshifts += 1;
  try {
    hls.nextAutoLevel = next;
    emit(session.video, 'qualityRecovery', { from: current, to: next, reason: 'buffer-starvation' });
    return true;
  } catch { return false; }
}

function presentedFrameCount(video) {
  try {
    const quality = video.getVideoPlaybackQuality?.();
    const total = Number(quality?.totalVideoFrames || video.webkitDecodedFrameCount || 0);
    return Number.isFinite(total) ? total : 0;
  } catch { return 0; }
}

function markPresentedFrame(session, mediaTime = session.video.currentTime) {
  if (!session || session.cleaned) return;
  const shown = normalizePlaybackPosition(session, mediaTime, session.lastGoodPosition || session.seekTarget || 0);
  session.lastVideoFrameAt = performance.now();
  session.lastVideoFrameMediaTime = shown;
  session.videoFrameSerial += 1;
  session.hasPresentedFrame = true;
  const nearSeekTarget = Math.abs(shown - Number(session.seekTarget || 0)) < 3.5;
  if (!session.video.seeking && (!session.seekRecoveryPending || nearSeekTarget)) {
    session.lastGoodPosition = shown;
    session.requestedPosition = shown;
    const now = performance.now();
    if (now - Number(session.lastPositionEmitAt || 0) >= 240) {
      session.lastPositionEmitAt = now;
      emit(session.video, 'position', { position: shown, confirmed: true });
    }
  }
  session.visualFreezeSince = 0;
  if (session.seekRecoveryPending && nearSeekTarget) session.seekRecoveryPending = false;
}

function bindVideoFrameMonitor(session) {
  const { video } = session;
  if (typeof video.requestVideoFrameCallback === 'function') {
    const requestNext = () => {
      if (session.cleaned || session.generation !== playbackGeneration) return;
      session.videoFrameCallbackId = video.requestVideoFrameCallback((_now, metadata) => {
        session.videoFrameCallbackId = 0;
        markPresentedFrame(session, metadata?.mediaTime);
        requestNext();
      });
    };
    requestNext();
  } else {
    session.lastDecodedFrames = presentedFrameCount(video);
    addTimer(session, () => {
      const total = presentedFrameCount(video);
      if (total > Number(session.lastDecodedFrames || 0)) markPresentedFrame(session, video.currentTime);
      session.lastDecodedFrames = total;
    }, 500, true);
  }
}

function recoverVisualFreeze(session, reason = 'video-frame-stalled', { resume = !session.video.paused } = {}) {
  if (!session || !session.verified || session.cleaned || session.failed || session.video.seeking || document.hidden || !navigator.onLine) return false;
  if (!resume || session.video.paused) return false;
  const now = performance.now();
  if (now - Number(session.lastVisualRecoveryAt || 0) < 4500) return false;
  if (!consumeRecoveryBudget(session, 'visualRecoveryTimestamps', 2, 90_000)) return false;
  const { video } = session;
  const position = recoveryPosition(session, video.currentTime || 0);
  const frameSerial = Number(session.videoFrameSerial || 0);
  session.lastVisualRecoveryAt = now;
  session.visualFreezeSince = now;
  session.visualRecoveries += 1;
  session.qualityRecoveryHoldUntil = Math.max(Number(session.qualityRecoveryHoldUntil || 0), now + 20_000);
  emit(video, 'state', { state: 'recovering', attempt: session.visualRecoveries, reason });
  emit(video, 'visualRecovery', { attempt: session.visualRecoveries, reason, position });
  try {
    if (session.hls) {
      emergencyDownshift(session);
      if (session.hlsLoadingStopped) { session.hlsLoadingStopped = false; session.hls.startLoad(Math.max(0, position - 0.15)); }
      video.currentTime = bufferedAt(video, position, 0.1)
        ? Math.min(effectiveDuration(session) || Infinity, position + 0.04)
        : Math.max(0, position - 0.08);
    } else if (session.dash) session.dash.seek(position);
    else video.currentTime = position;
    safePlay(video).catch(() => {});
  } catch {}
  addTimer(session, () => {
    if (session.cleaned || session.failed || video.seeking || video.paused) return;
    const frameRecovered = Number(session.videoFrameSerial || 0) > frameSerial
      && Math.abs(Number(session.lastVideoFrameMediaTime || 0) - Number(video.currentTime || position)) < 4;
    if (frameRecovered) { session.visualFreezeSince = 0; emit(video, 'state', { state: 'playing', reason: 'video-frame-recovered' }); return; }
    failSession(session, playbackError('画面未恢复，正在重建当前播放线路', 'VIDEO_FRAME_FROZEN', recoveryPosition(session, position)));
  }, RECOVERY_FRAME_TIMEOUT_MS);
  return true;
}

function scheduleSeekFrameVerification(session) {
  const { video } = session;
  const generation = Number(session.seekGeneration || 0);
  const target = normalizePlaybackPosition(session, session.seekTarget || video.currentTime || 0, session.lastGoodPosition || 0);
  const frameSerial = Number(session.seekFrameSerial || session.videoFrameSerial || 0);
  const resume = Boolean(session.seekWasPlaying || session.resumeAfterSeek);
  if (!resume || video.paused) { session.seekRecoveryPending = false; return; }
  session.seekRecoveryPending = true;
  const timeout = bufferedAt(video, target, 0.25) ? 5200 : SEEK_FRAME_TIMEOUT_MS;
  addTimer(session, () => {
    if (session.cleaned || session.failed || video.seeking || generation !== session.seekGeneration) return;
    session.seekRecoveryPending = false;
    if (video.paused || !resume) return;
    const frameAdvanced = Number(session.videoFrameSerial || 0) > frameSerial;
    const frameNearTarget = Math.abs(Number(session.lastVideoFrameMediaTime || -9999) - Number(video.currentTime || target)) < 3.5;
    if (frameAdvanced && frameNearTarget) return;
    if (!recoverVisualFreeze(session, 'seek-frame-stalled', { resume: true })) {
      failSession(session, playbackError('拖动后视频画面未就绪，正在从目标位置重建', 'SEEK_FRAME_TIMEOUT', recoveryPosition(session, target), { resume: true }));
    }
  }, timeout);
}

function recoverStall(session) {
  const { video } = session;
  if (document.hidden || !navigator.onLine || session.cleaned || session.failed || session.seekRecoveryPending || video.paused) return;
  session.stallRecoveries += 1;
  emit(video, 'state', { state: 'reconnecting', attempt: session.stallRecoveries });
  const position = recoveryPosition(session, video.currentTime || 0);
  try {
    if (session.hls) {
      emergencyDownshift(session);
      if (session.stallRecoveries === 1 && bufferAhead(video) > 0.35) video.currentTime = Math.min(effectiveDuration(session) || Infinity, position + 0.06);
      else if (session.stallRecoveries === 2) {
        if (session.hlsLoadingStopped) { session.hlsLoadingStopped = false; session.hls.startLoad(Math.max(0, position - 0.15)); }
        video.currentTime = Math.max(0, position - 0.08);
      } else if (consumeRecoveryBudget(session, 'mediaRecoveryTimestamps', 1, 90_000)) session.hls.recoverMediaError();
      safePlay(video).catch(() => {});
    } else if (session.dash) { session.dash.seek(position); session.dash.play(); }
    else {
      video.load();
      listen(session, video, 'loadedmetadata', () => { try { video.currentTime = position; safePlay(video); } catch {} }, { once: true });
    }
  } catch {}
}

function bindStallMonitor(session) {
  const { video } = session;
  const markProgress = () => {
    const now = performance.now();
    const current = normalizePlaybackPosition(session, video.currentTime || 0, session.lastCurrentTime || 0);
    if (current > session.lastCurrentTime + 0.08) {
      session.lastProgressAt = now;
      session.lastCurrentTime = current;
      session.stallSince = 0;
      session.stallRecoveries = 0;
    }
  };
  const markStall = () => {
    if (!session.verified || video.paused || video.seeking || document.hidden || !navigator.onLine) return;
    if (!session.stallSince) {
      session.stallSince = performance.now();
      session.stallCount += 1;
    }
  };
  listen(session, video, 'timeupdate', markProgress);
  listen(session, video, 'progress', markProgress);
  listen(session, video, 'playing', markProgress);
  listen(session, video, 'seeked', () => {
    const target = clampPlaybackPosition(session, video.currentTime || session.seekTarget || 0);
    session.seekTarget = target;
    session.requestedPosition = target;
    session.lastCurrentTime = target;
    session.lastVisualCheckMediaTime = target;
    session.lastProgressAt = performance.now();
    session.stallSince = 0;
    session.stallRecoveries = 0;
    if (session.verified && (session.seekWasPlaying || session.resumeAfterSeek)) scheduleSeekFrameVerification(session);
  });
  listen(session, video, 'waiting', markStall);
  listen(session, video, 'stalled', markStall);
  addTimer(session, () => {
    diagnostics(session);
    if (!session.verified || video.paused || video.ended || video.seeking || session.seekRecoveryPending || session.failed || document.hidden || !navigator.onLine) return;
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
    if (stalledFor > 5000 && session.stallRecoveries < 3) recoverStall(session);
    if (stalledFor > 20000) {
      failSession(session, playbackError(
        '播放持续卡住，正在切换备用线路',
        'STALL_TIMEOUT',
        recoveryPosition(session, video.currentTime || 0),
      ));
    }
  }, 3000, true);

  // currentTime follows the audio clock. It may keep advancing even when the
  // video decoder is frozen on one frame, so the ordinary stall monitor cannot
  // detect this failure. Watch actual presented video frames separately.
  addTimer(session, () => {
    if (!session.verified || video.paused || video.ended || video.seeking || session.seekRecoveryPending || session.failed || document.hidden || !navigator.onLine) {
      session.lastVisualCheckMediaTime = Number(video.currentTime || 0);
      session.visualFreezeSince = 0;
      return;
    }
    if (video.readyState < 2 || !video.videoWidth || !video.videoHeight) return;
    const now = performance.now();
    const current = Number(video.currentTime || 0);
    const mediaAdvanced = current > Number(session.lastVisualCheckMediaTime || 0) + 0.22;
    const frameAge = now - Number(session.lastVideoFrameAt || now);
    session.lastVisualCheckMediaTime = current;
    if (!mediaAdvanced || frameAge < 1800) {
      if (frameAge < 900) session.visualFreezeSince = 0;
      return;
    }
    if (!session.visualFreezeSince) {
      session.visualFreezeSince = now;
      emit(video, 'state', { state: 'recovering', reason: 'video-frame-stalled' });
      return;
    }
    if (now - session.visualFreezeSince >= 900) recoverVisualFreeze(session, 'video-frame-stalled');
  }, 1000, true);
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
  const resumeAfterNetwork = () => {
    if (session.cleaned || session.failed || !navigator.onLine) return;
    session.offlineSince = 0; session.lastProgressAt = performance.now(); session.stallSince = 0;
    emit(video, 'state', { state: 'reconnecting', reason: 'online' });
    const position = recoveryPosition(session, video.currentTime || 0);
    try {
      if (session.hls) { session.hlsLoadingStopped = false; session.hls.startLoad(Math.max(0, position - 0.15)); video.currentTime = position; }
      else if (session.dash) session.dash.seek(position);
      else video.load();
      safePlay(video).catch(() => {});
    } catch {}
  };
  listen(session, video, 'loadstart', () => state('loading'));
  listen(session, video, 'waiting', () => { if (!video.paused && !video.seeking && navigator.onLine && !document.hidden) state('buffering'); });
  listen(session, video, 'stalled', () => { if (!video.paused && navigator.onLine && !document.hidden) state('buffering'); });
  listen(session, video, 'seeking', () => {
    const explicit = performance.now() - Number(session.lastExplicitSeekAt || 0) < 350;
    if (!explicit) { session.seekGeneration += 1; session.seekFrameSerial = Number(session.videoFrameSerial || 0); session.seekWasPlaying = !video.paused; }
    session.seekStartedAt = performance.now();
    session.seekTarget = normalizePlaybackPosition(session, video.currentTime || session.requestedPosition || 0, session.lastGoodPosition || 0);
    session.requestedPosition = session.seekTarget;
    session.seekRecoveryPending = true; session.visualFreezeSince = 0; session.lastVisualCheckMediaTime = session.seekTarget;
    state('buffering');
  });
  listen(session, video, 'seeked', () => { if (session.resumeAfterSeek) { session.resumeAfterSeek = false; safePlay(video).catch(() => {}); } });
  listen(session, video, 'playing', () => { session.started = true; requestSessionWakeLock(session); state('playing'); });
  listen(session, video, 'canplay', () => state(video.paused ? 'ready' : 'playing'));
  listen(session, video, 'pause', () => { releaseSessionWakeLock(session); if (!video.ended && !video.error) state('paused'); });
  listen(session, video, 'ended', () => { releaseSessionWakeLock(session); state('ended'); });
  listen(session, video, 'loadedmetadata', () => { session.ready = true; setTrustedDuration(session, video.duration, 'media'); applyResume(session); });
  listen(session, video, 'durationchange', () => setTrustedDuration(session, video.duration, 'media'));
  listen(session, video, 'error', () => { if (!session.verified || session.hls || session.dash) return; failSession(session, mediaError(video, '媒体播放失败')); });
  listen(session, window, 'offline', () => { session.offlineSince = performance.now(); session.stallSince = 0; emit(video, 'state', { state: 'reconnecting', reason: 'offline' }); });
  listen(session, window, 'online', resumeAfterNetwork);
  listen(session, document, 'visibilitychange', () => {
    if (document.hidden) { session.stallSince = 0; session.lastProgressAt = performance.now(); releaseSessionWakeLock(session); return; }
    if (!video.paused && !video.ended) { requestSessionWakeLock(session); if (session.offlineSince && navigator.onLine) resumeAfterNetwork(); else safePlay(video).catch(() => {}); }
  });
  bindVideoFrameMonitor(session); bindStallMonitor(session);
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
  const downlink = Number(connection.downlink || 0);
  const memory = Number(navigator.deviceMemory || 8);
  const cores = Number(navigator.hardwareConcurrency || 8);
  const slowNetwork = /(^|-)2g$|3g/i.test(connection.effectiveType || '') || (downlink > 0 && downlink < 1.5) || Number(connection.rtt || 0) > 550;
  const lowMemory = memory <= 2; const lowCpu = cores <= 2;
  const constrained = Boolean(connection.saveData || /(^|-)2g$/i.test(connection.effectiveType || '') || (lowMemory && lowCpu));
  const mobile = matchMedia('(max-width: 900px)').matches || matchMedia('(pointer: coarse)').matches;
  const targetBuffer = constrained ? 18 : mobile ? 30 : 45;
  const memorySafeBuffer = constrained ? 12 : mobile ? 20 : 30;
  const maxBuffer = constrained ? 36 : mobile ? 60 : 90;
  const backBuffer = constrained ? 8 : mobile ? 15 : 25;
  const maxBufferBytes = (constrained ? 64 : mobile ? (memory >= 6 ? 112 : 80) : 160) * 1024 * 1024;
  const bufferByteFloor = (constrained ? 40 : mobile ? 64 : 96) * 1024 * 1024;
  return { constrained, mobile, slowNetwork, downlink, lowMemory, lowCpu, memory, cores, targetBuffer, memorySafeBuffer, maxBuffer, backBuffer, maxBufferBytes, bufferByteFloor };
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

function percentile(values, ratio = 0.75) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.floor((sorted.length - 1) * ratio)));
  return Number(sorted[index] || 0);
}

function recordActiveThroughput(session, _hls, data) {
  const loaded = Number(data?.stats?.loaded || 0); const loading = data?.stats?.loading || {};
  const durationMs = Math.max(1, Number(loading.end || 0) - Number(loading.first || loading.start || 0));
  if (!loaded || !Number.isFinite(durationMs)) return;
  const sample = Math.round((loaded * 8 * 1000) / durationMs);
  if (!Number.isFinite(sample) || sample <= 0) return;
  session.bandwidthSamples.push(sample);
  if (session.bandwidthSamples.length > 12) session.bandwidthSamples.splice(0, session.bandwidthSamples.length - 12);
  session.peakBandwidth = Math.max(Number(session.peakBandwidth || 0), sample);
  session.bandwidth = session.bandwidth ? Math.round(session.bandwidth * 0.55 + sample * 0.45) : sample;
}


function networkHeader(networkDetails, name) {
  if (networkDetails?.headers?.get) return networkDetails.headers.get(name);
  if (typeof networkDetails?.getResponseHeader === 'function') return networkDetails.getResponseHeader(name);
  return null;
}

function reportCleanStream(session, networkDetails) {
  try {
    const mode = String(networkHeader(networkDetails, 'x-cactus-cleanstream') || '').toUpperCase();
    if (!mode) return;
    const marked = Math.max(0, Number(networkHeader(networkDetails, 'x-cactus-cleanstream-marked') || 0) || 0);
    const interstitials = Math.max(0, Number(networkHeader(networkDetails, 'x-cactus-cleanstream-interstitials') || 0) || 0);
    const reason = String(networkHeader(networkDetails, 'x-cactus-cleanstream-reason') || '');
    session.cleanStreamMarked = Math.max(session.cleanStreamMarked, marked);
    session.cleanStreamInterstitials = Math.max(session.cleanStreamInterstitials, interstitials);
    const signature = `${mode}:${marked}:${interstitials}:${reason}`;
    if (signature === session.lastCleanStreamSignature) return;
    session.lastCleanStreamSignature = signature;
    emit(session.video, 'cleanstream', { mode, marked, interstitials, reason });
  } catch {}
}

function markedAdMeta(fragment) {
  const raw = String(fragment?.url || fragment?.relurl || '');
  if (!raw) return null;
  try {
    const url = new URL(raw, location.href);
    if (url.searchParams.get('cactus_ad') !== '1') return null;
    return {
      group: String(url.searchParams.get('cactus_ad_group') || ''),
      reason: String(url.searchParams.get('cactus_ad_reason') || 'marker'),
    };
  } catch { return null; }
}

function adClusterForFragment(session, hls, fragment) {
  const meta = markedAdMeta(fragment);
  if (!meta) return null;
  const levelDetails = hls.levels?.[Number(fragment?.level)]?.details || session.levelDetails;
  const fragments = Array.isArray(levelDetails?.fragments) ? levelDetails.fragments : [];
  let index = fragments.findIndex(item => Number(item?.sn) === Number(fragment?.sn));
  if (index < 0) index = fragments.findIndex(item => String(item?.url || item?.relurl || '') === String(fragment?.url || fragment?.relurl || ''));
  if (index < 0) {
    const start = Number(fragment?.start || 0);
    const duration = Number(fragment?.duration || 0);
    return duration > 0 ? { start, end: start + duration, count: 1, reason: meta.reason } : null;
  }
  let count = 0;
  let start = Number(fragments[index]?.start || fragment?.start || 0);
  let end = start;
  for (let cursor = index; cursor < fragments.length; cursor += 1) {
    const item = fragments[cursor];
    const itemMeta = markedAdMeta(item);
    if (!itemMeta || (meta.group && itemMeta.group && itemMeta.group !== meta.group)) break;
    const itemStart = Number(item?.start || end);
    const itemDuration = Number(item?.duration || 0);
    if (!Number.isFinite(itemDuration) || itemDuration <= 0) break;
    end = Math.max(end, itemStart + itemDuration);
    count += 1;
  }
  return count && end > start ? { start, end, count, reason: meta.reason } : null;
}

function skipMarkedAd(session, hls, fragment, phase = 'loading') {
  if (session.cleaned || fragment?.type && fragment.type !== 'main') return false;
  const cluster = adClusterForFragment(session, hls, fragment);
  if (!cluster) return false;
  const duration = cluster.end - cluster.start;
  // Conservative upper bound: a match spanning most of a movie is almost
  // certainly a bad rule, not an advertisement.
  if (!Number.isFinite(duration) || duration < 0.2 || duration > 360) return false;
  const target = normalizePlaybackPosition(session, cluster.end + 0.04, cluster.end);
  const current = Number(session.video.currentTime || 0);
  if (current >= target - 0.18 || Math.abs(Number(session.adSkipTarget || 0) - target) < 0.18) return false;
  session.adSkipTarget = target;
  session.cleanStreamSkipped += cluster.count;
  session.requestedPosition = target;
  session.seekTarget = target;
  session.lastExplicitSeekAt = performance.now();
  emit(session.video, 'adskip', {
    from: cluster.start,
    to: target,
    duration,
    segments: cluster.count,
    reason: cluster.reason,
    phase,
  });
  try {
    hls.stopLoad();
    session.hlsLoadingStopped = true;
    if (session.video.readyState > 0) session.video.currentTime = target;
    hls.startLoad(target);
    session.hlsLoadingStopped = false;
    safePlay(session.video).catch(() => {});
  } catch { return false; }
  if (session.adSkipTimer) {
    clearTimeout(session.adSkipTimer);
    session.timers.delete(session.adSkipTimer);
  }
  session.adSkipTimer = addTimer(session, () => {
    session.adSkipTarget = 0;
    session.adSkipTimer = 0;
  }, 5000);
  return true;
}

async function playWithHls(session) {
  const Hls = await loadHls();
  if (session.cleaned || session.generation !== playbackGeneration) throw new DOMException('播放已取消', 'AbortError');
  if (!Hls.isSupported()) throw new Error('当前浏览器不支持 HLS 播放');
  const profile = deviceProfile();
  const { constrained, mobile, slowNetwork, downlink } = profile;
  const proxied = isSameOriginProxy(session.url);
  const reportedEstimate = downlink > 0 ? downlink * 1_000_000 : 0;
  const defaultEstimate = constrained
    ? Math.max(1_000_000, Math.min(3_500_000, reportedEstimate || 1_500_000))
    : mobile
      ? Math.max(2_000_000, Math.min(16_000_000, reportedEstimate || 5_000_000))
      : Math.max(3_000_000, Math.min(30_000_000, reportedEstimate || 8_000_000));
  session.bufferTarget = profile.targetBuffer;
  const hls = new Hls({
    enableWorker: true,
    autoStartLoad: false,
    lowLatencyMode: false,
    capLevelToPlayerSize: true,
    capLevelOnFPSDrop: true,
    fpsDroppedMonitoringPeriod: 5000,
    fpsDroppedMonitoringThreshold: 0.28,
    startLevel: slowNetwork ? 0 : -1,
    startPosition: -1,
    startFragPrefetch: false,
    testBandwidth: true,
    abrEwmaDefaultEstimate: defaultEstimate,
    abrEwmaFastVoD: slowNetwork ? 3 : 2,
    abrEwmaSlowVoD: slowNetwork ? 9 : 5,
    abrMaxWithRealBitrate: true,
    abrBandWidthFactor: slowNetwork ? 0.72 : 0.88,
    abrBandWidthUpFactor: slowNetwork ? 0.60 : 0.72,
    maxStarvationDelay: slowNetwork ? 2 : 4,
    maxLoadingDelay: slowNetwork ? 4 : 8,
    // Keep the full local buffer target active immediately.
    backBufferLength: profile.backBuffer,
    maxBufferLength: profile.targetBuffer,
    maxMaxBufferLength: profile.maxBuffer,
    maxBufferSize: profile.maxBufferBytes,
    maxBufferHole: 0.3,
    maxFragLookUpTolerance: 0.2,
    progressive: false,
    enableSoftwareAES: true,
    highBufferWatchdogPeriod: 2,
    nudgeOffset: 0.08,
    nudgeMaxRetry: 3,
    manifestLoadingTimeOut: 10000,
    manifestLoadingMaxRetry: 2,
    manifestLoadingRetryDelay: 500,
    levelLoadingTimeOut: 12000,
    levelLoadingMaxRetry: 3,
    levelLoadingRetryDelay: 500,
    fragLoadingTimeOut: proxied ? 20000 : 26000,
    fragLoadingMaxRetry: proxied ? 2 : 3,
    fragLoadingRetryDelay: 600,
    fragLoadingMaxRetryTimeout: 5000,
    appendErrorMaxRetry: 2,
  });
  session.hls = hls;
  session.hlsLoadingStopped = true;
  session.engine = 'hls.js';
  emit(session.video, 'engine', { engine: 'hls.js' });

  await new Promise((resolve, reject) => {
    let settled = false;
    let manifestReady = false;
    let startupTimer = 0;
    const finish = error => {
      if (settled) return;
      settled = true;
      if (startupTimer) {
        clearTimeout(startupTimer);
        session.timers.delete(startupTimer);
        startupTimer = 0;
      }
      error ? reject(error) : resolve();
    };
    const fatal = data => {
      const position = clampPlaybackPosition(
        session,
        recoveryPosition(session, session.video.currentTime || 0),
      );
      const error = playbackError(
        `播放失败：${data.details || data.type || '未知错误'}`,
        'HLS_FATAL',
        position,
        { hlsType: data?.type || '', hlsDetails: data?.details || '' },
      );
      if (!session.verified) finish(error); else failSession(session, error, false);
    };
    const fallbackFromFragments = (failedFrag, attempt) => {
      const requested = normalizePlaybackPosition(session, session.requestedPosition || session.resumeAt || 0, 0);
      const fragments = Array.isArray(session.levelDetails?.fragments) ? session.levelDetails.fragments : [];
      if (!fragments.length) return Math.max(0, requested - (attempt === 1 ? 12 : 30));
      const failedStart = Number(failedFrag?.start); const pivot = Number.isFinite(failedStart) ? failedStart : requested;
      let index = fragments.findIndex(fragment => pivot >= Number(fragment.start || 0) && pivot < Number(fragment.start || 0) + Number(fragment.duration || 0) + 0.05);
      if (index < 0) index = fragments.findIndex(fragment => Number(fragment.start || 0) >= pivot);
      if (index < 0) index = fragments.length - 1;
      return normalizePlaybackPosition(session, Number(fragments[Math.max(0, index - attempt)]?.start || 0) + 0.05, 0);
    };
    const retryStartupFragment = (reason = 'timeout', data = null) => {
      if (!manifestReady || session.startupFragmentRecoveries >= 2) return false;
      const requested = normalizePlaybackPosition(session, session.requestedPosition || session.resumeAt || 0, 0);
      if (requested <= 3 && session.startupFragmentRecoveries >= 1) return false;
      const attempt = ++session.startupFragmentRecoveries;
      const fallback = fallbackFromFragments(data?.frag, attempt);
      session.requestedPosition = fallback; session.seekTarget = fallback;
      emit(session.video, 'state', { state: 'recovering', attempt, reason: `startup-fragment-${reason}` });
      emit(session.video, 'startupRecovery', { attempt, requested, position: fallback, reason });
      try {
        hls.stopLoad(); session.hlsLoadingStopped = true;
        if (session.video.readyState > 0) session.video.currentTime = fallback;
        hls.startLoad(fallback > 0 ? fallback : -1); session.hlsLoadingStopped = false;
        safePlay(session.video).catch(() => {}); return true;
      } catch { return false; }
    };
    const armStartupTimer = delay => {
      if (startupTimer) {
        clearTimeout(startupTimer);
        session.timers.delete(startupTimer);
      }
      startupTimer = addTimer(session, () => {
        if (session.verified) { finish(); return; }
        if (manifestReady && retryStartupFragment('timeout')) {
          armStartupTimer(proxied ? 15000 : 18000);
          return;
        }
        finish(playbackError(
          manifestReady ? '首个视频分片加载超时' : '播放列表加载超时',
          manifestReady ? 'STARTUP_FRAGMENT_TIMEOUT' : 'MANIFEST_TIMEOUT',
          session.requestedPosition || session.resumeAt,
        ));
      }, delay);
    };
    armStartupTimer(proxied ? 25000 : 32000);
    hls.on(Hls.Events.MEDIA_ATTACHED, () => { if (!session.cleaned) hls.loadSource(session.url); });
    hls.on(Hls.Events.MANIFEST_LOADED, (_event, data) => {
      reportCleanStream(session, data?.networkDetails);
    });
    hls.on(Hls.Events.LEVEL_LOADED, (_event, data) => {
      reportCleanStream(session, data?.networkDetails);
      const details = data?.details;
      session.levelDetails = details || null;
      const duration = robustPlaylistDuration(details);
      if (!details?.live && duration > 0) {
        setTrustedDuration(session, duration, 'playlist');
        session.resumeAt = normalizePlaybackPosition(session, session.resumeAt, 0);
        session.requestedPosition = normalizePlaybackPosition(session, session.requestedPosition, session.resumeAt);
        session.seekTarget = session.requestedPosition;
        applyResume(session);
      }
      else if (!details?.live && finiteDuration(details?.totalduration) > MAX_REASONABLE_VOD_DURATION) {
        setTrustedDuration(session, details.totalduration, 'playlist');
      }
    });
    hls.on(Hls.Events.MANIFEST_PARSED, async () => {
      manifestReady = true;
      emit(session.video, 'levels', levelPayload(hls));
      emitHlsTracks(session, Hls);
      try {
        const target = normalizePlaybackPosition(session, session.requestedPosition || session.resumeAt || 0);
        session.requestedPosition = target;
        session.seekTarget = target;
        hls.startLoad(target > 0 ? target : -1);
        session.hlsLoadingStopped = false;
        if (target > 0 && session.video.readyState > 0) session.video.currentTime = target;
        session.autoplayBlocked = !(await safePlay(session.video));
        await waitForFirstFrame(session, proxied ? 65000 : 75000);
        finish();
      } catch (error) { finish(error); }
    });
    hls.on(Hls.Events.LEVEL_SWITCHED, (_event, data) => emit(session.video, 'quality', { currentLevel: Number(data.level ?? -1), auto: hls.autoLevelEnabled }));
    hls.on(Hls.Events.FRAG_LOADING, (_event, data) => {
      skipMarkedAd(session, hls, data?.frag, 'loading');
    });
    hls.on(Hls.Events.FRAG_CHANGED, (_event, data) => {
      skipMarkedAd(session, hls, data?.frag, 'playing');
    });
    hls.on(Hls.Events.FRAG_LOADED, (_event, data) => {
      recordActiveThroughput(session, hls, data);
    });
    hls.on(Hls.Events.FRAG_BUFFERED, () => {
      emit(session.video, 'state', { state: session.video.paused ? 'ready' : 'playing' });
    });
    hls.on(Hls.Events.AUDIO_TRACKS_UPDATED, () => emitHlsTracks(session, Hls));
    hls.on(Hls.Events.AUDIO_TRACK_SWITCHED, () => emitHlsTracks(session, Hls));
    hls.on(Hls.Events.SUBTITLE_TRACKS_UPDATED, () => emitHlsTracks(session, Hls));
    hls.on(Hls.Events.SUBTITLE_TRACK_SWITCH, () => emitHlsTracks(session, Hls));
    hls.on(Hls.Events.ERROR, (_event, data) => {
      if (session.cleaned) return;

      const detail = String(data?.details || '');
      if (!data.fatal) {
        if (/bufferStalledError|bufferNudgeOnStall/i.test(detail) && !session.video.paused && !session.video.seeking) {
          if (!session.stallSince) {
            session.stallSince = performance.now();
            session.stallCount += 1;
          }
          emit(session.video, 'state', { state: 'buffering' });
        }
        if (/bufferFullError/i.test(detail)) {
          session.bufferPressureCount = Number(session.bufferPressureCount || 0) + 1;
          const currentTarget = Number(hls.config.maxBufferLength || session.bufferTarget || profile.targetBuffer);
          const currentByteCeiling = Number(hls.config.maxBufferSize || profile.maxBufferBytes);
          // Retreat gradually instead of collapsing from the turbo target to a
          // tiny 100/150-second window on the first quota warning.
          const targetFactor = session.bufferPressureCount === 1 ? 0.82 : 0.72;
          const byteFactor = session.bufferPressureCount === 1 ? 0.84 : 0.74;
          const safeTarget = Math.max(profile.memorySafeBuffer, Math.floor(currentTarget * targetFactor));
          const safeByteCeiling = Math.max(profile.bufferByteFloor, Math.floor(currentByteCeiling * byteFactor));
          hls.config.maxBufferLength = safeTarget;
          hls.config.maxMaxBufferLength = Math.max(safeTarget, Math.floor(Number(hls.config.maxMaxBufferLength || profile.maxBuffer) * targetFactor));
          hls.config.maxBufferSize = safeByteCeiling;
          session.bufferTarget = safeTarget;
          emit(session.video, 'bufferTarget', {
            engine: 'hls.js',
            target: safeTarget,
            maxBufferBytes: safeByteCeiling,
            reason: 'memory-pressure',
            pressureCount: session.bufferPressureCount,
          });
        }
        return;
      }

      if (!session.verified && data.type === Hls.ErrorTypes.NETWORK_ERROR) {
        if (/fragLoad|keyLoad/i.test(detail) && retryStartupFragment(detail || 'network', data)) {
          armStartupTimer(proxied ? 15000 : 18000);
          return;
        }
        fatal(data);
        return;
      }

      if (data.type === Hls.ErrorTypes.NETWORK_ERROR && consumeRecoveryBudget(session, 'networkRecoveryTimestamps', 2, 90_000)) {
        const attempt = session.networkRecoveryTimestamps.length;
        const position = recoveryPosition(session, session.video.currentTime || 0);
        emergencyDownshift(session);
        emit(session.video, 'state', { state: 'reconnecting', attempt });
        addTimer(session, () => {
          if (!navigator.onLine || document.hidden || session.cleaned) return;
          try {
            hls.startLoad(Math.max(0, position - 0.15)); session.hlsLoadingStopped = false;
            session.video.currentTime = position; safePlay(session.video).catch(() => {});
          } catch { fatal(data); }
        }, Math.min(700 * (2 ** (attempt - 1)), 2200));
        return;
      }

      if (data.type === Hls.ErrorTypes.MEDIA_ERROR && consumeRecoveryBudget(session, 'mediaRecoveryTimestamps', 1, 90_000)) {
        emit(session.video, 'state', { state: 'recovering', attempt: 1 });
        try { hls.recoverMediaError(); return; } catch { fatal(data); return; }
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
  session.bufferTarget = profile.targetBuffer;
  player.updateSettings({ streaming: {
    abr: {
      autoSwitchBitrate: { video: true, audio: true },
      initialBitrate: {
        video: profile.slowNetwork ? 500 : profile.mobile ? (profile.memory >= 8 ? 80000 : 50000) : 120000,
      },
      limitBitrateByPortal: true,
      useDeadTimeLatency: true,
      throughput: {
        useResourceTimingApi: true,
        useDeadTimeLatency: true,
        bandwidthSafetyFactor: profile.slowNetwork ? 0.82 : 0.98,
        sampleSettings: { vod: 2, live: 3, enableSampleSizeAdjustment: true, decreaseScale: 0.82, increaseScale: 1.5, maxMeasurementsToKeep: 12 },
        ewma: { throughputSlowHalfLifeSeconds: 4, throughputFastHalfLifeSeconds: 1.5 },
      },
    },
    buffer: {
      bufferTimeDefault: profile.targetBuffer,
      bufferTimeAtTopQuality: profile.targetBuffer,
      bufferTimeAtTopQualityLongForm: profile.maxBuffer,
      bufferToKeep: profile.backBuffer,
      fastSwitchEnabled: true,
    },
    retryAttempts: { MPD: 2, MediaSegment: 4, InitializationSegment: 3 },
    retryIntervals: { MPD: 500, MediaSegment: 500, InitializationSegment: 500 },
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
          const fallbackPosition = recoveryPosition(session, resumeAt);
          cleanupSession(session, true);
          emit(video, 'state', { state: 'loading', fallback: 'hls.js' });
          return playStream(video, value, false, fallbackPosition);
        }
      } else {
        try { await playWithHls(session); }
        catch (error) {
          const canFallBackToNative = supportsNativeHls(video)
            && /(?:当前浏览器不支持 HLS 播放|HLS 播放组件加载失败)/.test(String(error?.message || ''));
          if (!canFallBackToNative || session.cleaned) throw error;
          emit(video, 'state', { state: 'loading', fallback: 'native-hls' });
          await playNative(session);
        }
      }
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
  seekStream,
  setPlaybackAudioTrack,
  setPlaybackQuality,
  setPlaybackSubtitleTrack,
  stopStream,
};
