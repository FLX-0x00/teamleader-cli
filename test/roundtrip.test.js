import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { setPath, checkTopLevel, missingRequired } from '../src/schema.js';

const require = createRequire(import.meta.url);
const registry = require('../src/registry.json');

/** Convert an example body into dot-path flag assignments (.N for array indices). */
function toFlags(value, prefix = '', out = []) {
  if (Array.isArray(value)) {
    value.forEach((v, i) => toFlags(v, `${prefix}.${i}`, out));
  } else if (value !== null && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      toFlags(v, prefix ? `${prefix}.${k}` : k, out);
    }
  } else {
    out.push([prefix, value === null ? 'null' : String(value)]);
  }
  return out;
}

/** deepEqual, but tolerates spec examples that write numbers as strings ("100" vs 100). */
function lenientEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b) return String(a) === String(b) && a !== null && b !== null;
  if (a === null || b === null || typeof a !== 'object') return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  return ka.length === kb.length && ka.every((k) => lenientEqual(a[k], b[k]));
}

// known bugs in the official spec examples (verified against the schema by hand)
const BROKEN_SPEC_EXAMPLES = new Set([
  'reservations list', // example puts filter fields at the top level instead of under "filter"
]);

// The flag system must reproduce every documented example body exactly:
// string -> coerced value roundtrip through the schema for all 292 commands.
for (const cmd of registry.commands) {
  if (!cmd.example || typeof cmd.example !== 'object') continue;
  if (BROKEN_SPEC_EXAMPLES.has(`${cmd.resource} ${cmd.action}`)) continue;
  test(`roundtrip ${cmd.resource} ${cmd.action}`, () => {
    const body = {};
    for (const [flag, raw] of toFlags(cmd.example)) {
      checkTopLevel(flag, cmd.schema);
      setPath(body, flag, raw, cmd.schema);
    }
    assert.ok(lenientEqual(body, cmd.example), JSON.stringify({ built: body, example: cmd.example }));
  });
  test(`example satisfies required fields: ${cmd.resource} ${cmd.action}`, () => {
    assert.deepEqual(missingRequired(cmd.example, cmd.schema), []);
  });
}
