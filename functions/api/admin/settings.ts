import { requireAdmin } from '../../_shared/auth';
import { getSettings, setSetting } from '../../_shared/db';
import { cleanText, ok, readJson } from '../../_shared/http';
import type { AppData, Env } from '../../_shared/types';

const ALLOWED = new Set(['site_name', 'home_notice', 'metadata_source']);
const METADATA_SOURCES = new Set(['auto', 'douban', 'tmdb']);

export const onRequestGet: PagesFunction<Env, any, AppData> = async ({ request, env }) => {
  requireAdmin(request, env);
  return ok({ settings: { site_name: env.SITE_NAME || 'Cactus TV', home_notice: '', metadata_source: 'auto', ...(await getSettings(env)) } });
};

export const onRequestPut: PagesFunction<Env, any, AppData> = async ({ request, env }) => {
  requireAdmin(request, env);
  const body = await readJson<Record<string, unknown>>(request, 20_000);
  for (const [key, value] of Object.entries(body)) {
    if (!ALLOWED.has(key)) continue;
    if (key === 'metadata_source') {
      const source = cleanText(value, 16).toLowerCase();
      await setSetting(env, key, METADATA_SOURCES.has(source) ? source : 'auto');
    } else {
      await setSetting(env, key, cleanText(value, key === 'home_notice' ? 1000 : 120));
    }
  }
  return ok({ settings: await getSettings(env) });
};
