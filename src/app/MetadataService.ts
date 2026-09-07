import {
  ADMINISTRATOR_ROLE,
  AccessType,
  ALL_ACCESS_TYPES,
  ClauseMatch,
  ClauseOperator,
  FieldAccess,
  FieldType,
  NAME_FIELD,
  SYSTEM_ASSIGNED_FIELD_TYPES,
  type NameFieldType,
  UNARY_OPERATORS,
  type FieldDef,
  type Id,
  type Namespace,
  type NamespaceAccess,
  type SecurityRole,
  type SecurityRoleRule,
  type SecurityRule,
  type SecurityRuleClause,
  type SecurityRuleFieldGrant,
  type TableDef,
  type User,
} from '../domain/types.js';
import { validateClauseLogic } from '../security/clauseLogic.js';
import type { SecurityContext } from '../security/context.js';
import { ValidationError } from '../security/errors.js';
import type { SecurityLayer } from '../security/SecurityLayer.js';
import type { MetadataStore } from '../store/MetadataStore.js';
import { isValidApiName, newId, nowIso } from '../util/index.js';
import { hashPassword } from './passwords.js';

export interface ClauseInput {
  fieldId: Id;
  operator: ClauseOperator;
  targetValue?: string | null;
  compareFieldId?: Id | null;
}

/**
 * A field this rule exposes, and how far. `access` defaults to read-only:
 * making a field writable is the wider claim, so it has to be asked for.
 */
export interface FieldGrantInput {
  fieldId: Id;
  access?: FieldAccess;
}

export interface SecurityRuleInput {
  name: string;
  tableId: Id;
  /** Record-level grants: read, edit, delete. May be empty for create-only. */
  accessTypes: AccessType[];
  /** Table-level grant: may records be created in this table? */
  canCreate?: boolean;
  clauseMatch?: ClauseMatch;
  clauseLogic?: string | null;
  clauses?: ClauseInput[];
  /** Fields the rule exposes when it applies, each with its own access. */
  fieldGrants?: FieldGrantInput[];
}

/**
 * The outcome of a grant that is safe to repeat: `created` is false when the
 * grant was already there, so the caller can say so rather than claiming to
 * have done something.
 */
export interface GrantResult<T> {
  record: T;
  created: boolean;
}

/** A rule plus what it exposes, for display. */
export interface RuleDescription {
  rule: SecurityRule;
  grants: { field: string; access: FieldAccess }[];
}

export interface UserInput {
  username: string;
  email: string;
  password: string;
  securityRoleId: Id;
}

/**
 * Administrative operations on platform metadata.
 *
 * Every method funnels through `SecurityLayer.asAdministrator`, so the
 * security layer stays the only door to the store.
 */
export class MetadataService {
  constructor(private readonly security: SecurityLayer) {}

  // --- namespaces --------------------------------------------------------

  async createNamespace(
    context: SecurityContext,
    input: { name: string; label?: string },
  ): Promise<Namespace> {
    return this.security.asAdministrator(context, async (store) => {
      const name = input.name.trim();
      assertApiName(name, 'Namespace name');
      if (await store.getNamespaceByName(name)) {
        throw new ValidationError(`A namespace named "${name}" already exists`);
      }
      const namespace: Namespace = {
        id: newId(),
        name,
        label: input.label?.trim() || name,
        isSystem: false,
        createdAt: nowIso(),
      };
      return store.insertNamespace(namespace);
    });
  }

  // --- security roles ----------------------------------------------------

  /**
   * Every custom role must name a parent, which is what keeps Administrator
   * at the top of the tree and therefore in possession of all access.
   */
  async createSecurityRole(
    context: SecurityContext,
    input: { name: string; parentId: Id },
  ): Promise<SecurityRole> {
    return this.security.asAdministrator(context, async (store) => {
      const name = input.name.trim();
      if (name.length === 0) throw new ValidationError('Role name is required');
      if (name === ADMINISTRATOR_ROLE) {
        throw new ValidationError(`"${ADMINISTRATOR_ROLE}" is reserved`);
      }
      if (await store.getSecurityRoleByName(name)) {
        throw new ValidationError(`A role named "${name}" already exists`);
      }
      if (!input.parentId) {
        throw new ValidationError('A parent role is required');
      }
      const parent = await store.getSecurityRole(input.parentId);
      if (!parent) throw new ValidationError('Parent role does not exist');

      const role: SecurityRole = {
        id: newId(),
        name,
        parentId: parent.id,
        isSystem: false,
        createdAt: nowIso(),
      };
      return store.insertSecurityRole(role);
    });
  }

