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
dependencies**: SQLite comes from Node's built-in `node:sqlite` module. The
database lives on the `cumulo-data` volume at `/data/cumulo.db`, so an
installation survives a rebuild.

```bash
docker build -t cumulo .
docker run -p 3000:3000 -v cumulo-data:/data cumulo
```

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `3000` | Port to listen on |
| `HOST` | `0.0.0.0` | Interface to bind |
| `CUMULO_DATABASE_FILE` | `data/cumulo.db` (`/data/cumulo.db` in the image) | SQLite file |

`GET /healthz` is a dependency-free liveness probe, and is what the image's
`HEALTHCHECK` calls.

### Locally

```bash
npm install     # TypeScript only; there are no runtime dependencies
npm run build
npm start       # http://localhost:3000
npm test
```

Node 22.13 or newer is required, for `node:sqlite`.

## First run

A fresh installation has one namespace (`std`), one security role
(`Administrator`) and no users, so every URL redirects to `/setup`. The first
user created there is locked to the Administrator role -- an installation
whose only user could not administer it would be stranded.

From `/setup` (the console, once signed in) an administrator can add
namespaces, roles, users, tables, fields and security rules. `/tables` is the
data side: the tables the signed-in role can reach, and the records within them
that its rules allow.

## The layers

```
presentation  src/presentation   HTTP transport, router, sessions, HTML pages
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
| `securityRule` | Access types + clause matching, for one table. |
| `securityRuleClause` | The predicates deciding which records a rule covers. |
| `securityRuleField` | The fields a rule grants when it applies. |
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
5. **Then fields.** A record's visible fields are the union of the fields
   named by the rules that matched it. A field no rule grants does not appear
   in the response at all.
6. **Default deny.** A role with no rules sees nothing.

A record outside your rules reports as *not found*, not *forbidden*, so record
ids cannot be probed.

Clause target values understand `$user.id`, `$user.username` and
`$user.securityRoleId`, which is how you write "records this user owns"
without hard-coding anyone.

## Tests

```bash
npm test
```

38 tests over the adapter, the clause-logic parser, the security layer
(hierarchy inheritance, record and field filtering, namespace gating, metadata
protection) and the HTTP surface end to end.

## Assumptions and decisions

Recorded so they are easy to overturn:

- **Create is governed by EDIT.** Access types are read/edit/delete, so a role
  that may edit a table may create in it -- and the clauses are checked against
  the record as it would be written, so you cannot create a record you would
  not then be allowed to edit.
- **Update checks the record as it stands**, not as it will stand. A permitted
  edit may therefore move a record out of your own visibility, the way
  transferring ownership does on a hierarchy-scoped platform.
- **"Some" clause matching is `custom`**, an expression over clause sequence
  numbers supporting `AND`, `OR`, `NOT` and parentheses.
- **Field access is a union** across every rule that matched the record.
- **Nulls fail closed.** An empty field satisfies only `isNull`; `field != x`
  does not match records where the field is empty.
- **Security rules target custom tables only.** Platform metadata is not
  described as `table`/`field` rows, so only Administrator can change it.
- Sessions are in-memory, so restarting the server signs everyone out.
