import type { AppData, Env } from '../_shared/types';

const ALLOWED_HOSTS = /(^|\.)doubanio\.com$/i;
const IMAGE_TYPE = /^image\//i;
const BINARY_TYPE = /^(application|binary)\/octet-stream$/i;

function noStore(message: string, status: number): Response {
  return new Response(message, {
    status,
    headers: {
      'cache-control': 'no-store',
      'content-type': 'text/plain; charset=utf-8',
    },
  });
}

function inferredType(url: URL): string {
  const path = url.pathname.toLowerCase();
  if (path.endsWith('.png')) return 'image/png';
  if (path.endsWith('.webp')) return 'image/webp';
  if (path.endsWith('.gif')) return 'image/gif';
  if (path.endsWith('.avif')) return 'image/avif';
  if (path.endsWith('.svg')) return 'image/svg+xml';
  if (path.endsWith('.jpg') || path.endsWith('.jpeg')) return 'image/jpeg';
  return '';
}

export const onRequestGet: PagesFunction<Env, any, AppData> = async ({ request }) => {
  const requestUrl = new URL(request.url);
  const source = requestUrl.searchParams.get('url') || '';

  let imageUrl: URL;
  try {
    imageUrl = new URL(source);
  } catch {
    return noStore('Bad image URL', 400);
  }

  if (imageUrl.protocol !== 'https:' || !ALLOWED_HOSTS.test(imageUrl.hostname)) {
    return noStore('Image host not allowed', 403);
  }

  const cache = caches.default;
  const cacheUrl = new URL(requestUrl.origin + requestUrl.pathname);
  cacheUrl.searchParams.set('url', imageUrl.toString());
  cacheUrl.searchParams.set('rev', '4');
  const cacheKey = new Request(cacheUrl.toString(), { method: 'GET' });
  const cached = await cache.match(cacheKey);
  if (cached) return cached;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12_000);

  let response: Response;
  try {
    response = await fetch(imageUrl.toString(), {
      headers: {
        Accept: 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
        Referer: 'https://movie.douban.com/',
        'User-Agent': 'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 Chrome/121.0.0.0 Mobile Safari/537.36',
      },
      redirect: 'follow',
      signal: controller.signal,
    });
  } catch {
    clearTimeout(timeout);
    return noStore('Image request failed', 502);
  }
  clearTimeout(timeout);

  const upstreamType = (response.headers.get('content-type') || '').split(';')[0].trim();
  const guessedType = inferredType(imageUrl);
  const acceptedType = IMAGE_TYPE.test(upstreamType)
    ? upstreamType
    : (BINARY_TYPE.test(upstreamType) || !upstreamType) && guessedType
      ? guessedType
      : '';

  if (!response.ok || !response.body || !acceptedType) {
    return noStore('Image unavailable', response.ok ? 502 : response.status || 502);
  }

  const headers = new Headers();
  headers.set('content-type', acceptedType);
  headers.set('cache-control', 'public, max-age=86400, s-maxage=604800, stale-while-revalidate=86400');
  headers.set('x-content-type-options', 'nosniff');

  const proxied = new Response(response.body, { status: 200, headers });
  await cache.put(cacheKey, proxied.clone());
  return proxied;
};