  async deleteSecurityRole(context: SecurityContext, roleId: Id): Promise<void> {
    await this.security.asAdministrator(context, async (store) => {
      const role = await store.getSecurityRole(roleId);
      if (!role) throw new ValidationError('Role does not exist');
      if (role.isSystem) {
        throw new ValidationError(`The ${ADMINISTRATOR_ROLE} role cannot be modified or deleted`);
      }
      if ((await store.listChildRoles(role.id)).length > 0) {
        throw new ValidationError('Reassign or remove child roles first');
      }
      const users = await store.listUsers();
      if (users.some((user) => user.securityRoleId === role.id)) {
        throw new ValidationError('Reassign the users holding this role first');
      }
      await store.deleteSecurityRole(role.id);
    });
  }

  async grantNamespaceAccess(
    context: SecurityContext,
    roleId: Id,
    namespaceId: Id,
  ): Promise<GrantResult<NamespaceAccess>> {
    return this.security.asAdministrator(context, async (store) => {
      const role = await store.getSecurityRole(roleId);
      if (!role) throw new ValidationError('Role does not exist');
      if (role.isSystem) {
        throw new ValidationError(
          `The ${ADMINISTRATOR_ROLE} role already has access to every namespace`,
        );
      }
      const namespace = await store.getNamespace(namespaceId);
      if (!namespace) throw new ValidationError('Namespace does not exist');

      // Granting twice is not an error -- the end state is what was asked for
      // -- but it is not the same event, and the caller is told which it was.
      const existing = (await store.listNamespaceAccessForRoles([role.id])).find(
        (access) => access.namespaceId === namespace.id,
      );
      if (existing) return { record: existing, created: false };

      const access: NamespaceAccess = {
        id: newId(),
        securityRoleId: role.id,
        namespaceId: namespace.id,
        createdAt: nowIso(),
      };
      return { record: await store.insertNamespaceAccess(access), created: true };
    });
  }

  // --- users -------------------------------------------------------------

  async createUser(context: SecurityContext, input: UserInput): Promise<User> {
    return this.security.asAdministrator(context, async (store) => {
      const username = input.username.trim();
      if (username.length < 3) {
        throw new ValidationError('Username must be at least 3 characters');
      }
      if (input.password.length < 8) {
        throw new ValidationError('Password must be at least 8 characters');
      }
      if (await store.getUserByUsername(username)) {
        throw new ValidationError(`A user named "${username}" already exists`);
      }
      const role = await store.getSecurityRole(input.securityRoleId);
      if (!role) throw new ValidationError('Security role does not exist');

      const user: User = {
        id: newId(),
        username,
        email: input.email.trim(),
        passwordHash: hashPassword(input.password),
        securityRoleId: role.id,
        isActive: true,
        createdAt: nowIso(),
      };
      return store.insertUser(user);
    });
  }

  async setUserActive(context: SecurityContext, userId: Id, isActive: boolean): Promise<void> {
    await this.security.asAdministrator(context, async (store) => {
      const user = await store.getUser(userId);
      if (!user) throw new ValidationError('User does not exist');
      if (user.id === context.user.id && !isActive) {
        throw new ValidationError('You cannot deactivate yourself');
      }
      await store.updateUser(user.id, { isActive });
    });
  }

  // --- tables and fields -------------------------------------------------

  /**
   * Create a table, along with the Name field every table has.
   *
   * Name is either free text or an auto number, and it is a system field:
   * it cannot be deleted, so anything that refers to a record by name can
   * count on it existing. A free-text name is required; an auto number is
   * assigned, so there is nothing to require.
   *
   * A required field has to be writable by anyone who may create a record, so
   * a rule granting create on a table with a text Name must grant Name as
   * editable too.
   */
  async createTable(
    context: SecurityContext,
    input: {
      namespaceId: Id;
      name: string;
      label?: string;
      nameFieldType?: NameFieldType;
      nameFieldLabel?: string;
    },
  ): Promise<TableDef> {
    return this.security.asAdministrator(context, async (store) => {
      const name = input.name.trim();
      assertApiName(name, 'Table name');
      const namespace = await store.getNamespace(input.namespaceId);
      if (!namespace) throw new ValidationError('Namespace does not exist');
      if (await store.getTableByName(namespace.id, name)) {
        throw new ValidationError(`Table "${name}" already exists in ${namespace.name}`);
      }

      const nameFieldType = input.nameFieldType ?? FieldType.Text;
      if (nameFieldType !== FieldType.Text && nameFieldType !== FieldType.AutoNumber) {
        throw new ValidationError('The Name field must be free text or an auto number');
      }

      const table: TableDef = {
        id: newId(),
        namespaceId: namespace.id,
        name,
        label: input.label?.trim() || name,
        createdAt: nowIso(),
      };
      await store.insertTable(table);
      await store.insertField(
        buildNameField(table, input.nameFieldLabel?.trim() || 'Name', nameFieldType),
      );
      return table;
    });
  }

