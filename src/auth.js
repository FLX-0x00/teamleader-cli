import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import readline from 'node:readline';
import { credentials, readConfig, writeConfig, deleteConfig, saveTokens, configPath } from './config.js';
import { exchangeToken, whoAmI, AUTH_BASE } from './api.js';
import { bold, cyan, green, dim, fail, notice, warn, printJson } from './output.js';

const DEFAULT_PORT = 41330;

function ask(question, { hidden = false } = {}) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
    rl.question(question, (answer) => {
      rl.close();
      if (hidden) process.stderr.write('\n');
      resolve(answer.trim());
    });
    if (hidden) rl._writeToOutput = () => {};
  });
}

function tryOpenBrowser(url) {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
  try {
    spawn(cmd, [url], { detached: true, stdio: 'ignore' }).on('error', () => {}).unref();
  } catch {
    /* best effort */
  }
}

function extractCode(input, expectedState) {
  // accepts a full redirect URL or a bare authorization code
  try {
    const url = new URL(input);
    const code = url.searchParams.get('code');
    const state = url.searchParams.get('state');
    if (code) {
      if (expectedState && state && state !== expectedState) {
        throw new Error('state mismatch — use the URL from the login attempt started by this command');
      }
      return code;
    }
  } catch (e) {
    if (e.message.includes('state mismatch')) throw e;
  }
  return input;
}

function waitForCallback(port, expectedState) {
  let server;
  const promise = new Promise((resolve, reject) => {
    server = http.createServer((req, res) => {
      const url = new URL(req.url, `http://localhost:${port}`);
      if (url.pathname !== '/oauth/callback') {
        res.writeHead(404).end();
        return;
      }
      const error = url.searchParams.get('error');
      const code = url.searchParams.get('code');
      const state = url.searchParams.get('state');
      res.writeHead(200, { 'Content-Type': 'text/html' });
      if (error || !code || state !== expectedState) {
        res.end('<h2>Login failed</h2><p>Check your terminal.</p>');
        reject(new Error(error ? `authorization denied: ${error}` : 'invalid callback (missing code or state mismatch)'));
      } else {
        res.end('<h2>&#10003; Authenticated</h2><p>You can close this tab and return to the terminal.</p>');
        resolve(code);
      }
    });
    server.on('error', (e) => reject(new Error(`could not listen on port ${port}: ${e.message}`)));
    server.listen(port, '127.0.0.1');
  });
  return { promise, close: () => server && server.close() };
}

export async function login(opts) {
  const cfg = readConfig();
  let clientId = opts['client-id'] || process.env.TEAMLEADER_CLIENT_ID || cfg.client_id;
  let clientSecret = opts['client-secret'] || process.env.TEAMLEADER_CLIENT_SECRET || cfg.client_secret;
  const port = Number(opts.port) || DEFAULT_PORT;
  const redirectUri = `http://localhost:${port}/oauth/callback`;

  if (!clientId || !clientSecret) {
    process.stderr.write(`
${bold('Teamleader CLI — first time setup')}

You need a (free) OAuth integration in the Teamleader Marketplace:

  1. Open ${cyan('https://marketplace.focus.teamleader.eu/eu/en/build')}
     and sign in with your Teamleader Focus account.
  2. Click ${bold('Create a new integration')} (a private integration is fine).
  3. Under OAuth settings, add this ${bold('redirect URI')} (must match exactly):
       ${cyan(redirectUri)}
  4. Select all ${bold('scopes')} you want the CLI to be able to use.
  5. Copy the ${bold('client ID')} and ${bold('client secret')} and paste them below.

`);
    if (!clientId) clientId = await ask('Client ID: ');
    if (!clientSecret) clientSecret = await ask('Client secret: ', { hidden: true });
    if (!clientId || !clientSecret) fail('client ID and client secret are required');
    cfg.client_id = clientId;
    cfg.client_secret = clientSecret;
    writeConfig(cfg);
  }

  const state = randomBytes(16).toString('hex');
  const authorizeUrl =
    `${AUTH_BASE}/oauth2/authorize?client_id=${encodeURIComponent(clientId)}` +
    `&response_type=code&redirect_uri=${encodeURIComponent(redirectUri)}&state=${state}`;

  process.stderr.write(`
Open this URL in your browser to authorize the CLI:

  ${cyan(authorizeUrl)}

`);

  let code;
  if (opts.manual) {
    notice('Manual mode: after authorizing, your browser is redirected to a localhost URL.');
    notice('Copy that full URL (or just the value of its "code" parameter) and paste it here.');
    const input = await ask('Redirect URL or code: ');
    if (!input) fail('no code provided');
    code = extractCode(input, state);
  } else {
    tryOpenBrowser(authorizeUrl);
    const callback = waitForCallback(port, state);
    notice(`Waiting for the OAuth callback on ${redirectUri} ...`);
    notice('(no browser on this machine? cancel and run: tl auth login --manual)');
    const timeout = new Promise((_, rej) =>
      setTimeout(() => rej(new Error('timed out after 5 minutes')), 300_000)
    );
    try {
      code = await Promise.race([callback.promise, timeout]);
    } finally {
      callback.close();
    }
  }

  const tokens = await exchangeToken({
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
  });
  saveTokens(tokens);

  const me = await whoAmI().catch(() => null);
  const name = me ? `${me.first_name} ${me.last_name} <${me.email}>` : '(unknown user)';
  process.stderr.write(green('✓') + ` logged in as ${bold(name)}\n`);
  notice(`tokens stored in ${configPath()} (access token auto-refreshes)`);
}

