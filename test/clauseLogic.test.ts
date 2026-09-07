import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluateClauseLogic, validateClauseLogic } from '../src/security/clauseLogic.js';
import { ValidationError } from '../src/security/errors.js';

const results = new Map([
  [1, true],
  [2, false],
  [3, true],
]);

test('evaluates AND, OR, NOT and parentheses', () => {
  assert.equal(evaluateClauseLogic('1', results), true);
  assert.equal(evaluateClauseLogic('2', results), false);
  assert.equal(evaluateClauseLogic('1 AND 2', results), false);
  assert.equal(evaluateClauseLogic('1 OR 2', results), true);
  assert.equal(evaluateClauseLogic('NOT 2', results), true);
  assert.equal(evaluateClauseLogic('1 AND (2 OR 3)', results), true);
  assert.equal(evaluateClauseLogic('(1 AND 2) OR 3', results), true);
  assert.equal(evaluateClauseLogic('1 AND NOT 3', results), false);
});

test('AND binds tighter than OR', () => {
  // false AND false OR true  ->  (false AND false) OR true
  const values = new Map([
    [1, false],
    [2, false],
    [3, true],
  ]);
  assert.equal(evaluateClauseLogic('1 AND 2 OR 3', values), true);
});

test('rejects malformed or unknown references', () => {
  assert.throws(() => evaluateClauseLogic('1 AND', results), ValidationError);
  assert.throws(() => evaluateClauseLogic('(1', results), ValidationError);
  assert.throws(() => evaluateClauseLogic('1 2', results), ValidationError);
  assert.throws(() => evaluateClauseLogic('9', results), ValidationError);
  assert.throws(() => evaluateClauseLogic('1 XOR 2', results), ValidationError);
  assert.throws(() => evaluateClauseLogic('', results), ValidationError);
});

test('validation checks logic against the clause sequences that exist', () => {
  validateClauseLogic('1 AND (2 OR 3)', [1, 2, 3]);
  assert.throws(() => validateClauseLogic('1 AND 4', [1, 2, 3]), ValidationError);
});

// --- clause evaluation ----------------------------------------------------

test('an empty value is simply not equal to anything else', async () => {
  const { evaluateClause } = await import('../src/security/clauses.js');
  const { ClauseOperator, FieldType } = await import('../src/domain/types.js');

  const field = {
    id: 'f1',
    namespaceId: 'n',
    tableId: 't',
    name: 'stage',
    label: 'Stage',
    type: FieldType.Text,
    isRequired: false,
    referenceTableId: null,
    createdAt: '',
  };
  const user = {
    id: 'u1',
    username: 'sam',
    email: '',
    passwordHash: '',
    securityRoleId: 'r1',
    isActive: true,
    createdAt: '',
  };
  const clause = {
    id: 'c1',
    securityRuleId: 'rule',
    sequence: 1,
    fieldId: 'f1',
    operator: ClauseOperator.NotEquals,
    targetValue: 'closed',
    compareFieldId: null,
    createdAt: '',
  };

  const evaluate = (operator: typeof ClauseOperator[keyof typeof ClauseOperator], value: string | null) =>
    evaluateClause({ ...clause, operator }, field, null, new Map([['f1', value]]), user);

  // The naive reading: an empty stage is not "closed", so != matches it.
  assert.equal(evaluate(ClauseOperator.NotEquals, null), true);
  assert.equal(evaluate(ClauseOperator.NotEquals, ''), true);
  assert.equal(evaluate(ClauseOperator.NotEquals, 'open'), true);
  assert.equal(evaluate(ClauseOperator.NotEquals, 'closed'), false);

  assert.equal(evaluate(ClauseOperator.Equals, null), false);
  assert.equal(evaluate(ClauseOperator.Equals, 'closed'), true);

  // Emptiness itself is still asked about with isNull / isNotNull.
  assert.equal(evaluate(ClauseOperator.IsNull, null), true);
  assert.equal(evaluate(ClauseOperator.IsNull, ''), true);
  assert.equal(evaluate(ClauseOperator.IsNotNull, 'open'), true);

  // Ordering and text operators have nothing to compare against.
  assert.equal(evaluate(ClauseOperator.GreaterThan, null), false);
  assert.equal(evaluate(ClauseOperator.Contains, null), false);
  assert.equal(evaluate(ClauseOperator.StartsWith, null), false);
  assert.equal(evaluate(ClauseOperator.In, null), false);
});

test('two empty values are equal to each other', async () => {
  const { evaluateClause } = await import('../src/security/clauses.js');
  const { ClauseOperator, FieldType } = await import('../src/domain/types.js');

  const field = {
    id: 'a',
    namespaceId: 'n',
    tableId: 't',
    name: 'a',
    label: 'A',
    type: FieldType.Text,
    isRequired: false,
    referenceTableId: null,
    createdAt: '',
  };
  const other = { ...field, id: 'b', name: 'b', label: 'B' };
  const user = {
    id: 'u1',
    username: 'sam',
    email: '',
    passwordHash: '',
    securityRoleId: 'r1',
    isActive: true,
    createdAt: '',
  };
  const clause = {
    id: 'c1',
    securityRuleId: 'rule',
    sequence: 1,
    fieldId: 'a',
    operator: ClauseOperator.Equals,
    targetValue: null,
    compareFieldId: 'b',
    createdAt: '',
  };
  const values = new Map<string, string | null>([
    ['a', null],
    ['b', null],
  ]);

  assert.equal(evaluateClause(clause, field, other, values, user), true);
  assert.equal(
    evaluateClause({ ...clause, operator: ClauseOperator.NotEquals }, field, other, values, user),
    false,
  );
});
