import { HttpError } from '../../_shared/http';
import { getMediaSession, mediaApiUrl, validateProxyTarget } from '../../_shared/media';
import { proxyMediaRequest } from '../../_shared/media-response';
import type { AppData, Env } from '../../_shared/types';

function cleanId(value: string | null, name: string): string {
  const result = String(value || '').trim();
  if (!result || result.length > 240 || /[\r\n]/.test(result)) {
    throw new HttpError(400, `${name} 无效`, 'MEDIA_STREAM_PARAMETER_INVALID');
  }
  return result;
}

export const onRequestGet: PagesFunction<Env, any, AppData> = async ({ request }) => {
  const params = new URL(request.url).searchParams;
  const session = await getMediaSession(params.get('session'));
  const itemId = cleanId(params.get('item'), '媒体项目 ID');
  const sourceId = cleanId(params.get('source'), '媒体文件 ID');
  const playSessionId = String(params.get('playSession') || '').trim().slice(0, 200);
  const mode = String(params.get('mode') || 'hls');
  const audioIndex = Number(params.get('audio'));

  let upstream: string;
  if (mode === 'direct') {
    upstream = mediaApiUrl(session, `/Videos/${encodeURIComponent(itemId)}/stream`, {
      Static: true,
      MediaSourceId: sourceId,
      PlaySessionId: playSessionId,
      DeviceId: session.deviceId,
    });
  } else if (mode === 'hls') {
    upstream = mediaApiUrl(session, `/Videos/${encodeURIComponent(itemId)}/master.m3u8`, {
      MediaSourceId: sourceId,
      PlaySessionId: playSessionId,
      DeviceId: session.deviceId,
      VideoCodec: 'h264',
      AudioCodec: 'aac,mp3',
      AudioStreamIndex: Number.isFinite(audioIndex) ? audioIndex : undefined,
      VideoBitrate: 120000000,
      AudioBitrate: 384000,
      MaxStreamingBitrate: 120000000,
      TranscodingMaxAudioChannels: 2,
      RequireAvc: false,
      SubtitleMethod: 'Encode',
      SegmentContainer: 'ts',
      MinSegments: 1,
      BreakOnNonKeyFrames: true,
    });
  } else {
    throw new HttpError(400, '播放模式无效', 'MEDIA_STREAM_MODE_INVALID');
  }

  const target = validateProxyTarget(session, upstream);
  return proxyMediaRequest(request, session, target);
};

export const onRequestHead = onRequestGet;