  async createField(
    context: SecurityContext,
    input: {
      tableId: Id;
      name: string;
      label?: string;
      type: FieldType;
      namespaceId?: Id;
      isRequired?: boolean;
      referenceTableId?: Id | null;
    },
  ): Promise<FieldDef> {
    return this.security.asAdministrator(context, async (store) => {
      const name = input.name.trim();
      assertApiName(name, 'Field name');
      const table = await store.getTable(input.tableId);
      if (!table) throw new ValidationError('Table does not exist');
      if (!Object.values(FieldType).includes(input.type)) {
        throw new ValidationError(`Unknown field type: ${String(input.type)}`);
      }
      // A field defaults to the namespace of its table; a package extending
      // another package's table would pass its own namespace instead.
      const namespaceId = input.namespaceId ?? table.namespaceId;
      if (!(await store.getNamespace(namespaceId))) {
        throw new ValidationError('Namespace does not exist');
      }

      let referenceTableId: Id | null = null;
      if (input.type === FieldType.Reference) {
        if (!input.referenceTableId) {
          throw new ValidationError('A lookup field must name the table it points at');
        }
        // A lookup back to the field's own table is a hierarchy, and is
        // allowed; it just cannot be required, since the first record would
        // then have nothing to point at.
        const target =
          input.referenceTableId === table.id
            ? table
            : await store.getTable(input.referenceTableId);
        if (!target) throw new ValidationError('Looked-up table does not exist');
        if (target.id === table.id && (input.isRequired ?? false)) {
          throw new ValidationError(
            'A lookup to its own table cannot be required: the first record would have no target',
          );
        }
        referenceTableId = target.id;
      } else if (input.referenceTableId) {
        throw new ValidationError('Only lookup fields may name a looked-up table');
      }

      const existing = await store.listFields(table.id);
      if (existing.some((field) => field.name === name && field.namespaceId === namespaceId)) {
        throw new ValidationError(`Field "${name}" already exists on ${table.name}`);
      }

      const field: FieldDef = {
        id: newId(),
        namespaceId,
        tableId: table.id,
        name,
        label: input.label?.trim() || name,
        type: input.type,
        // An auto number is filled in by the platform, so "required" would
        // describe the caller's duty rather than the field's.
        isRequired: input.type === FieldType.AutoNumber ? false : (input.isRequired ?? false),
        referenceTableId,
        isSystem: false,
        autoNumberNext: 1,
        createdAt: nowIso(),
      };
      return store.insertField(field);
    });
  }

  /**
   * Remove a field, its values and its field grants.
   *
   * Two things are refused. A system field -- the Name every table is created
   * with -- stays, because things depend on its being there. And a field a
   * security rule clause reads stays until that rule is dealt with: dropping
   * the clause underneath a rule would silently widen what the rule matches,
   * which is the last thing a deletion should do quietly.
   */
  async deleteField(context: SecurityContext, fieldId: Id): Promise<void> {
    await this.security.asAdministrator(context, async (store) => {
      const field = await store.getField(fieldId);
      if (!field) throw new ValidationError('Field does not exist');
      if (field.isSystem) {
        throw new ValidationError(`"${field.label}" is a system field and cannot be deleted`);
      }

      const clauses = await store.listClausesUsingField(field.id);
      if (clauses.length > 0) {
        const rules = await store.listSecurityRulesByIds([
          ...new Set(clauses.map((clause) => clause.securityRuleId)),
        ]);
        const names = rules.map((rule) => `"${rule.name}"`).join(', ');
        throw new ValidationError(
          `"${field.label}" is used by security rule ${names}. Remove the rule first, ` +
            'so that deleting the field cannot quietly change what the rule matches.',
        );
      }

      // Values and field grants go with it, by the schema's cascades.
      await store.deleteField(field.id);
    });
  }

  // --- security rules ----------------------------------------------------