export async function status(opts) {
  const creds = credentials();
  const me = creds.accessToken || creds.refreshToken ? await whoAmI().catch((e) => ({ error: e.message })) : null;
  if (opts.json) {
    printJson({
      config_file: configPath(),
      client_id: creds.clientId || null,
      has_client_secret: !!creds.clientSecret,
      has_access_token: !!creds.accessToken,
      has_refresh_token: !!creds.refreshToken,
      access_token_expires_at: creds.expiresAt ? new Date(creds.expiresAt).toISOString() : null,
      access_token_from_env: !!process.env.TEAMLEADER_ACCESS_TOKEN,
      user: me && !me.error ? { id: me.id, first_name: me.first_name, last_name: me.last_name, email: me.email } : null,
      error: me?.error || null,
    });
    return;
  }
  process.stdout.write(`config file      ${configPath()}\n`);
  process.stdout.write(`client id        ${creds.clientId || dim('(not set)')}\n`);
  process.stdout.write(`client secret    ${creds.clientSecret ? 'set' : dim('(not set)')}\n`);
  process.stdout.write(`access token     ${creds.accessToken ? 'set' : dim('(not set)')}${process.env.TEAMLEADER_ACCESS_TOKEN ? ' (from env)' : ''}\n`);
  process.stdout.write(`refresh token    ${creds.refreshToken ? 'set' : dim('(not set)')}\n`);
  if (creds.expiresAt) {
    const left = Math.round((creds.expiresAt - Date.now()) / 1000);
    process.stdout.write(`token expires    ${new Date(creds.expiresAt).toISOString()} (${left > 0 ? `in ${left}s` : 'expired, will auto-refresh'})\n`);
  }
  if (!me) {
    warn('not authenticated — run: tl auth login');
  } else if (me.error) {
    warn(`API check failed: ${me.error}`);
  } else {
    process.stdout.write(green('✓') + ` authenticated as ${me.first_name} ${me.last_name} <${me.email}>\n`);
  }
}

export async function refresh() {
  const creds = credentials();
  if (!creds.refreshToken) fail('no refresh token stored — run: tl auth login');
  const tokens = await exchangeToken({
    client_id: creds.clientId,
    client_secret: creds.clientSecret,
    grant_type: 'refresh_token',
    refresh_token: creds.refreshToken,
  });
  saveTokens(tokens);
  process.stderr.write(green('✓') + ' access token refreshed\n');
}

export function logout(opts) {
  if (opts.full) {
    deleteConfig();
    process.stderr.write(green('✓') + ' removed all stored credentials (including client ID/secret)\n');
    return;
  }
  const cfg = readConfig();
  delete cfg.access_token;
  delete cfg.refresh_token;
  delete cfg.expires_at;
  writeConfig(cfg);
  process.stderr.write(green('✓') + ' tokens removed (client ID/secret kept — use --full to remove everything)\n');
}
