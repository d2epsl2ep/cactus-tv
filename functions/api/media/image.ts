import { HttpError } from '../../_shared/http';
import { getMediaSession, mediaApiUrl, validateProxyTarget } from '../../_shared/media';
import { proxyMediaRequest } from '../../_shared/media-response';
import type { AppData, Env } from '../../_shared/types';

export const onRequestGet: PagesFunction<Env, any, AppData> = async ({ request }) => {
  const params = new URL(request.url).searchParams;
  const session = await getMediaSession(params.get('session'));
  const itemId = String(params.get('id') || '').trim();
  const type = String(params.get('type') || 'Primary');
  if (!itemId || itemId.length > 240) throw new HttpError(400, '图片项目 ID 无效', 'MEDIA_IMAGE_ID_INVALID');
  if (!['Primary', 'Backdrop', 'Thumb', 'Logo', 'Banner'].includes(type)) throw new HttpError(400, '图片类型无效', 'MEDIA_IMAGE_TYPE_INVALID');
  const maxWidth = Math.max(120, Math.min(2400, Number(params.get('maxWidth') || (type === 'Backdrop' ? 1600 : 600))));
  const upstream = mediaApiUrl(session, `/Items/${encodeURIComponent(itemId)}/Images/${type}`, {
    maxWidth,
    quality: 88,
    tag: String(params.get('tag') || '').slice(0, 200),
  });
  return proxyMediaRequest(request, session, validateProxyTarget(session, upstream));
};
