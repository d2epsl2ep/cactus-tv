import { HttpError, ok, readJson } from '../../_shared/http';
import { fetchMedia, getMediaSession, secondsToTicks } from '../../_shared/media';
import type { AppData, Env } from '../../_shared/types';

interface ProgressBody {
  session?: string;
  action?: 'start' | 'progress' | 'stop';
  itemId?: string;
  mediaSourceId?: string;
  playSessionId?: string;
  playMethod?: string;
  position?: number;
  duration?: number;
  isPaused?: boolean;
}

export const onRequestPost: PagesFunction<Env, any, AppData> = async ({ request }) => {
  const body = await readJson<ProgressBody>(request, 20_000);
  const session = await getMediaSession(body.session);
  const action = String(body.action || 'progress');
  const itemId = String(body.itemId || '').trim();
  if (!itemId || !['start', 'progress', 'stop'].includes(action)) {
    throw new HttpError(400, '播放进度参数无效', 'MEDIA_PROGRESS_INVALID');
  }
  const path = action === 'start'
    ? '/Sessions/Playing'
    : action === 'stop'
      ? '/Sessions/Playing/Stopped'
      : '/Sessions/Playing/Progress';
  const payload = {
    ItemId: itemId,
    MediaSourceId: String(body.mediaSourceId || ''),
    PlaySessionId: String(body.playSessionId || ''),
    PositionTicks: secondsToTicks(body.position),
    RunTimeTicks: secondsToTicks(body.duration),
    IsPaused: Boolean(body.isPaused),
    IsMuted: false,
    VolumeLevel: 100,
    CanSeek: true,
    PlayMethod: String(body.playMethod || 'Transcode'),
    RepeatMode: 'RepeatNone',
  };
  const response = await fetchMedia(session, path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  }, {}, 10_000);
  if (!response.ok && response.status !== 204) {
    if (response.status === 401 || response.status === 403) throw new HttpError(401, '媒体库登录已失效', 'MEDIA_AUTH_FAILED');
    throw new HttpError(502, `进度同步失败（HTTP ${response.status}）`, 'MEDIA_PROGRESS_FAILED');
  }
  return ok({ synced: true }, 200, { 'cache-control': 'private, no-store' });
};