  /**
   * Create a rule together with its clauses and field grants. They are
   * authored as one thing, and a half-built rule would either grant nothing
   * or -- worse -- grant unconditionally, so they are written atomically.
   */
  async createSecurityRule(
    context: SecurityContext,
    input: SecurityRuleInput,
  ): Promise<SecurityRule> {
    return this.security.asAdministrator(context, async (store) => {
      const name = input.name.trim();
      if (name.length === 0) throw new ValidationError('Rule name is required');
      const table = await store.getTable(input.tableId);
      if (!table) throw new ValidationError('Table does not exist');

      const accessTypes = [...new Set(input.accessTypes ?? [])];
      const canCreate = input.canCreate ?? false;
      if (accessTypes.length === 0 && !canCreate) {
        throw new ValidationError('A rule must grant at least one access type, or create');
      }
      for (const access of accessTypes) {
        if (!ALL_ACCESS_TYPES.includes(access)) {
          throw new ValidationError(`Unknown access type: ${String(access)}`);
        }
      }

      const clauseMatch = input.clauseMatch ?? ClauseMatch.All;
      const clauses = input.clauses ?? [];
      const tableFields = await store.listFields(table.id);
      const fieldIds = new Set(tableFields.map((field) => field.id));

      for (const clause of clauses) {
        if (!fieldIds.has(clause.fieldId)) {
          throw new ValidationError('A clause references a field on another table');
        }
        if (!Object.values(ClauseOperator).includes(clause.operator)) {
          throw new ValidationError(`Unknown operator: ${String(clause.operator)}`);
        }
        if (clause.compareFieldId && !fieldIds.has(clause.compareFieldId)) {
          throw new ValidationError('A clause compares against a field on another table');
        }
        const unary = UNARY_OPERATORS.includes(clause.operator);
        if (!unary && !clause.compareFieldId && (clause.targetValue ?? '') === '') {
          throw new ValidationError(
            `Operator "${clause.operator}" needs a target value or a comparison field`,
          );
        }
      }

      let clauseLogic: string | null = null;
      if (clauseMatch === ClauseMatch.Custom) {
        if (!input.clauseLogic?.trim()) {
          throw new ValidationError('Custom clause matching requires clause logic');
        }
        clauseLogic = input.clauseLogic.trim();
        validateClauseLogic(
          clauseLogic,
          clauses.map((_, index) => index + 1),
        );
      }

      const grants = new Map<Id, FieldAccess>();
      for (const grant of input.fieldGrants ?? []) {
        if (!fieldIds.has(grant.fieldId)) {
          throw new ValidationError('A granted field belongs to another table');
        }
        const access = grant.access ?? FieldAccess.Read;
        if (access !== FieldAccess.Read && access !== FieldAccess.Edit) {
          throw new ValidationError(`Unknown field access: ${String(access)}`);
        }
        if (access === FieldAccess.Edit && !accessTypes.includes(AccessType.Edit) && !canCreate) {
          throw new ValidationError(
            'A field can only be granted as editable by a rule that grants edit or create',
          );
        }
        const target = tableFields.find((field) => field.id === grant.fieldId);
        if (access === FieldAccess.Edit && target && SYSTEM_ASSIGNED_FIELD_TYPES.includes(target.type)) {
          throw new ValidationError(
            `"${target.label}" is filled in by the platform, so it can only be granted as read-only`,
          );
        }
        // The widest grant wins if a field is named twice.
        if (grants.get(grant.fieldId) !== FieldAccess.Edit) grants.set(grant.fieldId, access);
      }

      const rule: SecurityRule = {
        id: newId(),
        name,
        tableId: table.id,
        accessTypes,
        canCreate,
        clauseMatch,
        clauseLogic,
        createdAt: nowIso(),
      };
      await store.insertSecurityRule(rule);

      let sequence = 1;
      for (const clause of clauses) {
        const row: SecurityRuleClause = {
          id: newId(),
          securityRuleId: rule.id,
          sequence: sequence++,
          fieldId: clause.fieldId,
          operator: clause.operator,
          targetValue: clause.targetValue ?? null,
          compareFieldId: clause.compareFieldId ?? null,
          createdAt: nowIso(),
        };
        await store.insertSecurityRuleClause(row);
      }

      for (const [fieldId, access] of grants) {
        const grant: SecurityRuleFieldGrant = {
          id: newId(),
          securityRuleId: rule.id,
          fieldId,
          access,
          createdAt: nowIso(),
        };
        await store.insertFieldGrant(grant);
      }

      return rule;
    });
  }

