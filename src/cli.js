#!/usr/bin/env node
import { readFileSync, writeFileSync, createWriteStream } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createRequire } from 'node:module';
import { apiCall, ApiError, AuthError } from './api.js';
import * as auth from './auth.js';
import { UsageError, setPath, checkTopLevel, missingRequired } from './schema.js';
import { rootHelp, resourceHelp, actionHelp, listCommands } from './help.js';
import { printJson, printTable, printDetail, fail, notice, warn, green, bold } from './output.js';

const require = createRequire(import.meta.url);
const registry = require('./registry.json');
const VERSION = require('../package.json').version;

// exit quietly when output is piped into e.g. `head`
for (const stream of [process.stdout, process.stderr]) {
  stream.on('error', (e) => {
    if (e.code === 'EPIPE') process.exit(0);
    throw e;
  });
}

const GLOBAL_BOOL = new Set(['json', 'rm', 'all', 'verbose', 'v', 'help', 'h', 'version', 'dry-run', 'manual', 'full']);
const GLOBAL_VALUE = new Set(['fields', 'limit', 'page', 'sort', 'include', 'body', 'output', 'file', 'client-id', 'client-secret', 'port']);

const norm = (s) => s.toLowerCase().replace(/[-_]/g, '');

const resourceIndex = new Map(); // normalized resource -> canonical
const commandIndex = new Map(); // "resource action" canonical -> cmd
for (const cmd of registry.commands) {
  resourceIndex.set(norm(cmd.resource), cmd.resource);
  commandIndex.set(`${cmd.resource} ${cmd.action}`, cmd);
}

function findResource(input) {
  return resourceIndex.get(norm(input)) || null;
}

function findCommand(resource, actionInput) {
  const cmds = registry.commands.filter((c) => c.resource === resource);
  return cmds.find((c) => norm(c.action) === norm(actionInput)) || null;
}

function suggest(input, candidates) {
  const n = norm(input);
  const hits = candidates.filter((c) => norm(c).includes(n) || n.includes(norm(c)));
  return hits.length ? ` — did you mean: ${hits.slice(0, 5).join(', ')}?` : '';
}

/** Parse argv after resource/action: returns { positionals, flags: Map(name -> [values]) } */
function parseFlags(argv, schema) {
  const positionals = [];
  const flags = new Map();
  const push = (name, value) => {
    if (!flags.has(name)) flags.set(name, []);
    flags.get(name).push(value);
  };
  const schemaLeafType = (flag) => {
    let node = schema;
    for (const seg of flag.split('.')) {
      if (!node) return null;
      if (node.type === 'array') node = /^\d+$/.test(seg) ? node.items : null;
      else node = node.properties?.[seg] || null;
    }
    return node?.type || null;
  };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === '-h') {
      push('help', true);
    } else if (token === '-v') {
      push('verbose', true);
    } else if (token.startsWith('--')) {
      let name = token.slice(2);
      let value;
      const eq = name.indexOf('=');
      if (eq !== -1) {
        value = name.slice(eq + 1);
        name = name.slice(0, eq);
      }
      if (value === undefined) {
        if (GLOBAL_BOOL.has(name)) {
          value = true;
        } else if (schemaLeafType(name) === 'boolean') {
          // bare boolean flag, or explicit true/false as the next token
          if (i + 1 < argv.length && /^(true|false|1|0|yes|no)$/i.test(argv[i + 1])) {
            value = argv[++i];
          } else {
            value = 'true';
          }
        } else {
          const next = argv[i + 1];
          if (next === undefined || (next.startsWith('--') && next.length > 2)) {
            throw new UsageError(`--${name} needs a value (use --${name}=<value> for values starting with "-")`);
          }
          value = argv[++i];
        }
      }
      push(name, value);
    } else {
      positionals.push(token);
    }
  }
  return { positionals, flags };
}

function first(flags, name) {
  return flags.get(name)?.[0];
}

function readBodyFlag(value) {
  let raw = value;
  if (value === '-') raw = readFileSync(0, 'utf8');
  else if (value.startsWith('@')) raw = readFileSync(value.slice(1), 'utf8');
  try {
    const parsed = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('must be a JSON object');
    }
    return parsed;
  } catch (e) {
    throw new UsageError(`--body: ${e.message}`);
  }
}

