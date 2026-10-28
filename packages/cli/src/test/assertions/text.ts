import type { AssertionCheck } from '../types.js';
import { asStrings, quoted } from './values.js';

/** `contains: "$19"` or `contains: [Team, "$19"]`: the reply has every one of them. */
export const contains: AssertionCheck = (value, turn) => {
  const wanted = asStrings(value, 'contains');
  const missing = wanted.filter((text) => !turn.text.includes(text));
  return missing.length
    ? { pass: false, reason: `the reply doesn't contain ${quoted(missing)}` }
    : { pass: true, reason: `the reply contains ${quoted(wanted)}` };
};

/** `icontains: "team"` or `icontains: [team, "$19"]`: the reply has every one of them, case-insensitively. */
export const icontains: AssertionCheck = (value, turn) => {
  const wanted = asStrings(value, 'icontains');
  const lower = turn.text.toLowerCase();
  const missing = wanted.filter((text) => !lower.includes(text.toLowerCase()));
  return missing.length
    ? { pass: false, reason: `the reply doesn't contain ${quoted(missing)}` }
    : { pass: true, reason: `the reply contains ${quoted(wanted)}` };
};

function readRegex(value: unknown): RegExp {
  if (typeof value === 'string') return new RegExp(value);
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const keys = Object.keys(value);
    if (keys.some((key) => key !== 'pattern' && key !== 'flags') || typeof (value as Record<string, unknown>).pattern !== 'string') {
      throw new Error('regex takes a pattern string or { pattern, flags }');
    }
    const { pattern, flags } = value as { pattern: string; flags?: unknown };
    if (flags !== undefined && typeof flags !== 'string') throw new Error('regex flags must be a string');
    return new RegExp(pattern, flags);
  }
  throw new Error('regex takes a pattern string or { pattern, flags }');
}

/** `regex: "\\$\\d+"` or `regex: { pattern: "team", flags: "i" }`: matches the reply against a regular expression. */
export const regex: AssertionCheck = (value, turn) => {
  const re = readRegex(value);
  return re.test(turn.text)
    ? { pass: true, reason: `the reply matches ${re}` }
    : { pass: false, reason: `the reply doesn't match ${re}` };
};

/** `equals: "The Team plan is $19."`: the trimmed reply equals the exact expected string. */
export const equals: AssertionCheck = (value, turn) => {
  if (typeof value !== 'string') throw new Error('equals takes a string');
  return turn.text.trim() === value
    ? { pass: true, reason: `the reply equals ${quoted([value])}` }
    : { pass: false, reason: `the reply doesn't equal ${quoted([value])}` };
};
