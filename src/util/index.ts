import { randomUUID } from 'node:crypto';

export function newId(): string {
  return randomUUID();
}

export function nowIso(): string {
  return new Date().toISOString();
}

/** API names: a letter followed by letters, digits or underscores. */
const API_NAME = /^[A-Za-z][A-Za-z0-9_]*$/;

export function isValidApiName(name: string): boolean {
  return API_NAME.test(name) && name.length <= 64;
}
