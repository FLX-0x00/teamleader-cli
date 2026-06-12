/**
 * Schema-driven request body construction.
 *
 * Every API parameter is exposed as a dot-path flag:
 *   --filter.term "Pied Piper"        nested object
 *   --filter.tags a --filter.tags b   array of scalars (repeat the flag)
 *   --sort.0.field name               array of objects (numeric index)
 *   --custom_fields '[{"id":"...","value":"x"}]'   JSON literal for any object/array
 */

export class UsageError extends Error {}

function looksLikeJson(value) {
  const t = value.trim();
  return t.startsWith('{') || t.startsWith('[');
}

function parseJsonValue(value, flag) {
  try {
    return JSON.parse(value);
  } catch (e) {
    throw new UsageError(`--${flag}: invalid JSON (${e.message})`);
  }
}

/** Walk a simplified schema along one dot-path segment. Returns node or null. */
function childSchema(node, segment) {
  if (!node) return null;
  if (node.oneOf) {
    for (const variant of node.oneOf) {
      const hit = childSchema(variant, segment);
      if (hit) return hit;
    }
    return null;
  }
  if (node.type === 'array') {
    if (/^\d+$/.test(segment)) return node.items || null;
    return null;
  }
  if (node.properties && Object.hasOwn(node.properties, segment)) return node.properties[segment];
  return null;
}

function coerceScalar(value, node, flag) {
  if (node?.nullable && value === 'null') return null;
  const type = node?.type;
  if (type === 'boolean') {
    if (/^(true|1|yes)$/i.test(value)) return true;
    if (/^(false|0|no)$/i.test(value)) return false;
    throw new UsageError(`--${flag}: expected a boolean (true/false), got "${value}"`);
  }
  if (type === 'integer') {
    const n = Number(value);
    if (!Number.isInteger(n)) throw new UsageError(`--${flag}: expected an integer, got "${value}"`);
    return n;
  }
  if (type === 'number') {
    const n = Number(value);
    if (Number.isNaN(n)) throw new UsageError(`--${flag}: expected a number, got "${value}"`);
    return n;
  }
  if (node?.enum && !node.enum.includes(value)) {
    throw new UsageError(`--${flag}: must be one of: ${node.enum.join(', ')} (got "${value}")`);
  }
  return value;
}

/** Coerce one raw flag value according to the schema node at its path. */
export function coerceValue(value, node, flag) {
  if (!node) {
    // unknown to the schema – accept JSON or plain string
    return looksLikeJson(value) ? parseJsonValue(value, flag) : value;
  }
  if (node.nullable && value === 'null') return null;
  if (node.oneOf) {
    if (looksLikeJson(value)) return parseJsonValue(value, flag);
    return value;
  }
  if (node.type === 'object') {
    if (looksLikeJson(value)) return parseJsonValue(value, flag);
    throw new UsageError(
      `--${flag} is an object: pass JSON ('{...}') or set its fields with dot notation (--${flag}.<field>)`
    );
  }
  if (node.type === 'array') {
    if (looksLikeJson(value)) return parseJsonValue(value, flag);
    // single scalar item; repeatable flags accumulate
    return [coerceScalar(value, node.items, flag)];
  }
  return coerceScalar(value, node, flag);
}

/** Set a dot-path (numeric segments create arrays) in the body. Arrays from repeated flags are appended. */
export function setPath(body, flag, value, schema) {
  const segments = flag.split('.');
  let node = schema;
  let target = body;
  for (let i = 0; i < segments.length - 1; i++) {
    const seg = segments[i];
    const next = segments[i + 1];
    node = childSchema(node, seg);
    const key = /^\d+$/.test(seg) ? Number(seg) : seg;
    if (target[key] === undefined || typeof target[key] !== 'object' || target[key] === null) {
      target[key] = /^\d+$/.test(next) ? [] : {};
    }
    target = target[key];
  }
  const last = segments[segments.length - 1];
  const leaf = childSchema(node, last);
  const key = /^\d+$/.test(last) ? Number(last) : last;
  const coerced = coerceValue(value, leaf, flag);
  if (Array.isArray(coerced) && Array.isArray(target[key]) && !looksLikeJson(value)) {
    target[key].push(...coerced); // repeated flag accumulates
  } else {
    target[key] = coerced;
  }
}

/** Validate top-level flag names against the schema so typos fail fast. */
export function checkTopLevel(flag, schema) {
  if (!schema) {
    throw new UsageError(`this action takes no parameters (got --${flag})`);
  }
  const head = flag.split('.')[0];
  if (schema.properties && !Object.hasOwn(schema.properties, head)) {
    const known = Object.keys(schema.properties).join(', ');
    throw new UsageError(`unknown parameter --${head} — available: ${known}`);
  }
}

/** Check required top-level fields after the body is assembled. */
export function missingRequired(body, schema) {
  if (!schema?.required) return [];
  return schema.required.filter((k) => body[k] === undefined);
}

function typeLabel(node) {
  if (!node) return '';
  if (node.oneOf) {
    return 'oneOf<' + node.oneOf.map((v) => v.title || typeLabel(v)).join(' | ') + '>';
  }
  if (node.type === 'array') return `${typeLabel(node.items) || 'object'}[]`;
  return node.type || 'string';
}

/**
 * Flatten a request schema into rows for help output:
 * { flag, type, required, enum, description, example }
 */
export function flattenParams(schema, prefix = '', requiredList = [], depth = 0, rows = []) {
  if (!schema || depth > 7) return rows;
  if (schema.oneOf) {
    for (const variant of schema.oneOf) flattenParams(variant, prefix, requiredList, depth, rows);
    return rows;
  }
  if (!schema.properties) return rows;
  for (const [key, node] of Object.entries(schema.properties)) {
    const flag = prefix ? `${prefix}.${key}` : key;
    const required = requiredList.includes(key);
    const row = {
      flag,
      type: typeLabel(node),
      required,
      enum: node.enum,
      description: node.description || '',
      example: node.example,
      deprecated: node.deprecated,
    };
    rows.push(row);
    if (node.type === 'object' || node.oneOf) {
      flattenParams(node, flag, node.required || [], depth + 1, rows);
    } else if (node.type === 'array' && node.items && (node.items.properties || node.items.oneOf)) {
      flattenParams(node.items, `${flag}.N`, node.items.required || [], depth + 1, rows);
    } else if (node.type === 'array' && node.items?.enum) {
      row.enum = node.items.enum;
    }
  }
  return rows;
}
