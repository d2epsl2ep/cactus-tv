import { HttpError, ok } from '../../_shared/http';
import { fetchMediaJson, getMediaSession, mapMediaItem, mediaImageDescriptor, ticksToSeconds } from '../../_shared/media';
import type { AppData, Env } from '../../_shared/types';

const DETAIL_FIELDS = [
  'Overview', 'Genres', 'People', 'Studios', 'ProductionLocations', 'CommunityRating', 'CriticRating',
  'OfficialRating', 'ProductionYear', 'RunTimeTicks', 'UserData', 'MediaStreams', 'MediaSources',
  'ProviderIds', 'Taglines', 'SeriesInfo',
].join(',');

function list(payload: any): any[] {
  if (Array.isArray(payload)) return payload;
  return Array.isArray(payload?.Items) ? payload.Items : [];
}

function personNames(item: any, type: string): string {
  return (Array.isArray(item?.People) ? item.People : [])
    .filter((person: any) => String(person?.Type || '').toLowerCase() === type.toLowerCase())
    .map((person: any) => String(person?.Name || '').trim())
    .filter(Boolean)
    .slice(0, type === 'Director' ? 6 : 20)
    .join('、');
}

function episodeEntry(item: any, index: number) {
  const mapped = mapMediaItem(item);
  const season = Number(item?.ParentIndexNumber || 0);
  const episode = Number(item?.IndexNumber || index + 1);
  return {
    ...mapped,
    name: String(item?.Name || `第 ${episode} 集`),
    label: season ? `S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')}` : `第 ${episode} 集`,
    mediaItemId: String(item?.Id || ''),
    mediaPlayback: true,
  };
}

async function seriesLines(session: any, seriesId: string) {
  const seasonsPayload = await fetchMediaJson(session, `/Shows/${encodeURIComponent(seriesId)}/Seasons`, {}, {
    UserId: session.userId,
    Fields: DETAIL_FIELDS,
    EnableImages: true,
    EnableUserData: true,
  });
  const seasons = list(seasonsPayload).filter(season => season?.Id);
  const settled = await Promise.allSettled(seasons.map(season => fetchMediaJson(session, `/Shows/${encodeURIComponent(seriesId)}/Episodes`, {}, {
    UserId: session.userId,
    SeasonId: String(season.Id),
    Fields: DETAIL_FIELDS,
    EnableImages: true,
    ImageTypeLimit: 1,
    EnableUserData: true,
    SortBy: 'IndexNumber',
    SortOrder: 'Ascending',
  })));

  return settled.map((result, index) => {
    if (result.status !== 'fulfilled') return null;
    const episodes = list(result.value).map(episodeEntry).filter(episode => episode.mediaItemId);
    if (!episodes.length) return null;
    return {
      name: String(seasons[index]?.Name || `第 ${index + 1} 季`),
      seasonId: String(seasons[index]?.Id || ''),
      episodes,
    };
  }).filter(Boolean);
}

export const onRequestGet: PagesFunction<Env, any, AppData> = async ({ request }) => {
  const params = new URL(request.url).searchParams;
  const session = await getMediaSession(params.get('session'));
  const id = String(params.get('id') || '').trim();
  if (!id || id.length > 200) throw new HttpError(400, '媒体项目 ID 无效', 'MEDIA_ITEM_ID_INVALID');

  const item = await fetchMediaJson(session, `/Users/${encodeURIComponent(session.userId)}/Items/${encodeURIComponent(id)}`, {}, {
    Fields: DETAIL_FIELDS,
    EnableImages: true,
    EnableUserData: true,
  });
  if (!item?.Id) throw new HttpError(404, '媒体项目不存在', 'MEDIA_ITEM_NOT_FOUND');

  const type = String(item.Type || '');
  let lines: any[] = [];
  if (type === 'Series') lines = await seriesLines(session, id);
  else lines = [{
    name: type === 'Episode' ? String(item.SeasonName || '选集') : '播放',
    episodes: [episodeEntry(item, 0)],
  }];

  const studios = (Array.isArray(item?.Studios) ? item.Studios : []).map((studio: any) => String(studio?.Name || '')).filter(Boolean);
  const locations = Array.isArray(item?.ProductionLocations) ? item.ProductionLocations.map(String) : [];
  const genres = Array.isArray(item?.Genres) ? item.Genres.map(String) : [];
  const images = mediaImageDescriptor(item);

  return ok({ item: {
    key: `media:${id}`,
    id: String(item.Id),
    mediaItemId: String(item.Id),
    name: String(item.Name || '未命名'),
    originalName: String(item.OriginalTitle || ''),
    year: String(item.ProductionYear || ''),
    type: type === 'Series' ? '剧集' : type === 'Episode' ? '单集' : type === 'Movie' ? '电影' : type || '视频',
    mediaType: type === 'Series' || type === 'Episode' ? 'tv' : 'movie',
    area: locations.join('、'),
    lang: '',
    content: String(item.Overview || ''),
    director: personNames(item, 'Director'),
    actors: personNames(item, 'Actor'),
    genres,
    studios,
    rating: Number(item.CommunityRating || item.CriticRating || 0),
    officialRating: String(item.OfficialRating || ''),
    runTime: ticksToSeconds(item.RunTimeTicks),
    images,
    lines,
    subtitles: [],
    mediaLibrary: true,
    serverName: session.serverName,
  } }, 200, { 'cache-control': 'private, no-store' });
};
