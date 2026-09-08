import {
  Alert,
  Anchor,
  Badge,
  Button,
  Card,
  Center,
  Group,
  Loader,
  Stack,
  Table,
  Text,
  Title,
} from '@mantine/core';
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import {
  api,
  type FieldSummary,
  type RecordDetail,
  type RecordSummary,
  type SearchHit,
  type Session,
  type TableView,
} from './api';
import { RecordForm } from './RecordForm';
import type { Navigate } from './router';
import { displayValue } from './values';

/** Loads lookup targets so a reference field can be picked, not typed. */
async function loadLookups(
  fields: FieldSummary[],
): Promise<Map<string, { value: string; label: string }[]>> {
  const lookups = new Map<string, { value: string; label: string }[]>();
  for (const field of fields) {
    if (field.type !== 'reference' || !field.referenceTableId) continue;
    try {
      const [{ records }, view] = await Promise.all([
        api.records(field.referenceTableId),
        api.table(field.referenceTableId),
      ]);
      lookups.set(
        field.id,
        records.map((record) => ({
          value: record.id,
          label: recordLabel(record, view.fields),
        })),
      );
    } catch {
      // No access to the looked-up table: offer nothing rather than failing
      // the page. The security layer still refuses a typed id.
      lookups.set(field.id, []);
    }
  }
  return lookups;
}

/** A record's stand-in name: its Name, or the first value that will do. */
export function recordLabel(record: RecordSummary, fields: FieldSummary[]): string {
  const named = fields.find((field) => field.name === 'name');
  const ordered = named ? [named, ...fields.filter((field) => field !== named)] : fields;
  for (const field of ordered) {
    if (field.type === 'reference') continue;
    const value = record.values[field.name];
    if (value !== null && value !== undefined && String(value) !== '') {
      return displayValue(field, value);
    }
  }
  return record.id.slice(0, 8);
}

function Loading(): ReactNode {
  return (
    <Center py="xl">
      <Loader size="sm" />
    </Center>
  );
}

function Failed({ message }: { message: string }): ReactNode {
  return (
    <Alert color="red" title="That did not work" variant="light">
      {message}
    </Alert>
  );
}

/**
 * What /app shows when there is nowhere to send you. With tabs configured the
 * app lands on the first one instead, so this is the empty case only.
 */
export function NoTabsPage({ session }: { session: Session }): ReactNode {
  return (
    <Stack gap="xs" maw={620}>
      <Title order={2}>Nothing on your tabs yet</Title>
      <Text c="dimmed">
        Which tables appear along the top is set per security role, and the{' '}
        <strong>{session.role.name}</strong> role has none configured.
        {session.role.isAdministrator
          ? ' Add some under Setup, on the role.'
          : ' An administrator can add them under Setup.'}
      </Text>
    </Stack>
  );
}

