import type { Env } from './types';

const MEDIA_TICKET_VERSION = 'cactus-media-ticket-v1';
const MEDIA_TICKET_TTL_SECONDS = 24 * 60 * 60;
const MEDIA_TICKET_CLOCK_SKEW_SECONDS = 90;

export type MediaTicket = {
  token: string;
  expires: number;
};

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function timingSafeEqual(a: string, b: string): boolean {
  if (!a || a.length !== b.length) return false;
  let mismatch = 0;
  for (let index = 0; index < a.length; index += 1) {
    mismatch |= a.charCodeAt(index) ^ b.charCodeAt(index);
  }
  return mismatch === 0;
}

function ticketSecret(env: Env): string {
  const value = String(env.ADMIN_TOKEN || '').trim();
  return value.length >= 8 ? value : '';
}

function ticketMessage(providerId: string, expires: number): string {
  return `${MEDIA_TICKET_VERSION}\n${providerId}\n${expires}`;
}

async function signTicket(secret: string, providerId: string, expires: number): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign(
    'HMAC',
    key,
    encoder.encode(ticketMessage(providerId, expires)),
  );
  return bytesToBase64Url(new Uint8Array(signature));
}

export async function issueMediaTicket(env: Env, providerId: string): Promise<MediaTicket | null> {
  const secret = ticketSecret(env);
  if (!secret || !providerId) return null;
  const expires = Math.floor(Date.now() / 1000) + MEDIA_TICKET_TTL_SECONDS;
  return { token: await signTicket(secret, providerId, expires), expires };
}

export async function verifyMediaTicket(
  env: Env,
  providerId: string,
  expiresValue: unknown,
  tokenValue: unknown,
): Promise<boolean> {
  const secret = ticketSecret(env);
  const token = String(tokenValue || '').trim();
  const expires = Math.floor(Number(expiresValue || 0));
  if (!secret || !providerId || !token || !(expires > 0)) return false;

  const now = Math.floor(Date.now() / 1000);
  if (expires < now - MEDIA_TICKET_CLOCK_SKEW_SECONDS) return false;
  if (expires > now + MEDIA_TICKET_TTL_SECONDS + MEDIA_TICKET_CLOCK_SKEW_SECONDS) return false;

  const expected = await signTicket(secret, providerId, expires);
  return timingSafeEqual(token, expected);
}
