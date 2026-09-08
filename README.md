# Cumulo

A small re-implementation of the *force.com platform* core: metadata-defined
tables and fields, records stored against that metadata, and a role/rule
security layer that arbitrates every read and write.

This is the platform, not the CRM. There are no leads, accounts or
opportunities here -- only the machinery you would use to define them.

## Running it

### Docker (the supported way to run it)

```bash
docker compose up --build
# then open http://localhost:3000
```

The image needs no native build tooling and installs **zero runtime
dependencies**: SQLite comes from Node's built-in `node:sqlite` module, and the
front end -- React, Mantine, esbuild -- is compiled to two files during the
build and never installed into the runtime image. The database lives on the
`cumulo-data` volume at `/data/cumulo.db`, so an installation survives a
rebuild.

```bash
docker build -t cumulo .
docker run -p 3000:3000 -v cumulo-data:/data cumulo
```

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `3000` | Port to listen on |
| `HOST` | `0.0.0.0` | Interface to bind |
| `CUMULO_DATABASE_FILE` | `data/cumulo.db` (`/data/cumulo.db` in the image) | SQLite file |
| `CUMULO_ENABLE_NAMESPACE_CREATION` | off | Lets the console create namespaces. For testing: a namespace should arrive with a package. |

`GET /healthz` is a dependency-free liveness probe, and is what the image's
`HEALTHCHECK` calls.

### Locally

```bash
npm install     # build-time only; there are no runtime dependencies
npm run build   # compiles the server, then bundles the client
npm start       # http://localhost:3000
npm test
```

`npm run build:client` rebuilds just the front end, which is the loop you want
while working on it.

Node 22.13 or newer is required, for `node:sqlite`.

## First run

A fresh installation has one namespace (`std`), one security role
(`Administrator`) and no users, so every URL redirects to `/setup`. The first
user created there is locked to the Administrator role -- an installation
whose only user could not administer it would be stranded.

From `/setup` (the console, once signed in) an administrator can add roles,
users, tables, fields and security rules, delete fields, and see the role
hierarchy as a tree at `/admin/roles`. `/tables` is the data side: the tables the signed-in role
can reach, and the records within them that its rules allow.

Namespaces are not created here. They are meant to arrive with a package, so
the console only lists them; set `CUMULO_ENABLE_NAMESPACE_CREATION=true` to add
one by hand while testing.

## The two faces