export function TablePage({
  tableId,
  navigate,
}: {
  tableId: string;
  navigate: Navigate;
}): ReactNode {
  const [state, setState] = useState<
    { status: 'loading' } | { status: 'error'; message: string } | {
      status: 'ready';
      view: TableView;
      records: RecordSummary[];
    }
  >({ status: 'loading' });

  const load = useCallback(async () => {
    setState({ status: 'loading' });
    try {
      const [view, { records }] = await Promise.all([api.table(tableId), api.records(tableId)]);
      setState({ status: 'ready', view, records });
    } catch (error) {
      setState({ status: 'error', message: (error as Error).message });
    }
  }, [tableId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (state.status === 'loading') return <Loading />;
  if (state.status === 'error') return <Failed message={state.message} />;

  const { view, records } = state;
  return (
    <Stack gap="md">
      <Group justify="space-between" align="flex-end">
        <Stack gap={2}>
          <Title order={2}>{view.table.label}</Title>
          <Text size="sm" c="dimmed">
            {records.length} record{records.length === 1 ? '' : 's'} you can see
          </Text>
        </Stack>
        {view.canCreate && (
          <Button onClick={() => navigate({ kind: 'new', tableId })}>New {view.table.label}</Button>
        )}
      </Group>

      <Card withBorder padding={0} radius="md">
        <Table.ScrollContainer minWidth={480}>
          <Table highlightOnHover verticalSpacing="sm">
            <Table.Thead>
              <Table.Tr>
                {view.fields.map((field) => (
                  <Table.Th key={field.id}>{field.label}</Table.Th>
                ))}
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {records.map((record) => (
                <Table.Tr
                  key={record.id}
                  style={{ cursor: 'pointer' }}
                  onClick={() => navigate({ kind: 'record', recordId: record.id })}
                >
                  {view.fields.map((field, index) => (
                    <Table.Td key={field.id}>
                      {index === 0 ? (
                        <Anchor
                          href={`/app/records/${record.id}`}
                          onClick={(event) => {
                            event.preventDefault();
                            navigate({ kind: 'record', recordId: record.id });
                          }}
                        >
                          {displayValue(field, record.values[field.name]) || '(untitled)'}
                        </Anchor>
                      ) : (
                        displayValue(field, record.values[field.name])
                      )}
                    </Table.Td>
                  ))}
                </Table.Tr>
              ))}
              {records.length === 0 && (
                <Table.Tr>
                  <Table.Td colSpan={Math.max(1, view.fields.length)}>
                    <Text c="dimmed" size="sm">
                      Nothing to show.
                    </Text>
                  </Table.Td>
                </Table.Tr>
              )}
            </Table.Tbody>
          </Table>
        </Table.ScrollContainer>
      </Card>
    </Stack>
  );
}

export function NewRecordPage({
  tableId,
  navigate,
}: {
  tableId: string;
  navigate: Navigate;
}): ReactNode {
  const [view, setView] = useState<TableView | null>(null);
  const [lookups, setLookups] = useState(new Map<string, { value: string; label: string }[]>());
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void (async () => {
      try {
        const loaded = await api.table(tableId);
        setView(loaded);
        setLookups(await loadLookups(loaded.fields));
      } catch (caught) {
        setError((caught as Error).message);
      }
    })();
  }, [tableId]);

  if (error && !view) return <Failed message={error} />;
  if (!view) return <Loading />;

  return (
    <Stack gap="md" maw={620}>
      <Title order={2}>New {view.table.label}</Title>
      {error && <Failed message={error} />}
      <Card withBorder radius="md" padding="lg">
        <RecordForm
          fields={view.fields}
          writable={view.creatableFields}
          lookups={lookups}
          submitLabel="Create"
          busy={busy}
          onCancel={() => navigate({ kind: 'table', tableId })}
          onSubmit={(values) => {
            setBusy(true);
            setError(null);
            void api
              .createRecord(tableId, values)
              .then(({ record }) => navigate({ kind: 'record', recordId: record.id }))
              .catch((caught: Error) => setError(caught.message))
              .finally(() => setBusy(false));
          }}
        />
      </Card>
    </Stack>
  );
}

