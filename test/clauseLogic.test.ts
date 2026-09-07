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
