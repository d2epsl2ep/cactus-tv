import { HttpError, ok, readJson } from '../../_shared/http';
import {
  fetchMediaJson,
  mediaAuthHeaders,
  mediaApiUrl,
  normalizeMediaKind,
  normalizeMediaServer,
  publicMediaSession,
  saveMediaSession,
} from '../../_shared/media';
import type { AppData, Env } from '../../_shared/types';

interface SessionRequest {
  kind?: string;
  serverUrl?: string;
  username?: string;
  password?: string;
  token?: string;
  userId?: string;
  deviceId?: string;
}

function clean(value: unknown, max = 300): string {
  return String(value ?? '').trim().slice(0, max);
}

function makeDeviceId(value: unknown): string {
  const cleaned = clean(value, 120).replace(/[^A-Za-z0-9._:-]/g, '-');
  return cleaned || `cactus-${crypto.randomUUID()}`;
}

export const onRequestPost: PagesFunction<Env, any, AppData> = async ({ request }) => {
  const body = await readJson<SessionRequest>(request, 24_000);
  const kind = normalizeMediaKind(body.kind);
  const { serverUrl, apiBase } = normalizeMediaServer(body.serverUrl, kind);
  const deviceId = makeDeviceId(body.deviceId);
  const username = clean(body.username, 120);
  const password = clean(body.password, 500);
  let token = clean(body.token, 1000);
  let userId = clean(body.userId, 200);
  let userName = username;

  const anonymousSession = { apiBase, token: '', userId: '', deviceId };
  let serverInfo: any = {};
  try {
    serverInfo = await fetchMediaJson(anonymousSession, '/System/Info/Public', {}, {}, 10_000);
  } catch (error) {
    throw new HttpError(502, error instanceof Error ? error.message : '无法连接媒体服务器', 'MEDIA_SERVER_UNREACHABLE');
  }

  if (username && password) {
    const response = await fetch(mediaApiUrl(anonymousSession, '/Users/AuthenticateByName'), {
      method: 'POST',
      headers: mediaAuthHeaders(anonymousSession, { 'content-type': 'application/json' }),
      body: JSON.stringify({ Username: username, Pw: password }),
      redirect: 'follow',
    });
    const text = await response.text();
    let payload: any = {};
    try { payload = JSON.parse(text || '{}'); } catch {}
    if (!response.ok || !payload?.AccessToken || !payload?.User?.Id) {
      const message = payload?.Message || payload?.message || '账号或密码错误';
      throw new HttpError(401, message, 'MEDIA_LOGIN_FAILED');
    }
    token = String(payload.AccessToken);
    userId = String(payload.User.Id);
    userName = String(payload.User.Name || username);
  } else if (token) {
    const tokenSession = { apiBase, token, userId, deviceId };
    if (userId) {
      const user = await fetchMediaJson(tokenSession, `/Users/${encodeURIComponent(userId)}`);
      userName = String(user?.Name || userName || userId);
    } else {
      const users = await fetchMediaJson(tokenSession, '/Users');
      const list = Array.isArray(users) ? users : [];
      const matched = username
        ? list.find((user: any) => String(user?.Name || '').toLowerCase() === username.toLowerCase())
        : list.length === 1 ? list[0] : null;
      if (!matched?.Id) {
        throw new HttpError(400, '使用访问令牌时还需要填写用户 ID', 'MEDIA_USER_ID_REQUIRED');
      }
      userId = String(matched.Id);
      userName = String(matched.Name || username || userId);
    }
  } else {
    throw new HttpError(400, '请填写账号密码，或填写访问令牌与用户 ID', 'MEDIA_CREDENTIALS_REQUIRED');
  }

  const session = await saveMediaSession({
    kind,
    serverUrl,
    apiBase,
    token,
    userId,
    userName,
    deviceId,
    serverId: String(serverInfo?.Id || serverInfo?.ServerId || ''),
    serverName: String(serverInfo?.ServerName || serverInfo?.Name || (kind === 'jellyfin' ? 'Jellyfin' : 'Emby')),
    serverVersion: String(serverInfo?.Version || ''),
  });

  return ok({ connection: { ...publicMediaSession(session), token: session.token } }, 201, {
    'cache-control': 'private, no-store',
  });
};
