# Architecture notes

Detail that would crowd the README. Start there for the overview.

## Layer boundaries, concretely

```
main.ts
  └─ Application            composition root; the only place things are wired
       ├─ SecurityLayer     holds MetadataStore privately
       │    └─ MetadataStore ──> DatabaseAdapter ──> SqliteAdapter
       ├─ InstallService    schema + std namespace + Administrator + first user
       ├─ AuthService       credentials -> SecurityContext
       ├─ MetadataService   admin-only metadata mutations
       └─ RecordService     record CRUD
  └─ createServer           router, sessions, HTML routes
```

Two seams are load-bearing:

**`DatabaseAdapter`** is the storage seam. It speaks rows and structured
filters, never SQL. Anything richer than AND-ed comparisons belongs in the
security or application layer, where it stays portable. `Row` values are
`string | number | boolean | null`; the adapter coerces booleans, which SQLite
has no type for.

**`SecurityLayer`** is the access seam. `MetadataStore` is passed into its
constructor and never exposed. `RecordService` and `MetadataService` hold a
`SecurityLayer`, not a store, so there is no path from the application layer
to the database that skips a check.

`InstallService` and `AuthService` are the two deliberate exceptions, and both
run before there is a user to check anything against: one creates the
installation, the other turns credentials into the `SecurityContext` every
other call requires.

## Permission resolution

`PermissionResolver` turns a `SecurityContext` into a `PermissionSet`:

1. **Role closure** -- the acting role plus every descendant, breadth-first.
   Access flows *up* the hierarchy: a manager encompasses their reports.
2. **Administrator short-circuit** -- `isSystem` means everything, with no rule
   lookup at all.
3. **Namespaces** -- `std` plus every `namespaceAccess` row for any role in the
   closure.
4. **Rules** -- every `securityRule` linked to any role in the closure, each
   compiled with its clauses and granted field ids, indexed by table.

The result is cached per role and dropped wholesale whenever metadata changes,
since permissions are derived from metadata. `SecurityLayer.asAdministrator`
invalidates on the way out; that is why a rule assigned to a role takes effect
for a user who is already signed in.

### Evaluating a rule against a record

A rule with no clauses covers every record in its table. Otherwise each clause
is evaluated to a boolean, keyed by its sequence number, and combined by the
rule's `clauseMatch`:

- `all` -- every clause true
- `any` -- at least one true
- `custom` -- `clauseLogic` evaluated over the sequence numbers, e.g.
  `1 OR (2 AND NOT 3)`

Clause logic is parsed by a recursive-descent parser (`clauseLogic.ts`) with
`AND` binding tighter than `OR`. It is validated when the rule is saved, so a
typo fails at authoring time rather than silently widening access.

Comparisons are typed by the *left* field: `number` compares numerically,
everything else as text -- which is why dates are stored ISO-8601, so they sort
correctly as strings. A clause may compare a field to a literal, to a context
token (`$user.id`, `$user.username`, `$user.securityRoleId`), or to another
field of the same record.

Clauses referencing a field that no longer exists evaluate to false rather than
throwing, so a deleted field narrows access instead of breaking the rule.

## Projection

`SecurityLayer.project` builds the caller's view of a record. Fields outside
the union of the matching rules' grants are omitted from `values` entirely --
not nulled, not empty-stringed. A caller cannot tell a field they may not read
from one that does not exist.

## Storage shape

Platform metadata is stored in ordinary tables. Custom-table records are
stored vertically:

```
record   (id, tableId, createdAt, updatedAt)
value    (id, recordId, fieldId, value)      unique (recordId, fieldId)
```

One row per populated field. Absent rows mean null, so adding a field to a
table with a million records costs nothing.

The trade-off is that filtering by field value means joining `value` per
predicate. Nothing in the current feature set does that -- clause evaluation
loads a record's values and evaluates in memory -- but a query language over
records would want either a pivot or a per-table physical projection. The
`DatabaseAdapter` seam is where that would go.

`value.value` is TEXT for every field type. `src/security/values.ts` owns the
coercion in both directions and is the single place to change if a type needs a
different storage form.

## Adding the JSON API

The transport already returns `HttpResponse` objects and `json()` sits beside
`html()` in `src/presentation/http/types.ts`. To add the API:

1. Write `src/presentation/api/routes.ts` registering `/api/v1/...` routes on
   the same `Router`, calling the same application services.
2. Register it in `buildRouter` next to `registerWebRoutes`.
3. Authenticate with a token rather than a cookie: resolve it to a
   `SecurityContext` in `server.ts` where the session is resolved today, and
   skip the CSRF check for token-authenticated requests (it exists to protect
   cookie-authenticated form posts).
4. Map errors with `statusFor`, which already translates the security layer's
   error vocabulary into status codes.

The JSON body parser is already in place, including repeated keys, so a
request body of `{"accessTypes": ["read", "edit"]}` arrives the same shape as
the equivalent multi-select.

## What is deliberately not built

- Editing and deleting metadata (only creation and a few guarded deletes exist)
- A query language over records; listing is table-scoped with a limit
- Packaging/installing a namespace as a unit
- Persistent sessions, password reset, multi-factor
- Field history, validation rules, triggers, formulas
