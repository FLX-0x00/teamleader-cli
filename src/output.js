const useColor = process.stdout.isTTY && !process.env.NO_COLOR;

const wrap = (code, close) => (s) => (useColor ? `\x1b[${code}m${s}\x1b[${close}m` : String(s));
export const bold = wrap(1, 22);
export const dim = wrap(2, 22);
export const red = wrap(31, 39);
export const green = wrap(32, 39);
export const yellow = wrap(33, 39);
export const cyan = wrap(36, 39);

export function notice(msg) {
  process.stderr.write(dim(msg) + '\n');
}

export function warn(msg) {
  process.stderr.write(yellow(msg) + '\n');
}

export function fail(msg, code = 1) {
  process.stderr.write(red('error: ') + msg + '\n');
  process.exit(code);
}

export function printJson(value) {
  process.stdout.write(JSON.stringify(value, null, 2) + '\n');
}

/** Render one cell value for table output. */
function cell(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) {
    if (value.length === 0) return '';
    if (value.every((v) => typeof v !== 'object' || v === null)) return value.join(', ');
    return JSON.stringify(value);
  }
  // common API shapes get a compact rendering
  const keys = Object.keys(value);
  if (keys.length === 2 && 'type' in value && 'id' in value) return `${value.type}:${value.id}`;
  if ('amount' in value && 'currency' in value) return `${value.amount} ${value.currency}`;
  if (keys.length === 1 && 'id' in value) return value.id;
  return JSON.stringify(value);
}

export function getPath(obj, path) {
  return path.split('.').reduce((o, k) => (o === null || o === undefined ? o : o[k]), obj);
}

const MAX_CELL = 60;

function truncate(s, max = MAX_CELL) {
  s = s.replace(/\s+/g, ' ');
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

/**
 * Print an array of objects as a terminal table.
 * fields: optional list of (dot) paths selecting/ordering columns.
 */
export function printTable(rows, { fields } = {}) {
  if (!rows.length) {
    notice('(no results)');
    return;
  }
  let columns;
  if (fields && fields.length) {
    columns = fields;
  } else {
    columns = [];
    for (const row of rows) {
      for (const key of Object.keys(row)) {
        if (!columns.includes(key)) columns.push(key);
      }
    }
  }

  const data = rows.map((row) =>
    columns.map((col) => truncate(cell(fields ? getPath(row, col) : row[col])))
  );

  // fit columns into the terminal width; drop the widest trailing ones if needed
  const widths = columns.map((col, i) =>
    Math.max(col.length, ...data.map((r) => r[i].length))
  );
  const budget = process.stdout.columns || 190;
  let visible = columns.length;
  if (!fields) {
    let total = 0;
    for (let i = 0; i < columns.length; i++) {
      total += widths[i] + 2;
      if (total > budget && i > 0) {
        visible = i;
        break;
      }
    }
  }
  const hidden = columns.slice(visible);

  const header = columns.slice(0, visible).map((c, i) => bold(c.padEnd(widths[i]))).join('  ');
  process.stdout.write(header + '\n');
  process.stdout.write(dim(columns.slice(0, visible).map((_, i) => '─'.repeat(widths[i])).join('  ')) + '\n');
  for (const r of data) {
    process.stdout.write(r.slice(0, visible).map((v, i) => v.padEnd(widths[i])).join('  ') + '\n');
  }
  let footer = `${rows.length} row${rows.length === 1 ? '' : 's'}`;
  if (hidden.length) footer += ` · hidden columns: ${hidden.join(', ')} (use --fields or --json)`;
  notice(footer);
}

/** Flatten an object into dot-path -> scalar for detail ("info") views. */
function flatten(obj, prefix = '', out = {}, depth = 0) {
  for (const [k, v] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${k}` : k;
    if (v !== null && typeof v === 'object' && !Array.isArray(v) && depth < 4 && Object.keys(v).length) {
      flatten(v, path, out, depth + 1);
    } else {
      out[path] = cell(v);
    }
  }
  return out;
}

export function printDetail(obj, { all = false } = {}) {
  const flat = flatten(obj);
  const entries = Object.entries(flat).filter(([, v]) => all || v !== '');
  const keyWidth = Math.max(...entries.map(([k]) => k.length));
  for (const [k, v] of entries) {
    process.stdout.write(cyan(k.padEnd(keyWidth)) + '  ' + truncate(String(v), 2000) + '\n');
  }
  const skipped = Object.keys(flat).length - entries.length;
  if (skipped) notice(`${skipped} empty field${skipped === 1 ? '' : 's'} hidden (use --json to see everything)`);
}
