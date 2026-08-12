// Password hashing for the portal sign-up + admin password login (0032
// auth_credentials). Dependency-free like session.ts: PBKDF2-SHA256 through
// WebCrypto, which is the strongest KDF workerd exposes — Argon2/scrypt would
// need WASM. Per-user 16-byte random salt, 100 000 iterations, 256-bit output,
// everything stored base64url.
//
// The iteration count is stored per row rather than assumed, so raising the
// default later verifies old rows with the count they were written at.

import { b64urlDecode, b64urlEncode } from './session';

export const PBKDF2_ITERATIONS = 100_000;
export const PASSWORD_ALGO = 'pbkdf2-sha256';
/** Minimum length accepted at sign-up and on the admin set-password route. */
export const MIN_PASSWORD_LENGTH = 8;

const encoder = new TextEncoder();

export interface StoredCredential {
  hash: string;
  salt: string;
  iterations: number;
}

async function derive(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, [
    'deriveBits',
  ]);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: salt as BufferSource, iterations },
    key,
    256,
  );
  return new Uint8Array(bits);
}

/** Hash a new password with a fresh random salt. */
export async function hashPassword(password: string): Promise<StoredCredential> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const bits = await derive(password, salt, PBKDF2_ITERATIONS);
  return { hash: b64urlEncode(bits), salt: b64urlEncode(salt), iterations: PBKDF2_ITERATIONS };
}

/**
 * Compare two byte strings without an early exit — a `===` on the derived key
 * leaks, through timing, how long a prefix an attacker guessed correctly.
 */
export function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= (a[i] as number) ^ (b[i] as number);
  return diff === 0;
}

/** Verify against a stored credential, deriving with ITS iteration count. */
export async function verifyPassword(password: string, stored: StoredCredential): Promise<boolean> {
  const salt = b64urlDecode(stored.salt);
  const expected = b64urlDecode(stored.hash);
  if (!salt || !expected) return false;
  const actual = await derive(password, salt, stored.iterations);
  return constantTimeEqual(actual, expected);
}

/**
 * A real credential to verify against when the account does not exist (or has
 * no active password). Without it, "unknown email" answers in microseconds and
 * "wrong password" in ~100 ms, which turns the login form into an
 * address-enumeration oracle no matter how generic the error text is.
 * Plaintext is irrelevant — nothing ever authenticates against this row.
 */
export const DUMMY_CREDENTIAL: StoredCredential = {
  hash: '6x0eiQrY3dgqkfGM8-kILK-s_pheAaHuf6ZVMr2Mm6g',
  salt: 'a21zLXNlZWQtc2FsdC0wMQ',
  iterations: PBKDF2_ITERATIONS,
};
