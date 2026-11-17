import { basename, join } from 'node:path';
import { htmlToText, print, shortDate, table } from '../util.js';
import { resolveMentions, userNames } from './confluence.js';

function pageId(arg) {
  if (!arg) throw new Error('Missing page id or URL.');
  const m = arg.match(/\/pages\/(?:edit-v2\/)?(\d+)/) || arg.match(/pageId=(\d+)/);
  if (m) return m[1];
  if (/^\d+$/.test(arg)) return arg;
  throw new Error(`Cannot read a page id from "${arg}".`);
}

function requireYes(opts, what) {
  if (!opts.yes && !opts['dry-run']) throw new Error(`Refusing to ${what} without --yes.`);
}

async function pageVersion(client, id, version) {
  const p = await client.get(`/wiki/api/v2/pages/${id}`, { 'body-format': 'storage', version });
  return { version: p.version?.number, title: p.title, text: htmlToText(p.body?.storage?.value ?? '') };
}

// Line-based LCS diff, sufficient for page-sized documents.
export function lineDiff(a, b) {
  const x = a.split('\n');
  const y = b.split('\n');
  const n = x.length;
  const m = y.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = x[i] === y[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (x[i] === y[j]) {
      out.push({ op: ' ', line: x[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) out.push({ op: '-', line: x[i++] });
    else out.push({ op: '+', line: y[j++] });
  }
  while (i < n) out.push({ op: '-', line: x[i++] });
  while (j < m) out.push({ op: '+', line: y[j++] });
  return out;
}

function unified(diff, context = 2) {
  const keep = new Set();
  diff.forEach((d, i) => {
    if (d.op !== ' ') for (let k = Math.max(0, i - context); k <= Math.min(diff.length - 1, i + context); k++) keep.add(k);
  });
  const lines = [];
  let last = -1;
  for (const i of [...keep].sort((a, b) => a - b)) {
    if (last !== -1 && i > last + 1) lines.push('…');
    lines.push(`${diff[i].op} ${diff[i].line}`);
    last = i;
  }
  return lines.join('\n');
}

export const pageMore = {
  history: {
    summary: 'List versions of a page',
    usage: 'atl page history <id|url> [--limit 25]',
    options: { limit: { type: 'string', default: '25' } },
    async run(client, args, opts) {
      const res = await client.get(`/wiki/api/v2/pages/${pageId(args[0])}/versions`, { limit: opts.limit, sort: '-modified-date' });
      const names = await userNames(client, res.results.map((v) => v.authorId));
      const items = res.results.map((v) => ({ version: v.number, when: v.createdAt, author: names[v.authorId] ?? v.authorId, message: v.message, minorEdit: v.minorEdit }));
      print(items, opts, (items) => table(items.map((v) => ({ ...v, when: shortDate(v.when) })), [{ key: 'version', label: 'Ver' }, { key: 'when', label: 'When' }, { key: 'author', label: 'Author', max: 28 }, { key: 'message', label: 'Message', max: 60 }]));
    },
  },

  diff: {
    summary: 'Diff two versions of a page (default: previous → current)',
    usage: 'atl page diff <id|url> [--from N] [--to M] [--context 2]',
    options: { from: { type: 'string' }, to: { type: 'string' }, context: { type: 'string', default: '2' } },
    async run(client, args, opts) {
      const id = pageId(args[0]);
      const to = await pageVersion(client, id, opts.to);
      const fromNo = opts.from ?? String(Math.max(1, to.version - 1));
      const from = await pageVersion(client, id, fromNo);
      [from.text, to.text] = await resolveMentions(client, [from.text, to.text]);
      const diff = lineDiff(from.text, to.text);
      const changes = diff.filter((d) => d.op !== ' ');
      print(
        { from: from.version, to: to.version, added: changes.filter((d) => d.op === '+').map((d) => d.line), removed: changes.filter((d) => d.op === '-').map((d) => d.line) },
        opts,
        () => `${to.title}: v${from.version} → v${to.version}\n\n${changes.length ? unified(diff, Number(opts.context)) : '(no text changes)'}`,
      );
    },
  },

  labels: {
    summary: 'List labels of a page',
    usage: 'atl page labels <id|url>',
    async run(client, args, opts) {
      const res = await client.get(`/wiki/api/v2/pages/${pageId(args[0])}/labels`, { limit: 100 });
      const items = res.results.map((l) => l.name);
      print(items, opts, (items) => items.join(', ') || '(no labels)');
    },
  },

  label: {
    summary: 'Add labels to a page (--remove to remove)',
    usage: 'atl page label <id|url> <label>... [--remove]',
    options: { remove: { type: 'boolean' } },
    async run(client, args, opts) {
      const id = pageId(args[0]);
      const labels = args.slice(1);
      if (!labels.length) throw new Error('Give at least one label.');
      if (opts.remove) {
        for (const l of labels) await client.delete(`/wiki/rest/api/content/${id}/label/${encodeURIComponent(l)}`);
      } else {
        await client.post(`/wiki/rest/api/content/${id}/label`, labels.map((name) => ({ prefix: 'global', name })));
      }
      if (!opts['dry-run']) print({ id, [opts.remove ? 'removed' : 'added']: labels }, opts, () => `${opts.remove ? 'Removed' : 'Added'} label(s): ${labels.join(', ')}`);
    },
  },

  attachments: {
    summary: 'List attachments of a page',
    usage: 'atl page attachments <id|url>',
    async run(client, args, opts) {
      const res = await client.get(`/wiki/api/v2/pages/${pageId(args[0])}/attachments`, { limit: 250 });
      const items = res.results.map((a) => ({ id: a.id, title: a.title, mediaType: a.mediaType, size: a.fileSize, downloadLink: a.downloadLink }));
      print(items, opts, (items) => table(items, [{ key: 'id', label: 'Id' }, { key: 'title', label: 'File', max: 50 }, { key: 'size', label: 'Bytes' }, { key: 'mediaType', label: 'Type' }]));
    },
  },

  download: {
    summary: 'Download page attachments (all, or by id/filename)',
    usage: 'atl page download <id|url> [id|filename]... [--dir .]',
    options: { dir: { type: 'string', default: '.' } },
    async run(client, args, opts) {
      const res = await client.get(`/wiki/api/v2/pages/${pageId(args[0])}/attachments`, { limit: 250 });
      const want = args.slice(1);
      const files = res.results.filter((a) => !want.length || want.includes(a.id) || want.includes(a.title));
      const saved = [];
      for (const a of files) saved.push(await client.download(`/wiki${a.downloadLink}`, join(opts.dir, basename(a.title))));
      print(saved, opts, (s) => s.join('\n') || '(nothing to download)');
    },
  },

  attach: {
    summary: 'Upload files to a page (replaces attachments with the same name)',
    usage: 'atl page attach <id|url> <file>... [--comment "<text>"]',
    options: { comment: { type: 'string' } },
    async run(client, args, opts) {
      const id = pageId(args[0]);
      if (args.length < 2) throw new Error('Give at least one file.');
      const res = await client.upload('PUT', `/wiki/rest/api/content/${id}/child/attachment`, args.slice(1), { comment: opts.comment, minorEdit: 'true' });
      print(res, opts, (r) => (r.dryRun ? '' : (r.results || []).map((a) => `Attached ${a.title} (${a.id})`).join('\n')));
    },
  },

  move: {
    summary: 'Move a page under another parent page',
    usage: 'atl page move <id|url> --parent <id|url>',
    options: { parent: { type: 'string' } },
    async run(client, args, opts) {
      const id = pageId(args[0]);
      if (!opts.parent) throw new Error('--parent is required.');
      const res = await client.put(`/wiki/rest/api/content/${id}/move/append/${pageId(opts.parent)}`);
      print(res ?? { moved: id }, opts, (r) => (r.dryRun ? '' : `Page ${id} moved under ${pageId(opts.parent)}.`));
    },
  },

  delete: {
    summary: 'Move a page to the trash (requires --yes)',
    usage: 'atl page delete <id|url> --yes',
    options: { yes: { type: 'boolean' } },
    async run(client, args, opts) {
      const id = pageId(args[0]);
      requireYes(opts, `delete page ${id}`);
      const res = await client.delete(`/wiki/api/v2/pages/${id}`);
      print(res ?? { trashed: id }, opts, (r) => (r.dryRun ? '' : `Page ${id} moved to trash.`));
    },
  },

  tree: {
    summary: 'Show the page tree below a page',
    usage: 'atl page tree <id|url> [--depth 3]',
    options: { depth: { type: 'string', default: '3' } },
    async run(client, args, opts) {
      const id = pageId(args[0]);
      const items = [];
      let cursor;
      do {
        const res = await client.get(`/wiki/api/v2/pages/${id}/descendants`, { depth: opts.depth, limit: 250, cursor });
        items.push(...res.results.filter((r) => r.type === 'page').map((r) => ({ id: r.id, title: r.title, parentId: r.parentId, depth: r.depth, position: r.childPosition })));
        cursor = res._links?.next ? new URL(res._links.next, client.config.site).searchParams.get('cursor') : undefined;
      } while (cursor);
      const byParent = new Map();
      for (const it of items) byParent.set(it.parentId, [...(byParent.get(it.parentId) || []), it]);
      const lines = [];
      const walk = (pid, indent) => {
        for (const c of (byParent.get(pid) || []).sort((a, b) => (a.position ?? 0) - (b.position ?? 0))) {
          lines.push(`${'  '.repeat(indent)}- ${c.title} (${c.id})`);
          walk(c.id, indent + 1);
        }
      };
      walk(id, 0);
      print(items, opts, () => lines.join('\n') || '(no child pages)');
    },
  },
};
