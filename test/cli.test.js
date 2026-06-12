import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import http from 'node:http';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const run = promisify(execFile);
const CLI = new URL('../src/cli.js', import.meta.url).pathname;

let server;
let port;
const requests = [];

before(async () => {
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const parsed = body ? JSON.parse(body) : {};
      requests.push({ url: req.url, body: parsed, auth: req.headers.authorization });
      if (req.url === '/contacts.list') {
        const number = parsed.page?.number ?? 1;
        const size = parsed.page?.size ?? 20;
        const total = 25;
        const start = (number - 1) * size;
        const data = Array.from({ length: Math.max(0, Math.min(size, total - start)) }, (_, i) => ({
          id: `id-${start + i}`,
          first_name: 'Jane',
          last_name: `Doe${start + i}`,
          emails: [{ type: 'primary', email: 'jane@x.eu' }],
        }));
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ data }));
      } else if (req.url === '/contacts.info') {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ data: { id: parsed.id, first_name: 'Jane', company: { type: 'company', id: 'c-1' } } }));
      } else if (req.url === '/contacts.delete') {
        res.statusCode = 204;
        res.end();
      } else if (req.url === '/deals.create') {
        res.statusCode = 400;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ errors: [{ title: 'Invalid phase id', status: 400 }] }));
      } else {
        res.statusCode = 404;
        res.end('{}');
      }
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  port = server.address().port;
});

after(() => server.close());

function env() {
  const dir = mkdtempSync(join(tmpdir(), 'tlcli-'));
  const cfg = join(dir, 'credentials.json');
  writeFileSync(cfg, JSON.stringify({ access_token: 'test-token', expires_at: Date.now() + 3600_000 }));
  return {
    ...process.env,
    TEAMLEADER_API_BASE: `http://127.0.0.1:${port}`,
    TEAMLEADER_CLI_CONFIG: cfg,
    NO_COLOR: '1',
  };
}

test('list renders a table and sends the right body', async () => {
  const { stdout } = await run('node', [CLI, 'contacts', 'list', '--filter.term', 'jane', '--limit', '5'], { env: env() });
  assert.match(stdout, /first_name/);
  assert.match(stdout, /Doe0/);
  const req = requests.find((r) => r.body.filter?.term === 'jane');
  assert.deepEqual(req.body.page, { size: 5 });
  assert.equal(req.auth, 'Bearer test-token');
});

test('--json returns the raw API response', async () => {
  const { stdout } = await run('node', [CLI, 'contacts', 'list', '--json'], { env: env() });
  const parsed = JSON.parse(stdout);
  assert.ok(Array.isArray(parsed.data));
});

test('--all paginates until the last page', async () => {
  requests.length = 0;
  const { stdout } = await run('node', [CLI, 'contacts', 'list', '--all', '--limit', '10', '--json'], { env: env() });
  const parsed = JSON.parse(stdout);
  assert.equal(parsed.data.length, 25);
  assert.equal(requests.length, 3);
});

test('info renders a detail view', async () => {
  const { stdout } = await run('node', [CLI, 'contacts', 'info', 'abc-1'], { env: env() });
  assert.match(stdout, /first_name\s+Jane/);
  assert.match(stdout, /company\.type\s+company/);
  assert.match(stdout, /company\.id\s+c-1/);
});

test('delete without --rm is blocked and does not hit the API', async () => {
  requests.length = 0;
  await assert.rejects(
    () => run('node', [CLI, 'contacts', 'delete', 'abc-1'], { env: env() }),
    (e) => e.code === 2 && /safe mode/.test(e.stderr)
  );
  assert.equal(requests.length, 0);
});

test('delete with --rm succeeds on 204', async () => {
  const { stdout } = await run('node', [CLI, 'contacts', 'delete', 'abc-1', '--rm'], { env: env() });
  assert.match(stdout, /contacts.delete ok/);
});

test('API errors surface title and status', async () => {
  await assert.rejects(
    () => run('node', [CLI, 'deals', 'create', '--title', 'x', '--lead.customer.type', 'company', '--lead.customer.id', 'c-1'], { env: env() }),
    (e) => e.code === 1 && /HTTP 400/.test(e.stderr) && /Invalid phase id/.test(e.stderr)
  );
});

test('unauthenticated calls fail with guidance', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tlcli-noauth-'));
  const e = { ...process.env, TEAMLEADER_CLI_CONFIG: join(dir, 'nope.json'), NO_COLOR: '1' };
  delete e.TEAMLEADER_ACCESS_TOKEN;
  await assert.rejects(
    () => run('node', [CLI, 'contacts', 'list'], { env: e }),
    (err) => /tl auth login/.test(err.stderr)
  );
});

test('commands --json is machine readable', async () => {
  const { stdout } = await run('node', [CLI, 'commands', '--json'], { env: env(), maxBuffer: 64 * 1024 * 1024 });
  const parsed = JSON.parse(stdout);
  assert.equal(parsed.length, 292);
  const del = parsed.find((c) => c.command === 'tl contacts delete');
  assert.equal(del.destructive, true);
});
