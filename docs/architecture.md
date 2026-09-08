# Architecture notes

Detail that would crowd the README. Start there for the overview.

## Two presentations, one security layer

The user space is a React and Mantine client under `/app`; the setup console is
server-rendered HTML under `/admin`. They share no markup, which is deliberate
-- an administrator should never have to work out which one they are in.

What they do share is everything below the transport. `src/presentation/api`
calls the same `MetadataService` and `RecordService` that the HTML pages call,
so the security layer is still the only route to the data and there is no
second, laxer path for the client to take.

Both are served by the same `Router`. `registerApiRoutes` and
`registerWebRoutes` register on one instance, which is why the API needed no
new plumbing -- `HttpResponse` and `json()` were already there.

**Session and CSRF.** The client authenticates with the same cookie as the
pages. Cookies alone would let another origin post, so mutating API calls carry
the session's CSRF token in an `x-csrf-token` header; `/api/v1/me` hands the
client that token along with its identity. The HTML forms keep their hidden
field. Errors on `/api/` paths come back as JSON rather than as a plain-text
page, since that is what the client can read.

**The bundle.** `scripts/build-client.mjs` runs esbuild over `src/client`,
inlining React, Mantine and Mantine's stylesheet into `dist/public/app.js` and
`app.css`. React, Mantine and esbuild are devDependencies: they exist at build
time and are compiled away, so the runtime image still installs nothing and the
page loads no third-party origin. The output goes under `dist` so the
Dockerfile's single `COPY --from=build /app/dist` carries the server, the
compiled tests and the client together.

`/assets/*` is served by `serveStaticFile`, which resolves the path and checks
it is inside the root before opening anything, so `../` in a URL cannot walk
out of the directory.

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
   compiled with its clauses, its `canCreate` flag and its field grants as a
   `Map<fieldId, FieldAccess>`, indexed by table.

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

## Two dimensions: the table and its fields

A `securityRule` belongs to one table and answers questions about that table:

- **Records** -- may this role read, edit or delete records of it? Those are the
  rule's `accessTypes`, and the clauses narrow *which* records each applies to.
- **Creating** -- may this role make new records in it? That is `canCreate`,
  and it is table-wide: there is no record yet for the clauses to describe.

A `securityRuleFieldGrant` belongs to one rule and answers a question about a
field of that same table: may this role read it, or read and write it?

These are independent. The rule does not dictate the level of its grants, and a
grant does not widen the rule. A rule granting read and edit on its records may
expose ten fields read-only and one editable, or every field read-only, or none
at all. The only thing connecting them is a ceiling:

> **A field grant may not exceed its rule's access to the table.** An editable
> grant needs a rule that permits writing -- edit or create. A rule that only
> reads, or only deletes, cannot make any field writable.

That is checked when the rule is authored, so an impossible pairing never
reaches storage, and it is what the enforcement below relies on.

Nothing here concerns access *to rules*. Rules, roles and the rest of the
metadata are administrative: only Administrator reads or writes them, and no
role is ever granted access to them.

### How enforcement uses the two

Each operation picks the rules that permit it, then asks their grants for the
level it needs. `grantedFieldIds(rules, level)` is the only helper involved;
edit implies read, so asking for read returns every granted field and asking
for edit returns the writable subset.

```
read a record    rules granting read, whose clauses match it   -> read grants
update a record  rules granting edit, whose clauses match it   -> edit grants
create a record  rules with canCreate (clauses do not apply)   -> edit grants
delete a record  rules granting delete, whose clauses match it -> no fields
```

Deleting takes a record whole, so no grant is consulted for it.

Because the ceiling holds, the second column can never over-grant: a rule that
reaches the "edit grants" column is one that permits writing, so its editable
grants were legitimate when they were written.

Two smaller rules keep authoring honest. A grant with no level stated is
read-only, since writable is the wider claim. And when a rule names the same
field twice, the wider grant wins, so a duplicate cannot quietly narrow access.

