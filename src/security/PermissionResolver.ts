import { AccessType, STD_NAMESPACE, type Id } from '../domain/types.js';
import type { MetadataStore } from '../store/MetadataStore.js';
import type { CompiledRule } from './clauses.js';
import type { SecurityContext } from './context.js';

/** Everything the layer needs to decide about one user, resolved once. */
export interface PermissionSet {
  readonly isAdministrator: boolean;
  /** The acting role plus every role beneath it in the hierarchy. */
  readonly roleIds: readonly Id[];
  readonly namespaceIds: ReadonlySet<Id>;
  readonly rulesByTable: ReadonlyMap<Id, CompiledRule[]>;
}

/**
 * Resolves a user's effective permissions.
 *
 * Hierarchy semantics: a role encompasses the access of every role beneath it.
 * That is what makes Administrator -- the root, which no other role may sit
 * above -- the role that sees everything without needing rules of its own.
 */
export class PermissionResolver {
  private cache = new Map<Id, PermissionSet>();

  constructor(private readonly store: MetadataStore) {}

  /** Called whenever metadata changes; permissions are derived from it. */
  invalidate(): void {
    this.cache.clear();
  }

  async resolve(context: SecurityContext): Promise<PermissionSet> {
    const cached = this.cache.get(context.role.id);
    if (cached) return cached;

    const resolved = await this.compute(context);
    this.cache.set(context.role.id, resolved);
    return resolved;
  }

  private async compute(context: SecurityContext): Promise<PermissionSet> {
    const roleIds = await this.roleClosure(context.role.id);

    if (context.role.isSystem) {
      // Administrator: everything, unconditionally.
      const namespaceIds = new Set((await this.store.listNamespaces()).map((n) => n.id));
      return {
        isAdministrator: true,
        roleIds,
        namespaceIds,
        rulesByTable: new Map(),
      };
    }

    const namespaceIds = new Set<Id>();
    const std = await this.store.getNamespaceByName(STD_NAMESPACE);
    // Every role can see the std namespace; that is why a fresh install needs
    // no namespaceAccess rows at all.
    if (std) namespaceIds.add(std.id);
    for (const access of await this.store.listNamespaceAccessForRoles([...roleIds])) {
      namespaceIds.add(access.namespaceId);
    }

    const links = await this.store.listSecurityRoleRulesForRoles([...roleIds]);
    const ruleIds = [...new Set(links.map((link) => link.securityRuleId))];
    const rules = await this.store.listSecurityRulesByIds(ruleIds);
    const clauses = await this.store.listClausesForRules(ruleIds);
    const ruleFields = await this.store.listRuleFieldsForRules(ruleIds);

    const rulesByTable = new Map<Id, CompiledRule[]>();
    for (const rule of rules) {
      const compiled: CompiledRule = {
        id: rule.id,
        name: rule.name,
        tableId: rule.tableId,
        accessTypes: new Set<string>(rule.accessTypes),
        clauseMatch: rule.clauseMatch,
        clauseLogic: rule.clauseLogic,
        clauses: clauses.filter((clause) => clause.securityRuleId === rule.id),
        fieldIds: new Set(
          ruleFields.filter((link) => link.securityRuleId === rule.id).map((link) => link.fieldId),
        ),
      };
      const list = rulesByTable.get(rule.tableId);
      if (list) list.push(compiled);
      else rulesByTable.set(rule.tableId, [compiled]);
    }

    return { isAdministrator: false, roleIds, namespaceIds, rulesByTable };
  }

  /** The role itself plus all of its descendants, breadth first. */
  private async roleClosure(rootId: Id): Promise<Id[]> {
    const seen = new Set<Id>([rootId]);
    const queue: Id[] = [rootId];
    while (queue.length > 0) {
      const current = queue.shift() as Id;
      for (const child of await this.store.listChildRoles(current)) {
        if (seen.has(child.id)) continue;
        seen.add(child.id);
        queue.push(child.id);
      }
    }
    return [...seen];
  }
}

/** Rules on `tableId` that grant `access`, ignoring record-level clauses. */
export function rulesGranting(
  permissions: PermissionSet,
  tableId: Id,
  access: AccessType,
): CompiledRule[] {
  return (permissions.rulesByTable.get(tableId) ?? []).filter((rule) =>
    rule.accessTypes.has(access),
  );
}
