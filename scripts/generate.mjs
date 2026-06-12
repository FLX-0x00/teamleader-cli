#!/usr/bin/env node
/**
 * Generates src/registry.json from @teamleader/focus-api-specification.
 *
 * The registry contains one entry per API endpoint with a simplified request
 * schema (allOf merged, response schemas dropped) that the CLI uses for
 * argument parsing, validation and help output.
 *
 * Re-run after updating the spec package:  pnpm update @teamleader/focus-api-specification && pnpm generate
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

const require = createRequire(import.meta.url);
const specPkgDir = dirname(require.resolve('@teamleader/focus-api-specification/package.json'));
const specPath = join(specPkgDir, 'dist', 'api.focus.teamleader.eu.dereferenced.yaml');

console.log(`Reading spec: ${specPath}`);
const doc = YAML.parse(readFileSync(specPath, 'utf8'), { maxAliasCount: -1 });

const MAX_DEPTH = 14;

function mergeSchemas(a, b) {
  if (!a) return b;
  if (!b) return a;
  const out = { ...a, ...b };
  if (a.properties && b.properties) {
    out.properties = { ...a.properties };
    for (const [k, v] of Object.entries(b.properties)) {
      out.properties[k] = out.properties[k] ? mergeSchemas(out.properties[k], v) : v;
    }
  }
  if (a.required && b.required) {
    out.required = [...new Set([...a.required, ...b.required])];
  }
  // keep the more descriptive text
  if (a.description && !b.description) out.description = a.description;
  if (a.example !== undefined && b.example === undefined) out.example = a.example;
  return out;
}

function resolveAllOf(node) {
  if (!node || typeof node !== 'object') return node;
  if (!node.allOf) return node;
  let merged = {};
  for (const part of node.allOf) {
    merged = mergeSchemas(merged, resolveAllOf(part));
  }
  const { allOf, ...rest } = node;
  return mergeSchemas(merged, rest);
}

function simplify(node, depth = 0) {
  if (!node || typeof node !== 'object' || depth > MAX_DEPTH) return undefined;
  node = resolveAllOf(node);
  const out = {};
  if (node.type) out.type = node.type;
  if (node.description) out.description = String(node.description).trim();
  if (node.enum) out.enum = node.enum;
  if (node.format) out.format = node.format;
  if (node.nullable) out.nullable = true;
  if (node.deprecated) out.deprecated = true;
  if (node.example !== undefined && (typeof node.example !== 'object' || node.example === null)) {
    out.example = node.example;
  }
  if (node.properties) {
    out.type = 'object';
    out.properties = {};
    for (const [k, v] of Object.entries(node.properties)) {
      const s = simplify(v, depth + 1);
      if (s) out.properties[k] = s;
    }
  }
  if (Array.isArray(node.required) && node.required.length) out.required = node.required;
  if (node.items) {
    out.type = 'array';
    out.items = simplify(node.items, depth + 1);
  }
  if (node.oneOf) {
    out.oneOf = node.oneOf.map((v) => {
      const s = simplify(v, depth + 1) || {};
      if (v.title) s.title = v.title;
      return s;
    });
  }
  if (!out.type && !out.oneOf && !out.properties) out.type = 'string';
  return out;
}

// "/projects-v2/tasks.create" -> { resource: "projects-v2-tasks", action: "create" }
function camelToKebab(s) {
  return s.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
}

function cliNames(path) {
  const p = path.replace(/^\//, '');
  const dot = p.lastIndexOf('.');
  const resourcePart = p.slice(0, dot);
  const actionPart = p.slice(dot + 1);
  return {
    resource: camelToKebab(resourcePart.replace(/\//g, '-')),
    action: camelToKebab(actionPart),
  };
}

const DESTRUCTIVE = /delete|trash/i;

const groups = {};
for (const tag of doc.tags || []) {
  groups[tag.name] = (tag.description || '').trim();
}

const commands = [];
for (const [path, methods] of Object.entries(doc.paths)) {
  for (const [method, op] of Object.entries(methods)) {
    if (!['get', 'post', 'put', 'patch', 'delete'].includes(method)) continue;
    const { resource, action } = cliNames(path);
    const rawSchema = op.requestBody?.content?.['application/json']?.schema;
    const schema = rawSchema ? simplify(rawSchema) : null;
    const example =
      op.requestBody?.content?.['application/json']?.example ??
      (rawSchema?.allOf || []).map((p) => p.example).find((e) => e) ??
      null;
    const responses = Object.keys(op.responses || {});
    commands.push({
      path,
      method: method.toUpperCase(),
      resource,
      action,
      group: op.tags?.[0] || resource,
      description: (op.description || '').trim(),
      deprecated: !!op.deprecated,
      destructive: DESTRUCTIVE.test(action),
      returnsContent: responses.some((c) => c === '200' || c === '201'),
      schema,
      example,
    });
  }
}

commands.sort((a, b) => a.resource.localeCompare(b.resource) || a.action.localeCompare(b.action));

const registry = {
  specVersion: doc.info.version,
  baseUrl: doc.servers?.[0]?.url || 'https://api.focus.teamleader.eu',
  generatedFrom: '@teamleader/focus-api-specification',
  groups,
  commands,
};

const outPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'registry.json');
writeFileSync(outPath, JSON.stringify(registry, null, 1) + '\n');

const destructive = commands.filter((c) => c.destructive).map((c) => `${c.resource} ${c.action}`);
console.log(`Wrote ${outPath}`);
console.log(`  spec version: ${registry.specVersion}`);
console.log(`  commands: ${commands.length}`);
console.log(`  resources: ${new Set(commands.map((c) => c.resource)).size}`);
console.log(`  destructive (need --rm): ${destructive.length}`);
console.log('    ' + destructive.join(', '));