## Projection

`SecurityLayer.project` builds the caller's view of a record. Fields outside
the read-level union of the matching rules' grants are omitted from `values`
entirely -- not nulled, not empty-stringed. A caller cannot tell a field they
may not read from one that does not exist.

The view returned by a create or update shows the caller's *readable* fields,
which is wider than what they just wrote: a read-only grant means you see the
field you were not allowed to set.

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

## Tabs

`securityRoleTab` is a row per (role, table) with a `position`. It is the one
thing in the model that is not inherited, and that is a decision rather than an
omission: rules answer "what may this role reach", which genuinely rolls up a
hierarchy, while tabs answer "what should this role look at first", which does
not. A manager inheriting every tab their reports have would end up with a bar
nobody designed.

`SecurityLayer.listTabs` intersects the role's tabs with the tables it can
actually reach, so a tab is dropped rather than shown broken when the rule
behind it goes away. Ordering is kept dense (0..n-1) on every add, move and
remove, so a later move is predictable.

## Global search

`SecurityLayer.search` runs in two stages, and the split is the point.

Storage narrows first: `findRecordIdsMatching` does a `LIKE` over `value` rows
whose `fieldId` is both searchable and readable by this caller. Scanning every
value in the application would not survive a real data set.

The security layer then decides, by loading each candidate through
`getRecord` -- the ordinary read path, clauses and all. So a record the caller
may not see is dropped even though storage matched it, and a field they may not
read never becomes a hit, because it is not in the projection to match against.
The candidate list is a hint; it is never the answer.

Two details worth keeping. `%` and `_` are escaped and the SQL carries
`ESCAPE '\'`, so a search for "50%" means "50%" rather than "everything".
And the hit's display label is computed here, not in the client, because only
this layer knows which fields the caller may read to build one from.

## Opening the API to machines

The API exists, but it authenticates the way a browser does. To let a script or
another service use it:

1. Add a token store and resolve a bearer token to a `SecurityContext` in
   `server.ts`, where the session cookie is resolved today.
2. Skip the CSRF check for token-authenticated requests. It exists to protect
   cookie-authenticated calls; a bearer token is not sent automatically by a
   browser, so there is nothing to forge.

Nothing else needs to change: the routes already speak JSON, and `statusFor`
already maps the security layer's vocabulary onto status codes.

## Schema evolution

`applySchema` creates missing tables and then adds any columns an existing
table lacks (`addMissingColumns`, via `PRAGMA table_info`). SQLite needs a
default when adding a NOT NULL column to a table that may hold rows, so each
column type has a zero value.

**That zero value is the trap.** A new column arrives holding false, 0 or the
empty string, which is not always what the code that added the column would
have written. An upgraded installation then behaves differently from a fresh
one, silently, in a way no test that builds its fixtures with current code will
ever see. It has caught this project twice:

- `securityRuleFieldGrant.access` arrived empty, where a carried-forward grant
  should have taken the level its rule justified.
- `field.isSearchable` arrived false, including on Name fields, which are
  searchable from creation. Since global search looks at Name by default, that
  turned search off completely on every upgraded installation. Search no longer
  trusts that column for Name at all -- see **Global search** -- so the
  migration now only keeps the stored data honest rather than being what makes
  search work.

So `install()` runs a **migration ledger**: an ordered list of one-time data
migrations, each recorded in `schemaMigration` once it has run.

Running once is the point, and it is a stronger requirement than idempotence.
Each of these migrations could be re-run without corrupting anything, but
re-running would overwrite whatever an administrator has decided since -- turn
Name search off and a restart would turn it back on. The ledger is what makes
"put this right for installations that predate the column" different from
"enforce this on every boot".

Two rules for adding one. Ids are permanent: renaming one runs it again. And a
migration should set what the code would have set at creation, not something
convenient -- the second bug above came from stamping every carried-forward
grant `edit` rather than asking each rule what it allowed.

