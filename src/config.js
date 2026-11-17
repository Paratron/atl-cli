import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const KEYCHAIN_SERVICE = 'atl-cli';
const CONFIG_DIR = join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'atl');
export const CONFIG_FILE = join(CONFIG_DIR, 'config.json');

export function readConfigFile() {
  try {
    return JSON.parse(readFileSync(CONFIG_FILE, 'utf8'));
  } catch {
    return {};
  }
}

export function writeConfigFile(config) {
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
}

export function normalizeSite(site) {
  if (!site) return site;
  let s = site.trim().replace(/\/+$/, '');
  if (!/^https?:\/\//.test(s)) s = `https://${s}`;
  if (!s.replace(/^https?:\/\//, '').includes('.')) s = `${s}.atlassian.net`;
  return s.replace(/\/wiki$/, '');
}

export function keychainGet(account) {
  if (process.platform !== 'darwin') return null;
  try {
    return execFileSync('security', ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-a', account, '-w'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

// Uses `security -i` so the token is passed via stdin and never appears in the process list.
export function keychainSet(account, token) {
  if (process.platform !== 'darwin') {
    throw new Error('Keychain storage is only supported on macOS. Use the ATL_TOKEN environment variable instead.');
  }
  const q = (v) => `"${String(v).replace(/(["\\])/g, '\\$1')}"`;
  const res = spawnSync('security', ['-i'], {
    input: `add-generic-password -U -s ${q(KEYCHAIN_SERVICE)} -a ${q(account)} -l ${q('atl-cli (Atlassian API token)')} -w ${q(token)}\n`,
    encoding: 'utf8',
  });
  if (res.status !== 0 || /error/i.test(res.stderr || '')) {
    throw new Error(`Could not store token in keychain: ${(res.stderr || '').trim()}`);
  }
}

export function keychainDelete(account) {
  if (process.platform !== 'darwin') return false;
  const res = spawnSync('security', ['delete-generic-password', '-s', KEYCHAIN_SERVICE, '-a', account], { stdio: 'ignore' });
  return res.status === 0;
}

export function loadConfig() {
  const file = readConfigFile();
  const site = normalizeSite(process.env.ATL_SITE || file.site);
  const email = process.env.ATL_EMAIL || file.email;
  const token = process.env.ATL_TOKEN || (email ? keychainGet(email) : null);
  return { site, email, token, cloudId: normalizeSite(file.site) === site ? file.cloudId : undefined };
}
