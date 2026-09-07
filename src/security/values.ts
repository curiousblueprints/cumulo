import { FieldType, type FieldDef } from '../domain/types.js';
import { ValidationError } from './errors.js';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Normalise an incoming value to the text form kept in the `value` table.
 * Returns null for an empty value, which is how "no value" is represented.
 */
export function toStoredValue(field: FieldDef, raw: unknown): string | null {
  if (raw === null || raw === undefined) return null;
  const text = typeof raw === 'string' ? raw.trim() : String(raw);
  if (text === '') return null;

  switch (field.type) {
    case FieldType.Number: {
      const value = Number(text);
      if (!Number.isFinite(value)) {
        throw new ValidationError(`Field "${field.name}" expects a number, got "${text}"`);
      }
      return String(value);
    }
    case FieldType.Boolean: {
      const lower = text.toLowerCase();
      if (['true', '1', 'yes', 'on'].includes(lower)) return 'true';
      if (['false', '0', 'no', 'off'].includes(lower)) return 'false';
      throw new ValidationError(`Field "${field.name}" expects a boolean, got "${text}"`);
    }
    case FieldType.Date: {
      if (!ISO_DATE.test(text)) {
        throw new ValidationError(`Field "${field.name}" expects a date as YYYY-MM-DD`);
      }
      return text;
    }
    case FieldType.DateTime: {
      const parsed = new Date(text);
      if (Number.isNaN(parsed.getTime())) {
        throw new ValidationError(`Field "${field.name}" expects a date/time`);
      }
      return parsed.toISOString();
    }
    case FieldType.Reference:
    case FieldType.Text:
      return text;
    default:
      throw new ValidationError(`Unsupported field type on "${field.name}"`);
  }
}

/** Turn the stored text back into a typed JavaScript value. */
export function fromStoredValue(field: FieldDef, stored: string | null): unknown {
  if (stored === null) return null;
  switch (field.type) {
    case FieldType.Number:
      return Number(stored);
    case FieldType.Boolean:
      return stored === 'true';
    default:
      return stored;
  }
}
