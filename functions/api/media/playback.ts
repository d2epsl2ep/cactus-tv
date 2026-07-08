import { HttpError, ok } from '../../_shared/http';
import { encodeProxyTarget, fetchMediaJson, getMediaSession, mediaApiUrl } from '../../_shared/media';
import type { AppData, Env } from '../../_shared/types';

function firstStream(source: any, type: string) {
  const streams = Array.isArray(source?.MediaStreams) ? source.MediaStreams : [];
  return streams.find((stream: any) => String(stream?.Type || '').toLowerCase() === type.toLowerCase() && stream?.IsDefault)
    || streams.find((stream: any) => String(stream?.Type || '').toLowerCase() === type.toLowerCase());
}

function directCompatible(source: any): boolean {
  const container = String(source?.Container || '').toLowerCase();
  const video = String(firstStream(source, 'Video')?.Codec || '').toLowerCase();
  const audio = String(firstStream(source, 'Audio')?.Codec || '').toLowerCase();
  const mp4 = ['mp4', 'm4v', 'mov'].includes(container) && ['h264', 'avc'].includes(video) && ['aac', 'mp3', ''].includes(audio);
  const webm = container === 'webm' && ['vp8', 'vp9', 'av1'].includes(video) && ['opus', 'vorbis', ''].includes(audio);
  return mp4 || webm;
}

function stripAuthQuery(url: URL): URL {
  for (const key of [...url.searchParams.keys()]) {
    if (/^(api_key|apikey|x-emby-token|token)$/i.test(key)) url.searchParams.delete(key);
  }
  return url;
}

function subtitleUrl(request: Request, session: any, itemId: string, source: any, stream: any): string {
  let upstream: URL;
  const delivery = String(stream?.DeliveryUrl || '').trim();
  if (delivery) upstream = new URL(delivery, `${session.apiBase.replace(/\/$/, '')}/`);
  else upstream = new URL(mediaApiUrl(session, `/Videos/${encodeURIComponent(itemId)}/${encodeURIComponent(String(source?.Id || itemId))}/Subtitles/${Number(stream?.Index || 0)}/Stream.vtt`));
  stripAuthQuery(upstream);
  const target = encodeProxyTarget(upstream.toString());
  return `${new URL(request.url).origin}/api/media/proxy?session=${encodeURIComponent(session.id)}&u=${encodeURIComponent(target)}`;
}

function mapSubtitles(request: Request, session: any, itemId: string, source: any) {
  const streams = Array.isArray(source?.MediaStreams) ? source.MediaStreams : [];
  return streams
    .filter((stream: any) => String(stream?.Type || '').toLowerCase() === 'subtitle' && stream?.Index !== undefined)
    .slice(0, 30)
    .map((stream: any, index: number) => ({
      id: `media-sub-${stream.Index}`,
      name: String(stream?.DisplayTitle || stream?.Title || stream?.Language || `字幕 ${index + 1}`),
      lang: String(stream?.Language || 'und'),
      format: 'vtt',
      url: subtitleUrl(request, session, itemId, source, stream),
      forced: Boolean(stream?.IsForced),
      default: Boolean(stream?.IsDefault),
    }));
}

export const onRequestGet: PagesFunction<Env, any, AppData> = async ({ request }) => {
  const params = new URL(request.url).searchParams;
  const session = await getMediaSession(params.get('session'));
  const itemId = String(params.get('id') || '').trim();
  if (!itemId || itemId.length > 200) throw new HttpError(400, '媒体项目 ID 无效', 'MEDIA_ITEM_ID_INVALID');

  let payload: any;
  try {
    payload = await fetchMediaJson(session, `/Items/${encodeURIComponent(itemId)}/PlaybackInfo`, {}, {
      UserId: session.userId,
      IsPlayback: true,
      AutoOpenLiveStream: true,
      MaxStreamingBitrate: 120000000,
    }, 20_000);
  } catch {
    const item = await fetchMediaJson(session, `/Users/${encodeURIComponent(session.userId)}/Items/${encodeURIComponent(itemId)}`, {}, {
      Fields: 'MediaSources,MediaStreams',
    }, 15_000);
    payload = { MediaSources: item?.MediaSources || [], PlaySessionId: crypto.randomUUID() };
  }

  const sources = Array.isArray(payload?.MediaSources) ? payload.MediaSources : [];
  const source = sources.find((entry: any) => entry?.SupportsDirectPlay) || sources[0];
  if (!source) throw new HttpError(404, '媒体服务器没有返回可播放文件', 'MEDIA_SOURCE_NOT_FOUND');

  const mediaSourceId = String(source.Id || itemId);
  const playSessionId = String(payload.PlaySessionId || crypto.randomUUID());
  const audio = firstStream(source, 'Audio');
  const origin = new URL(request.url).origin;
  const common = new URLSearchParams({
    session: session.id,
    item: itemId,
    source: mediaSourceId,
    playSession: playSessionId,
  });
  if (audio?.Index !== undefined) common.set('audio', String(audio.Index));

  const directParams = new URLSearchParams(common);
  directParams.set('mode', 'direct');
  const hlsParams = new URLSearchParams(common);
  hlsParams.set('mode', 'hls');

  const subtitles = mapSubtitles(request, session, itemId, source);
  const baseMeta = {
    mediaItemId: itemId,
    mediaSourceId,
    playSessionId,
    subtitles,
  };
  const direct = {
    ...baseMeta,
    name: '原画直连',
    url: `${origin}/api/media/stream?${directParams.toString()}`,
    playMethod: 'DirectPlay',
  };
  const hls = {
    ...baseMeta,
    name: '自动转码',
    url: `${origin}/api/media/stream?${hlsParams.toString()}`,
    playMethod: 'Transcode',
  };
  const variants = directCompatible(source) ? [direct, hls] : [hls, direct];

  return ok({
    variants,
    subtitles,
    mediaSource: {
      id: mediaSourceId,
      name: String(source.Name || ''),
      container: String(source.Container || ''),
      size: Number(source.Size || 0),
      bitrate: Number(source.Bitrate || 0),
      directCompatible: directCompatible(source),
    },
  }, 200, { 'cache-control': 'private, no-store' });
};
