import {
  DAYS_OF_WEEK,
  FieldType,
  MONTHS,
  NUMERIC_FIELD_TYPES,
  SYSTEM_ASSIGNED_FIELD_TYPES,
  type FieldDef,
} from '../domain/types.js';
import { ValidationError } from './errors.js';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const FOUR_DIGITS = /^\d{4}$/;

/** A whole number within an inclusive range, or a ValidationError. */
function wholeNumberIn(field: FieldDef, text: string, low: number, high: number): string {
  const value = Number(text);
  if (!Number.isInteger(value) || value < low || value > high) {
    throw new ValidationError(`Field "${field.name}" expects a whole number from ${low} to ${high}`);
  }
  return String(value);
}

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
    case FieldType.Year: {
      // Four digits, numeric only -- not a calendar year with an era or sign.
      if (!FOUR_DIGITS.test(text)) {
        throw new ValidationError(`Field "${field.name}" expects a four-digit year`);
      }
      return text;
    }
    case FieldType.Month:
      return wholeNumberIn(field, text, 1, 12);
    case FieldType.Day:
      // Bounded but not calendar-checked: a day with no month cannot be known
      // to be too large for one.
      return wholeNumberIn(field, text, 1, 31);
    case FieldType.DayOfWeek:
      return wholeNumberIn(field, text, 1, 7);
    case FieldType.AutoNumber:
      throw new ValidationError(`Field "${field.name}" is assigned automatically`);
    case FieldType.Reference:
    case FieldType.Text:
      return text;
    default:
      throw new ValidationError(`Unsupported field type on "${field.name}"`);
  }
}

/** True for a type the platform fills in and no one may write. */
export function isSystemAssigned(field: FieldDef): boolean {
  return SYSTEM_ASSIGNED_FIELD_TYPES.includes(field.type);
}

/** Turn the stored text back into a typed JavaScript value. */
export function fromStoredValue(field: FieldDef, stored: string | null): unknown {
  if (stored === null) return null;
  if (NUMERIC_FIELD_TYPES.includes(field.type)) return Number(stored);
  if (field.type === FieldType.Boolean) return stored === 'true';
  return stored;
}

/**
 * How a value reads to a person. Months and weekdays are stored as numbers but
 * mean nothing as numbers, so they come back as their names.
 */
export function labelForValue(field: FieldDef, value: unknown): string {
  if (value === null || value === undefined || value === '') return '';
  if (field.type === FieldType.Month) {
    return MONTHS.find((month) => month.value === Number(value))?.label ?? String(value);
  }
  if (field.type === FieldType.DayOfWeek) {
    return DAYS_OF_WEEK.find((day) => day.value === Number(value))?.label ?? String(value);
  }
  if (field.type === FieldType.Boolean) return value === true ? 'Yes' : 'No';
  return String(value);
}
