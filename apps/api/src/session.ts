// Signed session cookies: base64url header.payload.sig JWT, HMAC-SHA256 via WebCrypto.
// No npm deps beyond hono's cookie helpers. Cookie: kms_session, HttpOnly, 7-day expiry
// (docs/03 §5, NFR-4).

import type { Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import type { Role } from '@kms/core';
import type { AppEnv } from './env';

export const SESSION_COOKIE = 'kms_session';
export const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60; // 7 days

export interface SessionPayload {
  contactId: string;
  eventId: string;
  eventSlug: string;
  email: string;
  role: Role;
  /** set when an admin is impersonating a speaker via "View Portal" */
  impersonatedBy?: string;
  /** unix seconds */
  exp: number;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function b64urlEncode(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i] as number);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecode(s: string): Uint8Array<ArrayBuffer> | null {
  try {
    const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4);
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

async function hmacKey(secret: string, usages: KeyUsage[]): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    usages,
  );
}

/**
 * Mint a signed session token. `exp` defaults to now + 7 days when not supplied.
 */
export async function createSessionToken(
  payload: Omit<SessionPayload, 'exp'> & { exp?: number },
  secret: string,
): Promise<string> {
  const exp = payload.exp ?? Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS;
  const full: SessionPayload = { ...payload, exp };
  const header = b64urlEncode(encoder.encode(JSON.stringify({ alg: 'HS256', typ: 'JWT' })));
  const body = b64urlEncode(encoder.encode(JSON.stringify(full)));
  const signingInput = `${header}.${body}`;
  const key = await hmacKey(secret, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(signingInput));
  return `${signingInput}.${b64urlEncode(new Uint8Array(sig))}`;
}

/**
 * Verify signature + expiry. Returns the payload or null — never throws on bad input.
 */
export async function verifySessionToken(
  token: string,
  secret: string,
): Promise<SessionPayload | null> {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [header, body, sig] = parts as [string, string, string];
  const sigBytes = b64urlDecode(sig);
  const bodyBytes = b64urlDecode(body);
  if (!sigBytes || !bodyBytes) return null;

  const key = await hmacKey(secret, ['verify']);
  // crypto.subtle.verify is constant-time — never compare signatures with ===.
  const valid = await crypto.subtle.verify(
    'HMAC',
    key,
    sigBytes,
    encoder.encode(`${header}.${body}`),
  );
  if (!valid) return null;

  let payload: SessionPayload;
  try {
    payload = JSON.parse(decoder.decode(bodyBytes)) as SessionPayload;
  } catch {
    return null;
  }
  if (
    typeof payload !== 'object' ||
    payload === null ||
    typeof payload.contactId !== 'string' ||
    typeof payload.eventId !== 'string' ||
    typeof payload.exp !== 'number'
  ) {
    return null;
  }
  if (payload.exp <= Math.floor(Date.now() / 1000)) return null;
  return payload;
}

/** Read + verify the kms_session cookie; null when absent, tampered or expired. */
export async function getSession<E extends AppEnv>(c: Context<E>): Promise<SessionPayload | null> {
  const token = getCookie(c, SESSION_COOKIE);
  if (!token) return null;
  return verifySessionToken(token, c.env.SESSION_SECRET);
}

export function setSessionCookie<E extends AppEnv>(c: Context<E>, token: string): void {
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    secure: true,
    sameSite: 'Lax',
    path: '/',
    maxAge: SESSION_TTL_SECONDS,
  });
}

export function clearSessionCookie<E extends AppEnv>(c: Context<E>): void {
  deleteCookie(c, SESSION_COOKIE, { path: '/' });
}
