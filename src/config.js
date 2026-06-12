import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export function configPath() {
  if (process.env.TEAMLEADER_CLI_CONFIG) return process.env.TEAMLEADER_CLI_CONFIG;
  const base = process.env.XDG_CONFIG_HOME || join(homedir(), '.config');
  return join(base, 'teamleader-cli', 'credentials.json');
}

export function readConfig() {
  try {
    return JSON.parse(readFileSync(configPath(), 'utf8'));
  } catch {
    return {};
  }
}

export function writeConfig(config) {
  const file = configPath();
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
  chmodSync(file, 0o600);
}

export function deleteConfig() {
  if (existsSync(configPath())) rmSync(configPath());
}

/** Credentials with environment variable overrides (env wins). */
export function credentials() {
  const cfg = readConfig();
  return {
    clientId: process.env.TEAMLEADER_CLIENT_ID || cfg.client_id,
    clientSecret: process.env.TEAMLEADER_CLIENT_SECRET || cfg.client_secret,
    accessToken: process.env.TEAMLEADER_ACCESS_TOKEN || cfg.access_token,
    refreshToken: process.env.TEAMLEADER_REFRESH_TOKEN || cfg.refresh_token,
    expiresAt: process.env.TEAMLEADER_ACCESS_TOKEN ? null : cfg.expires_at,
  };
}

export function saveTokens({ access_token, refresh_token, expires_in }) {
  const cfg = readConfig();
  cfg.access_token = access_token;
  if (refresh_token) cfg.refresh_token = refresh_token;
  cfg.expires_at = Date.now() + (expires_in ? expires_in * 1000 : 3600_000);
  writeConfig(cfg);
  return cfg;
}
