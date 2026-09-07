import { ValidationError } from './errors.js';

/**
 * Parser for custom clause logic such as "1 AND (2 OR 3)".
 *
 * Grammar (lowest precedence first):
 *   expr   := term ('OR' term)*
 *   term   := factor ('AND' factor)*
 *   factor := 'NOT' factor | '(' expr ')' | NUMBER
 */
type Token = { kind: 'number'; value: number } | { kind: 'op'; value: string };

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  const pattern = /\s*(\(|\)|[0-9]+|[A-Za-z]+)/y;
  let index = 0;
  while (index < input.length) {
    pattern.lastIndex = index;
    const match = pattern.exec(input);
    if (!match) {
      if (input.slice(index).trim() === '') break;
      throw new ValidationError(`Unexpected character in clause logic at position ${index}`);
    }
    index = pattern.lastIndex;
    const text = match[1] as string;
    if (/^[0-9]+$/.test(text)) {
      tokens.push({ kind: 'number', value: Number(text) });
    } else {
      const upper = text.toUpperCase();
      if (upper !== 'AND' && upper !== 'OR' && upper !== 'NOT' && text !== '(' && text !== ')') {
        throw new ValidationError(`Unknown token "${text}" in clause logic`);
      }
      tokens.push({ kind: 'op', value: text === '(' || text === ')' ? text : upper });
    }
  }
  return tokens;
}

/**
 * Evaluate `logic` where each number refers to a clause sequence. Sequences
 * with no clause are an error, so a typo fails closed rather than silently
 * widening access.
 */
export function evaluateClauseLogic(logic: string, results: Map<number, boolean>): boolean {
  const tokens = tokenize(logic);
  if (tokens.length === 0) {
    throw new ValidationError('Clause logic is empty');
  }
  let position = 0;

  const peek = (): Token | undefined => tokens[position];

  const expect = (value: string): void => {
    const token = peek();
    if (!token || token.kind !== 'op' || token.value !== value) {
      throw new ValidationError(`Expected "${value}" in clause logic`);
    }
    position += 1;
  };

  const factor = (): boolean => {
    const token = peek();
    if (!token) throw new ValidationError('Unexpected end of clause logic');
    if (token.kind === 'op' && token.value === 'NOT') {
      position += 1;
      return !factor();
    }
    if (token.kind === 'op' && token.value === '(') {
      position += 1;
      const value = expr();
      expect(')');
      return value;
    }
    if (token.kind === 'number') {
      position += 1;
      const result = results.get(token.value);
      if (result === undefined) {
        throw new ValidationError(`Clause logic references unknown clause ${token.value}`);
      }
      return result;
    }
    throw new ValidationError(`Unexpected "${token.value}" in clause logic`);
  };

  const term = (): boolean => {
    let value = factor();
    for (;;) {
      const token = peek();
      if (token?.kind === 'op' && token.value === 'AND') {
        position += 1;
        // Both sides are evaluated already; no short-circuit needed.
        value = factor() && value;
      } else break;
    }
    return value;
  };

  const expr = (): boolean => {
    let value = term();
    for (;;) {
      const token = peek();
      if (token?.kind === 'op' && token.value === 'OR') {
        position += 1;
        value = term() || value;
      } else break;
    }
    return value;
  };

  const result = expr();
  if (position !== tokens.length) {
    throw new ValidationError('Trailing tokens in clause logic');
  }
  return result;
}

/** Validate logic at save time so bad expressions never reach evaluation. */
export function validateClauseLogic(logic: string, sequences: number[]): void {
  const results = new Map<number, boolean>(sequences.map((sequence) => [sequence, false]));
  evaluateClauseLogic(logic, results);
}
