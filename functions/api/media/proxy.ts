import { HttpError } from '../../_shared/http';
import { decodeProxyTarget, getMediaSession, validateProxyTarget } from '../../_shared/media';
import { proxyMediaRequest } from '../../_shared/media-response';
import type { AppData, Env } from '../../_shared/types';

export const onRequestGet: PagesFunction<Env, any, AppData> = async ({ request }) => {
  const params = new URL(request.url).searchParams;
  const session = await getMediaSession(params.get('session'));
  const encoded = String(params.get('u') || '');
  if (!encoded || encoded.length > 12_000) throw new HttpError(400, '媒体代理地址无效', 'MEDIA_PROXY_TARGET_INVALID');
  const target = validateProxyTarget(session, decodeProxyTarget(encoded));
  return proxyMediaRequest(request, session, target);
};

export const onRequestHead = onRequestGet;
