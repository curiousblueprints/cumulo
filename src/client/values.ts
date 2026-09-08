import type { FieldSummary } from './api';

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

const DAYS_OF_WEEK = [
  'Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday',
];

export const monthOptions = MONTHS.map((label, index) => ({
  value: String(index + 1),
  label,
}));

export const dayOfWeekOptions = DAYS_OF_WEEK.map((label, index) => ({
  value: String(index + 1),
  label,
}));

/** How a stored value reads to a person; the coded types get their names. */
export function displayValue(field: FieldSummary, value: unknown): string {
  if (value === null || value === undefined || value === '') return '';
  if (field.type === 'boolean') return value === true ? 'Yes' : 'No';
  if (field.type === 'month') return MONTHS[Number(value) - 1] ?? String(value);
  if (field.type === 'dayOfWeek') return DAYS_OF_WEEK[Number(value) - 1] ?? String(value);
  return String(value);
}

/** Fields the platform fills in, which never appear on a form. */
export function isSystemAssigned(field: FieldSummary): boolean {
  return field.type === 'autoNumber';
}
