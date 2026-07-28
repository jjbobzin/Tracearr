import type { Operator, ConditionValue } from '@tracearr/shared';

export function compare(actual: unknown, operator: Operator, expected: ConditionValue): boolean {
  switch (operator) {
    case 'eq':
      return actual === expected;

    case 'neq':
      return actual !== expected;

    case 'gt':
      return typeof actual === 'number' && typeof expected === 'number' && actual > expected;

    case 'gte':
      return typeof actual === 'number' && typeof expected === 'number' && actual >= expected;

    case 'lt':
      return typeof actual === 'number' && typeof expected === 'number' && actual < expected;

    case 'lte':
      return typeof actual === 'number' && typeof expected === 'number' && actual <= expected;

    case 'in':
      if (!Array.isArray(expected)) {
        // Fallback: single value treated as eq
        return actual === expected;
      }
      return (expected as (string | number)[]).includes(actual as string | number);

    case 'not_in':
      if (!Array.isArray(expected)) {
        // Fallback: single value treated as neq
        return actual !== expected;
      }
      return !(expected as (string | number)[]).includes(actual as string | number);

    case 'contains':
      return (
        typeof actual === 'string' &&
        typeof expected === 'string' &&
        actual.toLowerCase().includes(expected.toLowerCase())
      );

    case 'not_contains':
      return (
        typeof actual === 'string' &&
        typeof expected === 'string' &&
        !actual.toLowerCase().includes(expected.toLowerCase())
      );

    default:
      return false;
  }
}