function buildBody(cmd, positionals, flags) {
  const schema = cmd.schema;
  let body = {};
  if (flags.has('body')) body = readBodyFlag(first(flags, 'body'));

  // positional -> id
  if (positionals.length) {
    if (!schema?.properties?.id) {
      throw new UsageError(`"tl ${cmd.resource} ${cmd.action}" takes no positional arguments (got "${positionals[0]}")`);
    }
    if (positionals.length > 1) throw new UsageError(`too many positional arguments: ${positionals.join(' ')}`);
    body.id = positionals[0];
  }

  // sugar flags
  if (flags.has('limit')) {
    if (!schema?.properties?.page) throw new UsageError(`--limit: "tl ${cmd.resource} ${cmd.action}" is not paginated`);
    setPath(body, 'page.size', first(flags, 'limit'), schema);
  }
  if (flags.has('page')) {
    if (!schema?.properties?.page) throw new UsageError(`--page: "tl ${cmd.resource} ${cmd.action}" is not paginated`);
    setPath(body, 'page.number', first(flags, 'page'), schema);
  }
  if (flags.has('sort')) {
    if (!schema?.properties?.sort) throw new UsageError(`--sort: "tl ${cmd.resource} ${cmd.action}" is not sortable`);
    flags.get('sort').forEach((spec, i) => {
      const [field, order] = String(spec).split(':');
      setPath(body, `sort.${i}.field`, field, schema);
      if (order) setPath(body, `sort.${i}.order`, order, schema);
    });
  }
  if (flags.has('include')) {
    if (!schema?.properties?.includes) throw new UsageError(`--include: "tl ${cmd.resource} ${cmd.action}" has no includes`);
    body.includes = flags.get('include').join(',');
  }

  // schema parameters (dot-path flags)
  for (const [name, values] of flags) {
    if (GLOBAL_BOOL.has(name) || GLOBAL_VALUE.has(name)) continue;
    checkTopLevel(name, schema);
    for (const value of values) {
      setPath(body, name, value === true ? 'true' : String(value), schema);
    }
  }

  const missing = missingRequired(body, schema);
  if (missing.length) {
    throw new UsageError(
      `missing required parameter${missing.length === 1 ? '' : 's'}: ${missing.map((m) => `--${m}`).join(', ')} (see: tl ${cmd.resource} ${cmd.action} --help)`
    );
  }
  return body;
}

async function downloadTo(location, file) {
  const res = await fetch(location);
  if (!res.ok) throw new ApiError(`download failed (HTTP ${res.status})`);
  await pipeline(Readable.fromWeb(res.body), createWriteStream(file));
}

async function uploadFile(location, file) {
  const data = readFileSync(file);
  const res = await fetch(location, { method: 'PUT', body: data });
  if (!res.ok) throw new ApiError(`upload failed (HTTP ${res.status}): ${await res.text()}`);
}

async function runCommand(cmd, positionals, flags) {
  if (cmd.destructive && !flags.has('rm')) {
    fail(
      `"tl ${cmd.resource} ${cmd.action}" is destructive and blocked by safe mode.\n` +
        `       Re-run with --rm to execute it.`,
      2
    );
  }
  if (cmd.deprecated) warn(`note: ${cmd.path} is deprecated`);

  const body = buildBody(cmd, positionals, flags);

  if (flags.has('dry-run')) {
    printJson({ endpoint: `POST ${cmd.path}`, body });
    return;
  }

  const verbose = flags.has('verbose');
  const json = flags.has('json');
  let result;

  if (flags.has('all')) {
    if (!cmd.schema?.properties?.page) fail(`--all: "tl ${cmd.resource} ${cmd.action}" is not paginated`, 2);
    const size = body.page?.size ?? 20;
    let number = body.page?.number ?? 1;
    const rows = [];
    for (;;) {
      const res = await apiCall(cmd.path, { ...body, page: { size, number } }, { verbose });
      const data = res.json?.data;
      if (!Array.isArray(data)) {
        result = res;
        break;
      }
      rows.push(...data);
      if (verbose || data.length === size) notice(`fetched page ${number} (${rows.length} rows)`);
      if (data.length < size) {
        result = { status: res.status, json: { ...res.json, data: rows } };
        break;
      }
      number++;
    }
  } else {
    result = await apiCall(cmd.path, body, { verbose });
  }

  const payload = result.json;

  // file transfer conveniences
  const location = payload?.data?.location;
  if (flags.has('output') && location) {
    await downloadTo(location, first(flags, 'output'));
    if (json) printJson({ ...payload, saved_to: first(flags, 'output') });
    else process.stdout.write(green('✓') + ` saved to ${first(flags, 'output')}\n`);
    return;
  }
  if (flags.has('file') && location) {
    await uploadFile(location, first(flags, 'file'));
    if (json) printJson({ ...payload, uploaded: first(flags, 'file') });
    else process.stdout.write(green('✓') + ` uploaded ${first(flags, 'file')}\n`);
    return;
  }
  if (flags.has('file') && !location) fail('--file: this action did not return an upload location (use "tl files upload")', 2);

  if (json) {
    printJson(payload ?? { ok: true, status: result.status });
    return;
  }

  if (!payload || payload.data === undefined) {
    process.stdout.write(green('✓') + ` ${cmd.resource}.${cmd.action} ok\n`);
    return;
  }
  const data = payload.data;
  if (Array.isArray(data)) {
    const fields = first(flags, 'fields')?.split(',').map((s) => s.trim());
    printTable(data, { fields });
  } else if (data && typeof data === 'object') {
    printDetail(data, { all: flags.has('verbose') });
  } else {
    printJson(payload);
  }
  if (payload.included) notice('response contains sideloaded "included" data — use --json to see it');
}

