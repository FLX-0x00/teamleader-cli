import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setPath, coerceValue, checkTopLevel, missingRequired, flattenParams, UsageError } from '../src/schema.js';

const schema = {
  type: 'object',
  required: ['title'],
  properties: {
    title: { type: 'string' },
    count: { type: 'integer' },
    rate: { type: 'number' },
    active: { type: 'boolean' },
    status: { type: 'string', enum: ['open', 'closed'] },
    tags: { type: 'array', items: { type: 'string' } },
    money: {
      type: 'object',
      nullable: true,
      properties: { amount: { type: 'number' }, currency: { type: 'string' } },
    },
    lines: {
      type: 'array',
      items: {
        type: 'object',
        required: ['qty'],
        properties: { qty: { type: 'integer' }, note: { type: 'string' } },
      },
    },
  },
};

test('scalar coercion by schema type', () => {
  const body = {};
  setPath(body, 'count', '42', schema);
  setPath(body, 'rate', '0.5', schema);
  setPath(body, 'active', 'true', schema);
  setPath(body, 'title', '7', schema);
  assert.deepEqual(body, { count: 42, rate: 0.5, active: true, title: '7' });
});

test('integer rejects non-integers', () => {
  assert.throws(() => setPath({}, 'count', 'abc', schema), UsageError);
  assert.throws(() => setPath({}, 'count', '1.5', schema), UsageError);
});

test('enum validation', () => {
  const body = {};
  setPath(body, 'status', 'open', schema);
  assert.equal(body.status, 'open');
  assert.throws(() => setPath({}, 'status', 'bogus', schema), /must be one of/);
});

test('repeated flags build arrays', () => {
  const body = {};
  setPath(body, 'tags', 'a', schema);
  setPath(body, 'tags', 'b', schema);
  assert.deepEqual(body.tags, ['a', 'b']);
});

test('JSON array literal replaces instead of appending', () => {
  const body = {};
  setPath(body, 'tags', '["x","y"]', schema);
  assert.deepEqual(body.tags, ['x', 'y']);
});

test('dot paths build nested objects', () => {
  const body = {};
  setPath(body, 'money.amount', '12.5', schema);
  setPath(body, 'money.currency', 'EUR', schema);
  assert.deepEqual(body.money, { amount: 12.5, currency: 'EUR' });
});

test('numeric segments build arrays of objects', () => {
  const body = {};
  setPath(body, 'lines.0.qty', '2', schema);
  setPath(body, 'lines.0.note', 'first', schema);
  setPath(body, 'lines.1.qty', '3', schema);
  assert.deepEqual(body.lines, [{ qty: 2, note: 'first' }, { qty: 3 }]);
});

test('object flags require JSON', () => {
  assert.throws(() => setPath({}, 'money', 'not-json', schema), /pass JSON/);
  const body = {};
  setPath(body, 'money', '{"amount":1,"currency":"EUR"}', schema);
  assert.deepEqual(body.money, { amount: 1, currency: 'EUR' });
});

test('nullable accepts null literal', () => {
  const body = {};
  setPath(body, 'money', 'null', schema);
  assert.equal(body.money, null);
});

test('unknown top-level parameter is rejected with available list', () => {
  assert.throws(() => checkTopLevel('nope.x', schema), /available: title, count/);
  assert.doesNotThrow(() => checkTopLevel('money.amount', schema));
});

test('missing required detection', () => {
  assert.deepEqual(missingRequired({}, schema), ['title']);
  assert.deepEqual(missingRequired({ title: 'x' }, schema), []);
});

test('flattenParams produces dot-path rows with array markers', () => {
  const rows = flattenParams(schema, '', schema.required);
  const flags = rows.map((r) => r.flag);
  assert.ok(flags.includes('lines.N.qty'));
  assert.ok(flags.includes('money.amount'));
  const title = rows.find((r) => r.flag === 'title');
  assert.equal(title.required, true);
  const qty = rows.find((r) => r.flag === 'lines.N.qty');
  assert.equal(qty.required, true);
});

test('coerceValue falls back to JSON detection without schema', () => {
  assert.deepEqual(coerceValue('{"a":1}', null, 'x'), { a: 1 });
  assert.equal(coerceValue('plain', null, 'x'), 'plain');
});