  /** Junction: this rule now applies to this role. */
  async assignRuleToRole(
    context: SecurityContext,
    roleId: Id,
    ruleId: Id,
  ): Promise<GrantResult<SecurityRoleRule>> {
    return this.security.asAdministrator(context, async (store) => {
      const role = await store.getSecurityRole(roleId);
      if (!role) throw new ValidationError('Role does not exist');
      if (role.isSystem) {
        throw new ValidationError(
          `The ${ADMINISTRATOR_ROLE} role already has full access; rules cannot be added to it`,
        );
      }
      const rule = await store.getSecurityRule(ruleId);
      if (!rule) throw new ValidationError('Rule does not exist');

      // As with namespace access, assigning twice simply leaves it assigned.
      const existing = (await store.listSecurityRoleRulesForRoles([role.id])).find(
        (link) => link.securityRuleId === rule.id,
      );
      if (existing) return { record: existing, created: false };

      const link: SecurityRoleRule = {
        id: newId(),
        securityRoleId: role.id,
        securityRuleId: rule.id,
        createdAt: nowIso(),
      };
      return { record: await store.insertSecurityRoleRule(link), created: true };
    });
  }

  // --- reads (used by the presentation layer) ----------------------------

  listNamespaces(context: SecurityContext): Promise<Namespace[]> {
    return this.security.listNamespaces(context);
  }

  listSecurityRoles(context: SecurityContext): Promise<SecurityRole[]> {
    return this.security.listSecurityRoles(context);
  }

  listUsers(context: SecurityContext): Promise<User[]> {
    return this.security.listUsers(context);
  }

  listTables(context: SecurityContext): Promise<TableDef[]> {
    return this.security.listTables(context);
  }

  listReadableFields(context: SecurityContext, tableId: Id): Promise<FieldDef[]> {
    return this.security.listReadableFields(context, tableId);
  }

  /**
   * The rules on one table, each with its field grants resolved to names, for
   * the setup console to show what a rule actually exposes.
   */
  async describeRulesFor(
    context: SecurityContext,
    tableId: Id,
  ): Promise<RuleDescription[]> {
    return this.security.readAsAdministrator(context, async (store) => {
      const rules = (await store.listSecurityRules()).filter((rule) => rule.tableId === tableId);
      const grants = await store.listFieldGrantsForRules(rules.map((rule) => rule.id));
      const fieldNames = new Map(
        (await store.listFields(tableId)).map((field) => [field.id, field.name]),
      );
      return rules.map((rule) => ({
        rule,
        grants: grants
          .filter((grant) => grant.securityRuleId === rule.id)
          .map((grant) => ({
            field: fieldNames.get(grant.fieldId) ?? grant.fieldId,
            access: grant.access,
          })),
      }));
    });
  }

  /** Every namespace grant, for the console to show what a role already has. */
  async listNamespaceAccess(context: SecurityContext): Promise<NamespaceAccess[]> {
    return this.security.readAsAdministrator(context, async (store) =>
      store.listNamespaceAccessForRoles((await store.listSecurityRoles()).map((role) => role.id)),
    );
  }

  /** Every rule assignment, likewise. */
  async listRoleRules(context: SecurityContext): Promise<SecurityRoleRule[]> {
    return this.security.readAsAdministrator(context, async (store) =>
      store.listSecurityRoleRulesForRoles(
        (await store.listSecurityRoles()).map((role) => role.id),
      ),
    );
  }

  async listSecurityRules(context: SecurityContext): Promise<SecurityRule[]> {
    return this.security.readAsAdministrator(context, (store: MetadataStore) =>
      store.listSecurityRules(),
    );
  }
}

function buildNameField(table: TableDef, label: string, type: NameFieldType): FieldDef {
  return {
    id: newId(),
    namespaceId: table.namespaceId,
    tableId: table.id,
    name: NAME_FIELD,
    label,
    type,
    // A free-text name has to be given, since nothing else will supply it.
    // An auto number is filled in by the platform, so requiring it would
    // describe the caller's duty rather than the field's.
    isRequired: type === FieldType.Text,
    referenceTableId: null,
    isSystem: true,
    autoNumberNext: 1,
    createdAt: nowIso(),
  };
}

function assertApiName(name: string, label: string): void {
  if (!isValidApiName(name)) {
    throw new ValidationError(
      `${label} must start with a letter and contain only letters, digits and underscores`,
    );
  }
}