async function main() {
  const argv = process.argv.slice(2);

  if (!argv.length || argv[0] === 'help' && argv.length === 1 || argv[0] === '--help' || argv[0] === '-h') {
    rootHelp(registry, VERSION);
    return;
  }
  if (argv[0] === '--version' || argv[0] === 'version') {
    process.stdout.write(`teamleader-cli ${VERSION} (API spec ${registry.specVersion})\n`);
    return;
  }
  if (argv[0] === 'help') {
    argv.shift(); // "tl help x y" === "tl x y --help"
    argv.push('--help');
  }

  let [head, ...rest] = argv;

  if (head === 'auth') {
    const sub = rest.shift();
    const { flags } = parseFlags(rest, null);
    const opts = Object.fromEntries([...flags.entries()].map(([k, v]) => [k, v[0]]));
    if (sub === 'login') return auth.login(opts);
    if (sub === 'status') return auth.status(opts);
    if (sub === 'refresh') return auth.refresh();
    if (sub === 'logout') return auth.logout(opts);
    fail(`unknown auth command "${sub ?? ''}" — use: tl auth <login|status|refresh|logout>`, 2);
  }

  if (head === 'commands') {
    const { flags } = parseFlags(rest, null);
    return listCommands(registry, { json: flags.has('json') });
  }

  // accept API path style: tl contacts.list / tl projects-v2/tasks.create
  let resourceInput = head;
  let actionInput = null;
  if (head.includes('.')) {
    const clean = head.replace(/^\//, '');
    const dot = clean.lastIndexOf('.');
    resourceInput = clean.slice(0, dot).replace(/\//g, '-');
    actionInput = clean.slice(dot + 1);
  } else if (rest.length && !rest[0].startsWith('-')) {
    actionInput = rest.shift();
  }

  const resource = findResource(resourceInput);
  if (!resource) {
    fail(`unknown resource "${resourceInput}"${suggest(resourceInput, [...new Set(registry.commands.map((c) => c.resource))])}\n       Run "tl --help" for the full list.`, 2);
  }

  if (!actionInput) {
    resourceHelp(registry, resource);
    return;
  }

  const cmd = findCommand(resource, actionInput);
  if (!cmd) {
    const actions = registry.commands.filter((c) => c.resource === resource).map((c) => c.action);
    fail(`unknown action "${actionInput}" for ${resource}${suggest(actionInput, actions)}\n       Available: ${actions.join(', ')}`, 2);
  }

  const { positionals, flags } = parseFlags(rest, cmd.schema);
  if (flags.has('help')) {
    actionHelp(cmd);
    return;
  }
  await runCommand(cmd, positionals, flags);
}

main().catch((e) => {
  if (e instanceof UsageError) fail(e.message, 2);
  if (e instanceof ApiError || e instanceof AuthError) fail(e.message, 1);
  fail(e.stack || String(e), 1);
});