## The Name field, and what is still missing

`createTable` seeds one `field` row: `name`, marked `isSystem`, either text or
an auto number. Being a real field rather than a special case means it is
granted, filtered and compared like any other -- the only thing special about
it is that `deleteField` refuses to remove it.

A text Name is `isRequired`; an auto number is not, since the platform supplies
it. Required plus field-level security has a consequence worth stating: a role
that may create records on such a table must be granted Name as editable, or it
can never satisfy the requirement. `assertRequiredPresent` detects exactly that
case -- required, absent, and not writable by this caller -- and says so, since
"name is required" on its own sends an administrator looking at the wrong
thing.

`record` still carries `id`, `createdAt` and `updatedAt` as columns that
`project()` always includes. Those are not `field` rows: they have no grant and
`SecurityRuleClause.fieldId` cannot point at them.

There is deliberately no `ownerId`, `createdById` or `lastModifiedById`. Adding
them is not just more seeding -- ownership decides who sees what, so it is a
security question, and audit fields need a notion of "written by the platform,
never by a caller" that only auto numbers have so far. Until that is decided,
ownership is modelled by hand: a field holding a user id, and a clause
comparing it to `$user.id`.

### System-assigned values

`SYSTEM_ASSIGNED_FIELD_TYPES` is the list of types the platform fills in;
`autoNumber` is the only member today. Three things follow from membership, and
adding audit fields later would reuse all three:

- `toStoredValue` refuses any incoming value, so a caller cannot set one.
- `grantedFields` filters them out of what may be written, administrator
  included -- there is no role that can edit one.
- Rule authoring refuses to grant one as editable, since nothing could act on
  it.

`takeNextAutoNumber` reads the counter off the `field` row and writes it back
incremented, inside the transaction that inserts the record. Two processes
writing the same table would need that read-and-increment to be atomic in the
database rather than in the adapter; today's single process does not.

## Permission before validation

`createRecord` and `updateRecord` both settle permission first and validate the
input afterwards. The order matters for what a refusal reveals.

Validating first would answer a caller with no create access with `Field "name"
is required` -- which is the wrong answer to their question, and describes a
table they were never allowed to see. Worse, as required fields accumulate the
message becomes a readable sketch of a table's shape, handed to exactly the
people who cannot read it.

So the sequence in both is: resolve permissions, decide whether the operation
is allowed at all, work out the writable field set, and only then normalise,
check field-level permission, check required fields, and resolve lookups. A
caller who may not act gets one answer -- denied, or not found -- and learns
nothing else.

Update checks required-ness only over the fields in the patch. A required field
the caller is not touching keeps whatever it has, which is what lets records
written before a field became required go on being edited.

## Deleting a field

`deleteField` leans on the schema's cascades for `value` and
`securityRuleFieldGrant`: losing a value or a grant only ever narrows what is
visible, so cascading is safe.

`securityRuleClause` also cascades, and that is exactly why deletion refuses to
proceed when a clause reads the field. Consider a rule matching `all` of two
clauses. Drop one and the rule now matches on the strength of the other alone,
so a deletion aimed at a column would quietly widen who can see records. The
same reasoning covers custom clause logic, which would be left referring to a
sequence number that no longer exists.

So the rule has to be dealt with first, and the error names it. The alternative
-- deleting the rule along with the field -- trades a loud failure for a silent
change to the security model, which is the wrong way round.

## What is deliberately not built

- A Mantine setup console; `/admin` is still server-rendered HTML
- Ownership and audit fields (`ownerId`, `createdById`, `lastModifiedById`)
- Editing a field: changing its type, label or whether it is required
- Editing and deleting metadata (only creation and a few guarded deletes exist)
- A query language over records; listing is table-scoped with a limit
- Packaging/installing a namespace as a unit
- Persistent sessions, password reset, multi-factor
- Field history, validation rules, triggers, formulas
