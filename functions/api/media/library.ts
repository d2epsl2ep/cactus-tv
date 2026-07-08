import { HttpError, ok } from '../../_shared/http';
import { fetchMediaJson, getMediaSession, mapMediaItem } from '../../_shared/media';
import type { AppData, Env } from '../../_shared/types';

const LIST_FIELDS = [
  'Overview', 'Genres', 'DateCreated', 'CommunityRating', 'CriticRating', 'OfficialRating',
  'ProductionYear', 'RunTimeTicks', 'UserData', 'PrimaryImageAspectRatio', 'SeriesInfo',
].join(',');

function itemsFrom(payload: any): any[] {
  if (Array.isArray(payload)) return payload;
  return Array.isArray(payload?.Items) ? payload.Items : [];
}

function uniqueItems(items: any[]): any[] {
  const seen = new Set<string>();
  return items.filter(item => {
    const id = String(item?.Id || '');
    if (!id || seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

async function listItems(session: any, params: Record<string, unknown>) {
  const payload = await fetchMediaJson(session, `/Users/${encodeURIComponent(session.userId)}/Items`, {}, {
    Recursive: true,
    IncludeItemTypes: 'Movie,Series,Episode',
    Fields: LIST_FIELDS,
    EnableImages: true,
    ImageTypeLimit: 1,
    EnableUserData: true,
    ...params,
  });
  return uniqueItems(itemsFrom(payload)).map(mapMediaItem).filter(item => item.id);
}

async function homeSections(session: any) {
  const user = encodeURIComponent(session.userId);
  const [viewsResult, resumeResult, latestResult] = await Promise.allSettled([
    fetchMediaJson(session, `/Users/${user}/Views`),
    fetchMediaJson(session, `/Users/${user}/Items/Resume`, {}, {
      Limit: 20,
      MediaTypes: 'Video',
      Fields: LIST_FIELDS,
      EnableImages: true,
      ImageTypeLimit: 1,
      EnableUserData: true,
    }),
    fetchMediaJson(session, `/Users/${user}/Items/Latest`, {}, {
      Limit: 24,
      IncludeItemTypes: 'Movie,Series,Episode',
      Fields: LIST_FIELDS,
      EnableImages: true,
      ImageTypeLimit: 1,
      EnableUserData: true,
      GroupItems: true,
    }),
  ]);

  const viewsPayload = viewsResult.status === 'fulfilled' ? viewsResult.value : {};
  const views = itemsFrom(viewsPayload)
    .filter(view => view?.Id && !['playlists', 'livetv'].includes(String(view?.CollectionType || '').toLowerCase()))
    .slice(0, 5);

  const viewResults = await Promise.allSettled(views.map(view => listItems(session, {
    ParentId: String(view.Id),
    Limit: 20,
    StartIndex: 0,
    SortBy: 'DateCreated,SortName',
    SortOrder: 'Descending',
  })));

  const sections: any[] = [];
  if (resumeResult.status === 'fulfilled') {
    const items = uniqueItems(itemsFrom(resumeResult.value)).map(mapMediaItem).filter(item => item.id);
    if (items.length) sections.push({ id: 'resume', title: '继续观看', kicker: 'CONTINUE', items });
  }
  if (latestResult.status === 'fulfilled') {
    const items = uniqueItems(itemsFrom(latestResult.value)).map(mapMediaItem).filter(item => item.id);
    if (items.length) sections.push({ id: 'latest', title: '最近加入', kicker: 'LATEST', items });
  }

  viewResults.forEach((result, index) => {
    if (result.status !== 'fulfilled' || !result.value.length) return;
    sections.push({
      id: `view-${String(views[index].Id)}`,
      title: String(views[index].Name || '媒体库'),
      kicker: String(views[index].CollectionType || 'LIBRARY').toUpperCase(),
      items: result.value,
    });
  });

  return { sections, views: views.map(view => ({ id: String(view.Id), name: String(view.Name || '媒体库'), collectionType: String(view.CollectionType || '') })) };
}

export const onRequestGet: PagesFunction<Env, any, AppData> = async ({ request }) => {
  const params = new URL(request.url).searchParams;
  const session = await getMediaSession(params.get('session'));
  const mode = String(params.get('mode') || 'home');

  if (mode === 'home') {
    const result = await homeSections(session);
    return ok({ ...result, serverName: session.serverName, userName: session.userName }, 200, {
      'cache-control': 'private, no-store',
    });
  }

  const limit = Math.max(1, Math.min(80, Number(params.get('limit') || 60)));
  const start = Math.max(0, Number(params.get('start') || 0));
  const parent = String(params.get('parent') || '').trim();
  const query = String(params.get('q') || '').trim().slice(0, 100);

  if (mode === 'search' && !query) throw new HttpError(400, '请输入搜索关键词', 'MEDIA_SEARCH_QUERY_REQUIRED');
  if (!['search', 'items'].includes(mode)) throw new HttpError(400, '媒体库请求类型无效', 'MEDIA_LIBRARY_MODE_INVALID');

  const items = await listItems(session, {
    ...(parent ? { ParentId: parent } : {}),
    ...(query ? { SearchTerm: query } : {}),
    Limit: limit,
    StartIndex: start,
    SortBy: query ? 'SortName' : 'DateCreated,SortName',
    SortOrder: query ? 'Ascending' : 'Descending',
  });

  return ok({ items, start, limit, query, serverName: session.serverName }, 200, {
    'cache-control': 'private, no-store',
  });
};
