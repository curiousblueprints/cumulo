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
   compiled with its clauses, its `canCreate` flag and its granted field ids,
   indexed by table.

The result is cached per role and dropped wholesale whenever metadata changes,
since permissions are derived from metadata. `SecurityLayer.asAdministrator`
invalidates on the way out; that is why a rule assigned to a role takes effect
for a user who is already signed in.

### Create is not a record-level grant

`AccessType` covers read, edit and delete, and all three are decided per record
by the rule's clauses. Creation cannot work that way -- there is no record to
test -- so it is a separate boolean on `securityRule`, checked by
`rulesGrantingCreate` with no clause evaluation at all. The rule's
`securityRuleField` grants still apply, and bound what a creator may set.

The consequence is worth stating plainly: a rule can grant creating records its
own clauses would not then cover, so a user can create a record and immediately
lose sight of it. That is intended -- "submit a case, see only your own" is one
rule, not two.

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

Empty values are handled naively rather than defensively. An absent `value` row
and an empty string are the same thing, and only equality stays meaningful
about one: two empty values are equal, an empty value differs from anything
else, so `field != x` matches records where the field is empty. Every other
operator needs two things to compare and is false without them. `isNull` and
`isNotNull` are how you ask about emptiness on purpose.

Clauses referencing a field that no longer exists evaluate to false rather than
throwing, so a deleted field narrows access instead of breaking the rule.

## Lookups

`FieldType.Reference` is the only relationship there is. A `value` row holds the
target record's id, and `field.referenceTableId` says which table that id must
be in. There is no master-detail, so no field owns another record's lifecycle.

Three things enforce that they behave like relationships rather than loose ids:

- **Resolution** (`assertLookupsResolve`) checks on every write that the target
  exists and belongs to the looked-up table.
- **Acyclicity** (`assertNoLookupCycle`) applies when a field's target table is
  its own table. It walks the chain upward from the proposed target; reaching
  the record being edited means the write would make it its own ancestor, and
  is refused. The walk carries a `seen` set, so a cycle that somehow already
  exists terminates instead of hanging.
- **Detachment on delete** (`MetadataStore.clearLookupsTo`) removes the `value`
  rows pointing at a deleted record, inside the same transaction as the delete.
  Emptying a lookup *is* deleting its value row, so this leaves the referencing
  records untouched. This is the system acting, not the user: it runs whether
  or not the caller could see the records being detached, because the
  alternative is a dangling id.

The UI resolves lookups through the security layer, so a picker only ever
offers records the user can read. A lookup whose current target the user cannot
read is kept as a selected option on the edit form, so saving does not silently
clear it.

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

## Schema evolution

`applySchema` creates missing tables and then adds any columns an existing
table lacks (`addMissingColumns`, via `PRAGMA table_info`). SQLite needs a
default when adding a NOT NULL column to a table that may hold rows, so each
column type has a zero value. That covers additive change, which is what has
been needed so far; renames, drops and type changes would need real migration
files and a version table.

## What is deliberately not built

- Editing and deleting metadata (only creation and a few guarded deletes exist)
- A query language over records; listing is table-scoped with a limit
- Packaging/installing a namespace as a unit
- Persistent sessions, password reset, multi-factor
- Field history, validation rules, triggers, formulas
