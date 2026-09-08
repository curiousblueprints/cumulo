import { Button, Checkbox, Group, NumberInput, Select, Stack, TextInput } from '@mantine/core';
import { useState, type ReactNode } from 'react';
import type { FieldSummary, RecordSummary, TableSummary } from './api';
import { dayOfWeekOptions, isSystemAssigned, monthOptions } from './values';

interface RecordFormProps {
  fields: FieldSummary[];
  writable: string[];
  record?: RecordSummary;
  lookups: Map<string, { value: string; label: string }[]>;
  submitLabel: string;
  busy: boolean;
  onSubmit: (values: Record<string, unknown>) => void;
  onCancel: () => void;
}

/**
 * The form for one record. It renders only what the caller may write: the
 * security layer would refuse the rest anyway, and offering a field that
 * cannot be saved is worse than not offering it.
 */
export function RecordForm({
  fields,
  writable,
  record,
  lookups,
  submitLabel,
  busy,
  onSubmit,
  onCancel,
}: RecordFormProps): ReactNode {
  const editable = fields.filter(
    (field) => writable.includes(field.name) && !isSystemAssigned(field),
  );
  const [values, setValues] = useState<Record<string, unknown>>(() =>
    Object.fromEntries(
      editable.map((field) => [field.name, record?.values[field.name] ?? initialFor(field)]),
    ),
  );

  const set = (name: string, value: unknown): void =>
    setValues((current) => ({ ...current, [name]: value }));

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit(values);
      }}
    >
      <Stack gap="sm">
        {editable.map((field) => (
          <FieldInput
            key={field.id}
            field={field}
            value={values[field.name]}
            options={lookups.get(field.id) ?? []}
            onChange={(value) => set(field.name, value)}
          />
        ))}
        <Group gap="sm" mt="xs">
          <Button type="submit" loading={busy}>
            {submitLabel}
          </Button>
          <Button variant="default" onClick={onCancel} type="button">
            Cancel
          </Button>
        </Group>
      </Stack>
    </form>
  );
}

function initialFor(field: FieldSummary): unknown {
  return field.type === 'boolean' ? false : '';
}

function FieldInput({
  field,
  value,
  options,
  onChange,
}: {
  field: FieldSummary;
  value: unknown;
  options: { value: string; label: string }[];
  onChange: (value: unknown) => void;
}): ReactNode {
  const label = field.label;
  const required = field.isRequired;
  const text = value === null || value === undefined ? '' : String(value);

  switch (field.type) {
    case 'boolean':
      return (
        <Checkbox
          label={label}
          checked={value === true || value === 'true'}
          onChange={(event) => onChange(event.currentTarget.checked)}
        />
      );
    case 'number':
      return (
        <NumberInput
          label={label}
          required={required}
          value={text === '' ? '' : Number(text)}
          onChange={(next) => onChange(next)}
        />
      );
    case 'year':
      return (
        <NumberInput
          label={label}
          required={required}
          min={1000}
          max={9999}
          clampBehavior="none"
          value={text === '' ? '' : Number(text)}
          onChange={(next) => onChange(next)}
        />
      );
    case 'day':
      return (
        <NumberInput
          label={label}
          description="1-31; a day on its own is not checked against a month"
          required={required}
          min={1}
          max={31}
          clampBehavior="none"
          value={text === '' ? '' : Number(text)}
          onChange={(next) => onChange(next)}
        />
      );
    case 'month':
      return (
        <Select
          label={label}
          required={required}
          data={monthOptions}
          value={text || null}
          onChange={(next) => onChange(next ?? '')}
          clearable
        />
      );
    case 'dayOfWeek':
      return (
        <Select
          label={label}
          required={required}
          data={dayOfWeekOptions}
          value={text || null}
          onChange={(next) => onChange(next ?? '')}
          clearable
        />
      );
    case 'reference':
      return (
        <Select
          label={label}
          required={required}
          data={options}
          value={text || null}
          onChange={(next) => onChange(next ?? '')}
          placeholder="No record selected"
          searchable
          clearable
          nothingFoundMessage="No records you can see"
        />
      );
    case 'date':
      return (
        <TextInput
          label={label}
          required={required}
          type="date"
          value={text}
          onChange={(event) => onChange(event.currentTarget.value)}
        />
      );
    default:
      return (
        <TextInput
          label={label}
          required={required}
          value={text}
          onChange={(event) => onChange(event.currentTarget.value)}
        />
      );
  }
}
