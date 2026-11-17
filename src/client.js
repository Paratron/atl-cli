import { loadConfig, readConfigFile, writeConfigFile } from './config.js';

export class AtlError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

function errorMessage(status, text) {
  try {
    const j = JSON.parse(text);
    const parts = [
      ...(j.errorMessages || []),
      ...Object.entries(j.errors && !Array.isArray(j.errors) ? j.errors : {}).map(([k, v]) => `${k}: ${v}`),
      ...(Array.isArray(j.errors) ? j.errors.map((e) => e.title || e.message || JSON.stringify(e)) : []),
      j.message,
    ].filter(Boolean);
    if (parts.length) return `HTTP ${status}: ${parts.join('; ')}`;
  } catch {}
  return `HTTP ${status}: ${text.slice(0, 500) || 'no response body'}`;
}

export class Client {
  constructor({ dryRun = false } = {}) {
    this.config = loadConfig();
    this.dryRun = dryRun;
  }

  ensureAuth() {
    const { site, email, token } = this.config;
    if (!site || !email) throw new AtlError('Not configured. Run: atl auth login --site <your-site> --email <you@example.com>');
    if (!token) throw new AtlError(`No API token found for ${email}. Run: atl auth login (or set ATL_TOKEN)`);
  }

  get authHeader() {
    return 'Basic ' + Buffer.from(`${this.config.email}:${this.config.token}`).toString('base64');
  }

  url(path, query) {
    const url = new URL(path.startsWith('http') ? path : this.config.site + path);
    for (const [k, v] of Object.entries(query || {})) {
      if (v === undefined || v === null || v === '') continue;
      if (Array.isArray(v)) v.forEach((x) => url.searchParams.append(k, x));
      else url.searchParams.set(k, String(v));
    }
    return url;
  }

  async request(method, path, { query, body, headers = {} } = {}) {
    this.ensureAuth();
    const url = this.url(path, query);
    if (this.dryRun && method !== 'GET' && !headers['x-atl-readonly']) {
      const shown = body instanceof FormData ? Object.fromEntries([...body].map(([k, v]) => [k, v?.name ?? v])) : body;
      process.stdout.write(JSON.stringify({ dryRun: true, method, url: url.toString(), body: shown }, null, 2) + '\n');
      return { dryRun: true };
    }
    delete headers['x-atl-readonly'];
    const isForm = body instanceof FormData;
    const res = await fetch(url, {
      method,
      headers: {
        Authorization: this.authHeader,
        Accept: 'application/json',
        ...(body !== undefined && !isForm ? { 'Content-Type': 'application/json' } : {}),
        ...headers,
      },
      body: body === undefined ? undefined : isForm ? body : JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) throw new AtlError(errorMessage(res.status, text), res.status);
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }

  get(path, query) {
    return this.request('GET', path, { query });
  }
  // POST endpoints that only read data (still executed in --dry-run).
  postRead(path, body) {
    return this.request('POST', path, { body, headers: { 'x-atl-readonly': '1' } });
  }
  post(path, body, query) {
    return this.request('POST', path, { body, query });
  }
  put(path, body, query) {
    return this.request('PUT', path, { body, query });
  }
  delete(path, query) {
    return this.request('DELETE', path, { query });
  }

  async upload(method, path, files, extraFields = {}) {
    const { readFileSync } = await import('node:fs');
    const { basename } = await import('node:path');
    const form = new FormData();
    for (const f of files) form.append('file', new Blob([readFileSync(f)]), basename(f));
    for (const [k, v] of Object.entries(extraFields)) if (v !== undefined) form.append(k, v);
    return this.request(method, path, { body: form, headers: { 'X-Atlassian-Token': 'no-check' } });
  }

  async download(path, dest) {
    this.ensureAuth();
    const { createWriteStream } = await import('node:fs');
    const { Readable } = await import('node:stream');
    const { pipeline } = await import('node:stream/promises');
    const res = await fetch(this.url(path), { headers: { Authorization: this.authHeader } });
    if (!res.ok) throw new AtlError(`Download failed: HTTP ${res.status}`, res.status);
    await pipeline(Readable.fromWeb(res.body), createWriteStream(dest));
    return dest;
  }

  async graphql(query, variables = {}, { readOnly = false, experimental } = {}) {
    const headers = {};
    if (experimental) headers['X-ExperimentalApi'] = experimental;
    if (readOnly) headers['x-atl-readonly'] = '1';
    const res = await this.request('POST', '/gateway/api/graphql', { body: { query, variables }, headers });
    if (res?.dryRun) return res;
    if (res?.errors?.length) {
      const msgs = res.errors.filter((e) => !/operation name/i.test(e.message)).map((e) => e.message);
      if (msgs.length) throw new AtlError(`GraphQL: ${msgs.join('; ')}`);
    }
    return res?.data;
  }

  async cloudId() {
    if (this.config.cloudId) return this.config.cloudId;
    const res = await fetch(`${this.config.site}/_edge/tenant_info`);
    if (!res.ok) throw new AtlError(`Could not resolve cloudId for ${this.config.site} (HTTP ${res.status})`);
    const { cloudId } = await res.json();
    this.config.cloudId = cloudId;
    const file = readConfigFile();
    if (file.site && file.site === this.config.site) writeConfigFile({ ...file, cloudId });
    return cloudId;
  }
}