export function RecordPage({
  recordId,
  navigate,
}: {
  recordId: string;
  navigate: Navigate;
}): ReactNode {
  const [detail, setDetail] = useState<RecordDetail | null>(null);
  const [lookups, setLookups] = useState(new Map<string, { value: string; label: string }[]>());
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const loaded = await api.record(recordId);
      setDetail(loaded);
      setLookups(await loadLookups(loaded.fields));
    } catch (caught) {
      setLoadError((caught as Error).message);
    }
  }, [recordId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (loadError) return <Failed message={loadError} />;
  if (!detail) return <Loading />;

  const { record, table, fields, editableFields } = detail;
  const mayEdit = editableFields.length > 0;

  return (
    <Stack gap="md" maw={720}>
      <Group justify="space-between" align="flex-end">
        <Stack gap={2}>
          <Text size="sm" c="dimmed">
            <Anchor
              href={`/app/tables/${table.id}`}
              onClick={(event) => {
                event.preventDefault();
                navigate({ kind: 'table', tableId: table.id });
              }}
            >
              {table.label}
            </Anchor>
          </Text>
          <Title order={2}>{recordLabel(record, fields)}</Title>
        </Stack>
        <Group gap="xs">
          {mayEdit && !editing && <Button onClick={() => setEditing(true)}>Edit</Button>}
          {mayEdit && (
            <Button
              color="red"
              variant="light"
              onClick={() => {
                setBusy(true);
                void api
                  .deleteRecord(record.id)
                  .then(() => navigate({ kind: 'table', tableId: table.id }))
                  .catch((caught: Error) => setError(caught.message))
                  .finally(() => setBusy(false));
              }}
            >
              Delete
            </Button>
          )}
        </Group>
      </Group>

      {error && <Failed message={error} />}

      <Card withBorder radius="md" padding="lg">
        {editing ? (
          <RecordForm
            fields={fields}
            writable={editableFields}
            record={record}
            lookups={lookups}
            submitLabel="Save"
            busy={busy}
            onCancel={() => setEditing(false)}
            onSubmit={(values) => {
              setBusy(true);
              setError(null);
              void api
                .updateRecord(record.id, values)
                .then(() => {
                  setEditing(false);
                  return load();
                })
                .catch((caught: Error) => setError(caught.message))
                .finally(() => setBusy(false));
            }}
          />
        ) : (
          <Table variant="vertical" layout="fixed" withRowBorders={false}>
            <Table.Tbody>
              {fields.map((field) => (
                <Table.Tr key={field.id}>
                  <Table.Th w={200}>{field.label}</Table.Th>
                  <Table.Td>
                    {field.type === 'reference' && record.values[field.name] ? (
                      <Anchor
                        href={`/app/records/${String(record.values[field.name])}`}
                        onClick={(event) => {
                          event.preventDefault();
                          navigate({
                            kind: 'record',
                            recordId: String(record.values[field.name]),
                          });
                        }}
                      >
                        {lookupLabel(lookups, field.id, String(record.values[field.name]))}
                      </Anchor>
                    ) : (
                      displayValue(field, record.values[field.name])
                    )}
                  </Table.Td>
                </Table.Tr>
              ))}
              <Table.Tr>
                <Table.Th>Created</Table.Th>
                <Table.Td>{record.createdAt}</Table.Td>
              </Table.Tr>
              <Table.Tr>
                <Table.Th>Updated</Table.Th>
                <Table.Td>{record.updatedAt}</Table.Td>
              </Table.Tr>
            </Table.Tbody>
          </Table>
        )}
      </Card>
    </Stack>
  );
}

function lookupLabel(
  lookups: Map<string, { value: string; label: string }[]>,
  fieldId: string,
  id: string,
): string {
  return lookups.get(fieldId)?.find((option) => option.value === id)?.label ?? id.slice(0, 8);
}

export function SearchPage({ term, navigate }: { term: string; navigate: Navigate }): ReactNode {
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setHits(null);
    setError(null);
    void api
      .search(term)
      .then((result) => setHits(result.hits))
      .catch((caught: Error) => setError(caught.message));
  }, [term]);

  if (error) return <Failed message={error} />;

  return (
    <Stack gap="md" maw={780}>
      <Stack gap={2}>
        <Title order={2}>Search</Title>
        <Text size="sm" c="dimmed">
          {hits === null
            ? `Searching for "${term}"`
            : `${hits.length} result${hits.length === 1 ? '' : 's'} for "${term}"`}
        </Text>
      </Stack>

      {hits === null ? (
        <Loading />
      ) : hits.length === 0 ? (
        <Card withBorder radius="md" padding="lg">
          <Text c="dimmed" size="sm">
            Nothing matched. Global search looks at every Name, and any other field marked
            searchable in Setup.
          </Text>
        </Card>
      ) : (
        <Stack gap="xs">
          {hits.map((hit) => (
            <Card
              key={`${hit.record.id}-${hit.field.id}`}
              withBorder
              radius="md"
              padding="md"
              style={{ cursor: 'pointer' }}
              onClick={() => navigate({ kind: 'record', recordId: hit.record.id })}
            >
              <Group justify="space-between" wrap="nowrap" align="flex-start">
                <Stack gap={2}>
                  <Anchor
                    href={`/app/records/${hit.record.id}`}
                    onClick={(event) => {
                      event.preventDefault();
                      navigate({ kind: 'record', recordId: hit.record.id });
                    }}
                    fw={600}
                  >
                    {hit.label}
                  </Anchor>
                  <Text size="sm" c="dimmed">
                    matched {hit.field.label}: {hit.value}
                  </Text>
                </Stack>
                <Badge variant="light">{hit.table.label}</Badge>
              </Group>
            </Card>
          ))}
        </Stack>
      )}
    </Stack>
  );
}