The **user space** at `/app` is a React and [Mantine](https://mantine.dev)
client: a centred global search, a setup gear and an avatar at the far right,
and the role's tabs beneath. Who you are and signing out live behind the
avatar. `/app` itself sends you to your first tab -- there is no landing page
to read. It talks to a JSON API under `/api/v1`.

The **setup console** at `/admin` is server-rendered HTML. It has its own
frame on purpose -- nothing is shared between the two, so it is obvious at a
glance which one you are looking at.

## The layers

```
presentation  src/presentation   HTTP transport, router, sessions
              src/presentation/api    JSON API for the client
              src/presentation/web    server-rendered setup console
              src/client              React + Mantine user space
application   src/app            install, auth, metadata and record services
security      src/security       the arbiter: roles, rules, clauses, projection
database      src/db             DatabaseAdapter contract + the SQLite driver
```

Each layer only knows about the one below it.

**Database.** `DatabaseAdapter` (`src/db/types.ts`) is a small structured
row-store contract -- insert, update, delete, find with AND-ed filters,
transactions. `SqliteAdapter` is the only implementation today; adding
Postgres means writing one class and adding a case to `createDatabase`. No SQL
exists outside `src/db/sqlite/`.

**Security.** `SecurityLayer` holds the store privately, so nothing above it
can reach the database directly. Record operations are mediated method by
method; metadata mutations go through `asAdministrator`, which asserts the
acting role first.

**Application.** Services with the platform's logic: `InstallService`,
`AuthService`, `MetadataService`, `RecordService`. `Application` is the
composition root and the only place anything is wired together.

**Presentation.** A node:http transport, a segment router, cookie sessions,
and server-rendered HTML. The router is deliberately transport-shaped rather
than HTML-shaped: handlers take an `HttpRequest` and return an `HttpResponse`,
and `json()` sits next to `html()` in `src/presentation/http/types.ts`. A JSON
API is a second set of routes registered on the same router (see
[docs/architecture.md](docs/architecture.md#adding-the-json-api)), calling the
same application services.

## The data model

Platform metadata lives in real tables. Records in *custom* tables are stored
as `record` rows with one `value` row per populated field, which is what lets
tables be defined at runtime.

| Table | Holds |
| --- | --- |
| `namespace` | Package namespaces. `std` ships with every install. |
| `securityRole` | The role hierarchy. Administrator is the root. |
| `namespaceAccess` | Which roles may reach which non-`std` namespaces. |
| `users` | Users, each with exactly one security role. |
| `table` | Logical tables ("objects"), owned by a namespace. |
| `field` | Fields on a table, with a type and an owning namespace. |
| `securityRule` | Access types, create, and clause matching, for one table. |
| `securityRuleClause` | The predicates deciding which records a rule covers. |
| `securityRuleFieldGrant` | The fields a rule exposes when it applies, each read-only or editable. |
| `securityRoleRule` | Junction: this rule applies to this role. |
| `record` | One record in a custom table. |
| `value` | One field's value on one record. |

## How access is decided

1. **Administrator sees everything.** It has no rules and needs none.
2. **A role encompasses the roles beneath it.** A role's effective rules are
   its own plus every rule of every descendant. That is what makes
   Administrator -- the only role permitted no parent -- hold all access, and
   it is why custom roles are required to name a parent.
3. **Namespace first.** A table is invisible unless its namespace is reachable.
   Every role reaches `std`; anything else needs a `namespaceAccess` row.
4. **Then rules, per record.** A rule grants read/edit/delete on one table to
   the records satisfying its clauses (`all`, `any`, or custom logic such as
   `1 AND (2 OR 3)`).
5. **Then fields, separately.** A `securityRuleFieldGrant` says whether a rule
   exposes one field as **read-only** or as **editable**. This is set per field
   and is independent of what the rule allows on records: a rule granting read
   and edit can expose ten fields read-only and one editable. A record's
   visible fields are everything granted at either level by the rules that
   matched it; its writable fields are only those granted editable. A field no
   rule grants does not appear at all.

   The one constraint: **a field grant may not exceed its rule's access to the
   table.** Marking a field editable needs a rule that permits writing -- edit
   or create -- so a read-only rule can never make a field writable. That is
   checked when the rule is saved.

6. **Creating is separate, and table-level.** A rule's `canCreate` says whether
   it permits inserting into its table. The clauses play no part -- there is no
   record yet for them to describe -- but the rule's editable field grants
   still bound what a creator may set. So "may create, may only read back their
   own" is one rule.

7. **Default deny.** A role with no rules sees nothing.

A record outside your rules reports as *not found*, not *forbidden*, so record
ids cannot be probed.

Clause target values understand `$user.id`, `$user.username` and
`$user.securityRoleId`, which is how you write "records this user owns"
without hard-coding anyone.

## Fields

A table is created with exactly one field, **Name**, which is how a record is
referred to elsewhere -- it is what a lookup picker shows. It is either free
text or an **auto number**, chosen when the table is created, and it is a
system field: it cannot be deleted, so anything counting on a record having a
name can go on doing so.

A free-text Name is **required**, since nothing else will supply one. An auto
number is not: the platform fills it in, so requiring it would describe the
caller's duty rather than the field's. Two things follow from a required Name:

- A rule granting **create** on such a table must also grant Name as
  **editable**, or nobody holding that rule can create a record. The error says
  so rather than leaving you to work it out.
- Records that predate the requirement keep their empty name until something
  writes one. An update only checks the fields it is actually setting, so
  editing such a record's other fields is fine -- though the edit form will ask
  for a name, since Name is writable and required.

There is still no `Owner` or `CreatedBy`. Beyond Name, every record carries the
three columns on the `record` row itself -- `id`, `createdAt` and `updatedAt`.
Those are always returned and always visible, but they are not `field` rows, so
they cannot be granted and a rule clause cannot refer to them. Ownership is
therefore something you build: a field holding a user id, and a clause
comparing it to `$user.id`.

### Field types

| Type | Holds | Notes |
| --- | --- | --- |
| `text` | Free text | |
| `number` | Any number | |
| `boolean` | Yes or no | |
| `date` | `YYYY-MM-DD` | |
| `datetime` | An instant, stored ISO-8601 | |
| `reference` | A lookup to a record | See below |
| `autoNumber` | A sequential number | Assigned on create; nobody may set or edit one |
| `year` | A four-digit year | Digits only |
| `month` | A month, stored 1-12 | Chosen from the twelve months |
| `day` | A day of the month, stored 1-31 | Not checked against a month: a day on its own has no month to be too large for |
| `dayOfWeek` | A weekday, stored 1-7 | Sunday is 1 |

`month` and `dayOfWeek` are stored as numbers and shown as names. They compare
as numbers too, so "on or after October" means what it should -- as text, `2`
would sort after `10` and February would slip in.

An auto number is handed out inside the transaction that writes the record, so
the number and the record commit together. Each field counts on its own. It can
be granted read-only but never editable, since nobody can write one.

### Deleting a field

Fields can be deleted from a table's page in the console, which also removes
their values and their field grants. Two are refused:

- The **Name** field, which is a system field.
- A field a **security rule clause reads**. Dropping a clause from underneath a
  rule would silently widen what that rule matches, so the rule has to be dealt
  with first. The error names the rule.

## Tabs and global search

**Tabs** decide which tables a user sees along the top, and in what order --
and, since `/app` opens the first one, which table they land on. They are
configured per security role, on the role's page in setup, where the list runs
top to bottom and the first entry is the leftmost tab.

Tabs are the one thing in the model that is **not** inherited: unlike rules,
they neither roll up from child roles nor come down from a parent. What a role
puts on screen is its own decision. A tab whose table the role cannot actually
reach is simply not shown, so a tab left behind by a revoked rule stops
appearing rather than leading somewhere forbidden.

**Global search** looks at every table the user can reach. It always searches
Name fields; any other field can be marked **searchable** on its table's page
in setup, and matches on it will return the record too.

Results respect everything else: candidates are narrowed in storage, then each
one is loaded through the ordinary read path, so record-level clauses and field
grants decide what comes back. A field the user may not read cannot produce a
hit for them even when its value matches.

## Lookups

A field of type `reference` is a **lookup**: it points at a record in the table
the field names. There is no master-detail -- every relationship is a lookup,
and none of them owns anything.

- A lookup may point at its **own table**, which is how you build a hierarchy
  (`Department.parent`). Such a field cannot be required: the first record
  would have nothing to point at.
- Hierarchies stay acyclic. Setting a self-lookup walks the chain from the
  target, and a record that would become its own ancestor is refused.
- Writing a lookup checks that the target exists and lives in the table the
  field points at.
- **Deleting a looked-up record clears the lookups pointing at it and leaves
  those records alone.** Deleting a department detaches its children rather
  than deleting them; that difference is the whole of "lookup, not
  master-detail".
- In the UI a lookup renders as a picker of the records the user can actually
  read, and displays as a link through to its target.

## Tests

```bash
npm test
```

90 tests over the adapter, the clause-logic parser, the security layer
(hierarchy inheritance, record filtering, per-field grants and the ceiling over
them, namespace gating, metadata protection), lookups, tabs and global search,
the rename migration, and the HTTP surface end to end -- the setup console as
HTML, the user space through its JSON API.

## Assumptions and decisions

Recorded so they are easy to overturn:

- **Create is its own grant**, a `canCreate` flag on the rule, and it is
  table-level: a rule with clauses can grant creation of records those clauses
  would not then cover. A rule may grant create and nothing else.
- **Update checks the record as it stands**, not as it will stand. A permitted
  edit may therefore move a record out of your own visibility, the way
  transferring ownership does on a hierarchy-scoped platform.
- **"Some" clause matching is `custom`**, an expression over clause sequence
  numbers supporting `AND`, `OR`, `NOT` and parentheses.
- **Field access is a union** across every rule that matched the record, taking
  the widest grant on each field. Fields a user cannot write are never
  modified: an update naming one is refused rather than silently dropped, so
  the caller learns nothing was written.
- **Empty values are read literally.** An empty field is not equal to "x", so
  `field != x` matches it, and two empty values are equal to each other. The
  ordering and text operators have nothing to compare, so they are false. Ask
  about emptiness itself with `isNull` / `isNotNull`.
- **Security rules target custom tables only.** Platform metadata is not
  described as `table`/`field` rows, so only Administrator can change it.
- `applySchema` adds columns an existing database is missing, which is enough
  for additive changes. The one rename so far (`securityRuleField` ->
  `securityRuleFieldGrant`) is carried forward explicitly at install time, each
  old grant taking the level its own rule justifies.
- Sessions are in-memory, so restarting the server signs everyone out.
