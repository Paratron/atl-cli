import { spawnSync } from 'node:child_process';
import { readPrivateFile, removePrivateFile, writePrivateFile } from './config.js';

const SERVICE = 'atl-cli';
const LABEL = 'atl-cli (Atlassian API token)';

// Secrets are always passed via stdin, never as command line arguments (visible in the process list).
function run(cmd, args, input) {
  const res = spawnSync(cmd, args, { input, encoding: 'utf8', windowsHide: true });
  if (res.error) return { ok: false, missing: res.error.code === 'ENOENT', out: '', err: res.error.message };
  return { ok: res.status === 0, out: (res.stdout || '').replace(/\r?\n$/, ''), err: (res.stderr || '').trim() };
}

const fileKey = (account) => `token-${account.replace(/[^\w.@-]/g, '_')}`;

// macOS: login keychain via `security`.
const keychain = {
  name: 'macOS keychain',
  available: () => process.platform === 'darwin',
  get: (account) => {
    const r = run('security', ['find-generic-password', '-s', SERVICE, '-a', account, '-w']);
    return r.ok ? r.out : null;
  },
  set: (account, token) => {
    const q = (v) => `"${String(v).replace(/(["\\])/g, '\\$1')}"`;
    const r = run('security', ['-i'], `add-generic-password -U -s ${q(SERVICE)} -a ${q(account)} -l ${q(LABEL)} -w ${q(token)}\n`);
    if (!r.ok || /error/i.test(r.err)) throw new Error(`Could not store token in keychain: ${r.err}`);
  },
  delete: (account) => run('security', ['delete-generic-password', '-s', SERVICE, '-a', account]).ok,
};

// Linux: Secret Service (GNOME Keyring, KWallet, KeePassXC) via `secret-tool` from libsecret.
const secretService = {
  name: 'Secret Service (secret-tool)',
  available: () => process.platform === 'linux' && !run('secret-tool', ['--version']).missing,
  get: (account) => {
    const r = run('secret-tool', ['lookup', 'service', SERVICE, 'account', account]);
    return r.ok && r.out ? r.out : null;
  },
  set: (account, token) => {
    const r = run('secret-tool', ['store', `--label=${LABEL}`, 'service', SERVICE, 'account', account], token);
    if (!r.ok) throw new Error(`Could not store token via secret-tool: ${r.err}\nWithout a running keyring, use ATL_SECRET_STORE=file or the ATL_TOKEN environment variable.`);
  },
  delete: (account) => run('secret-tool', ['clear', 'service', SERVICE, 'account', account]).ok,
};

// Windows: token encrypted with DPAPI (bound to the current Windows user) via PowerShell, stored in %APPDATA%\atl.
const PS = ['-NoProfile', '-NonInteractive', '-Command'];
const dpapi = {
  name: 'Windows DPAPI',
  available: () => process.platform === 'win32',
  get: (account) => {
    const blob = readPrivateFile(`${fileKey(account)}.dpapi`);
    if (!blob) return null;
    const r = run('powershell.exe', [
      ...PS,
      '$e=[Console]::In.ReadToEnd().Trim(); $s=ConvertTo-SecureString $e; [Runtime.InteropServices.Marshal]::PtrToStringBSTR([Runtime.InteropServices.Marshal]::SecureStringToBSTR($s))',
    ], blob);
    return r.ok && r.out ? r.out : null;
  },
  set: (account, token) => {
    const r = run('powershell.exe', [...PS, '$t=[Console]::In.ReadToEnd().TrimEnd(); ConvertTo-SecureString $t -AsPlainText -Force | ConvertFrom-SecureString'], token);
    if (!r.ok || !r.out) throw new Error(`Could not encrypt token with DPAPI: ${r.err}`);
    writePrivateFile(`${fileKey(account)}.dpapi`, r.out.trim());
  },
  delete: (account) => removePrivateFile(`${fileKey(account)}.dpapi`),
};

// Fallback: plain file with 0600 permissions (e.g. headless Linux without a keyring).
const plainFile = {
  name: 'file (unencrypted, 0600)',
  available: () => true,
  get: (account) => readPrivateFile(fileKey(account))?.trim() || null,
  set: (account, token) => writePrivateFile(fileKey(account), token),
  delete: (account) => removePrivateFile(fileKey(account)),
};

const STORES = { keychain, 'secret-service': secretService, dpapi, file: plainFile };

let cached;
export function secretStore() {
  if (cached) return cached;
  const forced = process.env.ATL_SECRET_STORE;
  if (forced) {
    if (!STORES[forced]) throw new Error(`Unknown ATL_SECRET_STORE "${forced}" (use ${Object.keys(STORES).join(', ')}).`);
    return (cached = STORES[forced]);
  }
  return (cached = [keychain, secretService, dpapi].find((s) => s.available()) || plainFile);
}
