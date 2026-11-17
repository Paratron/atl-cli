import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { secretStore } from './secrets.js';

function configDir() {
  if (process.env.ATL_CONFIG_DIR) return process.env.ATL_CONFIG_DIR;
  if (process.platform === 'win32') return join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'atl');
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'atl');
}

export const CONFIG_DIR = configDir();
export const CONFIG_FILE = join(CONFIG_DIR, 'config.json');

export function readConfigFile() {
  try {
    return JSON.parse(readFileSync(CONFIG_FILE, 'utf8'));
  } catch {
    return {};
  }
}

export function writeConfigFile(config) {
  mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
}

export function writePrivateFile(name, content) {
  mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  writeFileSync(join(CONFIG_DIR, name), content, { mode: 0o600 });
}

export function readPrivateFile(name) {
  try {
    return readFileSync(join(CONFIG_DIR, name), 'utf8');
  } catch {
    return null;
  }
}

export function removePrivateFile(name) {
  try {
    rmSync(join(CONFIG_DIR, name));
    return true;
  } catch {
    return false;
  }
}

export function normalizeSite(site) {
  if (!site) return site;
  let s = site.trim().replace(/\/+$/, '');
  if (!/^https?:\/\//.test(s)) s = `https://${s}`;
  if (!s.replace(/^https?:\/\//, '').includes('.')) s = `${s}.atlassian.net`;
  return s.replace(/\/wiki$/, '');
}

export function loadConfig() {
  const file = readConfigFile();
  const site = normalizeSite(process.env.ATL_SITE || file.site);
  const email = process.env.ATL_EMAIL || file.email;
  let token = process.env.ATL_TOKEN || null;
  let tokenSource = token ? 'ATL_TOKEN' : null;
  if (!token && email) {
    const store = secretStore();
    token = store.get(email);
    if (token) tokenSource = store.name;
  }
  return { site, email, token, tokenSource, cloudId: normalizeSite(file.site) === site ? file.cloudId : undefined };
}
