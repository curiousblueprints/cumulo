/** Shapes the API hands back. Kept narrow: only what the client renders. */
export interface TableSummary {
  id: string;
  name: string;
  label: string;
}

export interface FieldSummary {
  id: string;
  name: string;
  label: string;
  type: string;
  isRequired: boolean;
  isSearchable: boolean;
  referenceTableId: string | null;
}

export interface RecordSummary {
  id: string;
  tableId: string;
  createdAt: string;
  updatedAt: string;
  values: Record<string, unknown>;
}

export interface Session {
  user: { id: string; username: string };
  role: { id: string; name: string; isAdministrator: boolean };
  csrfToken: string;
  tabs: TableSummary[];
}

export interface TableView {
  table: TableSummary;
  fields: FieldSummary[];
  creatableFields: string[];
  editableFields: string[];
  canCreate: boolean;
}

export interface RecordDetail {
  record: RecordSummary;
  table: TableSummary;
  fields: FieldSummary[];
  editableFields: string[];
}

export interface SearchHit {
  record: RecordSummary;
  table: TableSummary;
  /** The record's name, as the server worked it out from readable fields. */
  label: string;
  field: FieldSummary;
  value: string;
}

/** An error the API reported, carrying its status so callers can branch. */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

let csrfToken = '';

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: {
      accept: 'application/json',
      ...(init?.body ? { 'content-type': 'application/json' } : {}),
      ...(init?.method && init.method !== 'GET' ? { 'x-csrf-token': csrfToken } : {}),
      ...init?.headers,
    },
  });
  const text = await response.text();
  const payload: unknown = text ? JSON.parse(text) : {};
  if (!response.ok) {
    const message =
      payload && typeof payload === 'object' && 'error' in payload
        ? String((payload as { error: unknown }).error)
        : `Request failed (${response.status})`;
    throw new ApiError(message, response.status);
  }
  return payload as T;
}

export const api = {
  async session(): Promise<Session> {
    const session = await request<Session>('/api/v1/me');
    // Held here so every mutation carries it without each caller remembering.
    csrfToken = session.csrfToken;
    return session;
  },

  table(tableId: string): Promise<TableView> {
    return request<TableView>(`/api/v1/tables/${encodeURIComponent(tableId)}`);
  },

  records(tableId: string): Promise<{ records: RecordSummary[] }> {
    return request(`/api/v1/tables/${encodeURIComponent(tableId)}/records`);
  },

  record(recordId: string): Promise<RecordDetail> {
    return request<RecordDetail>(`/api/v1/records/${encodeURIComponent(recordId)}`);
  },

  createRecord(
    tableId: string,
    values: Record<string, unknown>,
  ): Promise<{ record: RecordSummary }> {
    return request(`/api/v1/tables/${encodeURIComponent(tableId)}/records`, {
      method: 'POST',
      body: JSON.stringify(values),
    });
  },

  updateRecord(
    recordId: string,
    values: Record<string, unknown>,
  ): Promise<{ record: RecordSummary }> {
    return request(`/api/v1/records/${encodeURIComponent(recordId)}`, {
      method: 'POST',
      body: JSON.stringify(values),
    });
  },

  deleteRecord(recordId: string): Promise<{ deleted: boolean }> {
    return request(`/api/v1/records/${encodeURIComponent(recordId)}/delete`, { method: 'POST' });
  },

  search(term: string): Promise<{ term: string; hits: SearchHit[] }> {
    return request(`/api/v1/search?q=${encodeURIComponent(term)}`);
  },
};
