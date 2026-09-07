import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

const KEY_LENGTH = 64;
const SCRYPT_COST = 16384;

/** Format: scrypt$<cost>$<saltHex>$<hashHex> */
export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, KEY_LENGTH, { N: SCRYPT_COST });
  return `scrypt$${SCRYPT_COST}$${salt.toString('hex')}$${hash.toString('hex')}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split('$');
  if (parts.length !== 4 || parts[0] !== 'scrypt') return false;
  const cost = Number(parts[1]);
  const salt = Buffer.from(parts[2] as string, 'hex');
  const expected = Buffer.from(parts[3] as string, 'hex');
  if (!Number.isFinite(cost) || expected.length === 0) return false;
  const actual = scryptSync(password, salt, expected.length, { N: cost });
  return timingSafeEqual(actual, expected);
}
