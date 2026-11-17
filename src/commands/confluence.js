import { markdownToStorage } from '../markdown.js';
import { htmlToText, print, readBody, shortDate, table } from '../util.js';

function pageId(arg) {
  if (!arg) throw new Error('Missing page id or URL.');
  const m = arg.match(/\/pages\/(?:edit-v2\/)?(\d+)/) || arg.match(/pageId=(\d+)/);
  if (m) return m[1];
  if (/^\d+$/.test(arg)) return arg;
  throw new Error(`Cannot read a page id from "${arg}".`);
}

function pageUrl(client, links) {
  return links?.webui ? `${client.config.site}/wiki${links.webui}` : undefined;
}

// --format: markdown (default), storage (Confluence XHTML) or wiki (Confluence wiki markup).
function toBody(raw, format = 'markdown') {
  if (format === 'markdown' || format === 'md') return { representation: 'storage', value: markdownToStorage(raw) };
  if (format === 'wiki' || format === 'storage') return { representation: format, value: raw };
  throw new Error(`Unknown --format "${format}" (use markdown, storage or wiki).`);
}

async function spaceIdForKey(client, key) {
  const res = await client.get('/wiki/api/v2/spaces', { keys: key.toUpperCase(), limit: 1 });
  if (!res.results.length) throw new Error(`Space "${key}" not found.`);
  return res.results[0].id;
}

async function spaceKeyForId(client, id) {
  try {
    return (await client.get(`/wiki/api/v2/spaces/${id}`)).key;
  } catch {
    return undefined;
  }
}

const formatOption = { format: { type: 'string', default: 'markdown' } };

export async function userNames(client, ids) {
  const unique = [...new Set(ids.filter(Boolean))];
  const names = {};
  for (let i = 0; i < unique.length; i += 100) {
    try {
      const res = await client.postRead('/wiki/api/v2/users-bulk', { accountIds: unique.slice(i, i + 100) });
      for (const u of res.results || []) names[u.accountId] = u.displayName || u.publicName;
    } catch {}
  }
  return names;
}

export async function resolveMentions(client, texts) {
  const ids = texts.flatMap((t) => [...(t || '').matchAll(/@user:([\w:-]+)/g)].map((m) => m[1]));
  if (!ids.length) return texts;
  const names = await userNames(client, ids);
  return texts.map((t) => t && t.replace(/@user:([\w:-]+)/g, (m, id) => (names[id] ? `@${names[id]}` : m)));
}

export const page = {
  get: {
    summary: 'Show a page (body as Markdown, --raw for storage XHTML)',
    usage: 'atl page get <id|url> [--raw]',
    options: { raw: { type: 'boolean' } },
    async run(client, args, opts) {
      const id = pageId(args[0]);
      const p = await client.get(`/wiki/api/v2/pages/${id}`, { 'body-format': 'storage' });
      const storage = p.body?.storage?.value ?? '';
      const out = {
        id: p.id,
        title: p.title,
        spaceKey: await spaceKeyForId(client, p.spaceId),
        spaceId: p.spaceId,
        parentId: p.parentId,
        status: p.status,
        version: p.version?.number,
        updated: p.version?.createdAt,
        url: pageUrl(client, p._links),
        body: opts.raw ? storage : (await resolveMentions(client, [htmlToText(storage)]))[0],
      };
      print(out, opts, (o) => `${o.title}\n${o.spaceKey} · v${o.version} · updated ${shortDate(o.updated)}\n${o.url}\n\n${o.body}`);
    },
  },

  search: {
    summary: 'Search pages (CQL, or plain text)',
    usage: 'atl page search "<CQL or text>" [--space KEY] [--limit 25]',
    options: { space: { type: 'string' }, limit: { type: 'string', default: '25' } },
    async run(client, args, opts) {
      const q = args.join(' ').trim();
      if (!q) throw new Error('Missing query.');
      let cql = /[=~]|\b(AND|OR|ORDER BY)\b/.test(q) ? q : `siteSearch ~ "${q.replace(/"/g, '\\"')}" AND type = page`;
      if (opts.space) cql = `space = "${opts.space}" AND (${cql})`;
      const res = await client.get('/wiki/rest/api/search', { cql, limit: opts.limit });
      const items = res.results.map((r) => ({
        id: r.content?.id,
        type: r.content?.type,
        title: r.content?.title ?? r.title,
        space: r.resultGlobalContainer?.title,
        updated: r.lastModified,
        url: r.url ? `${client.config.site}/wiki${r.url}` : undefined,
        excerpt: htmlToText(r.excerpt || '').replace(/@@@(end)?hl@@@/g, ''),
      }));
      print(items, opts, (items) =>
        table(items.map((i) => ({ ...i, updated: shortDate(i.updated) })), [
          { key: 'id', label: 'Id' },
          { key: 'space', label: 'Space', max: 20 },
          { key: 'updated', label: 'Updated' },
          { key: 'title', label: 'Title', max: 70 },
        ]),
      );
    },
  },

  children: {
    summary: 'List child pages',
    usage: 'atl page children <id|url> [--limit 100]',
    options: { limit: { type: 'string', default: '100' } },
    async run(client, args, opts) {
      const id = pageId(args[0]);
      const res = await client.get(`/wiki/api/v2/pages/${id}/children`, { limit: opts.limit });
      const items = res.results.map((c) => ({ id: c.id, title: c.title, position: c.childPosition }));
      print(items, opts, (items) => table(items, [{ key: 'id', label: 'Id' }, { key: 'title', label: 'Title', max: 80 }]));
    },
  },

  comments: {
    summary: 'List footer and inline comments of a page',
    usage: 'atl page comments <id|url>',
    async run(client, args, opts) {
      const id = pageId(args[0]);
      const [footer, inline] = await Promise.all([
        client.get(`/wiki/api/v2/pages/${id}/footer-comments`, { 'body-format': 'storage', limit: 100 }),
        client.get(`/wiki/api/v2/pages/${id}/inline-comments`, { 'body-format': 'storage', limit: 100 }),
      ]);
      const map = (kind) => (c) => ({
        id: c.id,
        kind,
        authorId: c.version?.authorId,
        created: c.version?.createdAt,
        resolved: c.resolutionStatus ? c.resolutionStatus !== 'open' : undefined,
        inlineText: c.properties?.inlineOriginalSelection,
        body: htmlToText(c.body?.storage?.value),
      });
      const items = [...footer.results.map(map('footer')), ...inline.results.map(map('inline'))];
      const names = await userNames(client, items.map((c) => c.authorId));
      const bodies = await resolveMentions(client, items.map((c) => c.body));
      items.forEach((c, i) => {
        c.author = names[c.authorId] ?? c.authorId;
        c.body = bodies[i];
      });
      print(items, opts, (items) =>
        items
          .map((c) => `--- ${c.kind} #${c.id} · ${c.author} · ${shortDate(c.created)}${c.resolved ? ' (resolved)' : ''}${c.inlineText ? `\n> ${c.inlineText}` : ''}\n${c.body}`)
          .join('\n') || '(no comments)',
      );
    },
  },

  create: {
    summary: 'Create a page',
    usage: 'atl page create --space KEY --title "<title>" [--parent <id|url>] [--body ..|--file <path>|<stdin>] [--format markdown|storage|wiki]',
    options: { space: { type: 'string' }, title: { type: 'string' }, parent: { type: 'string' }, body: { type: 'string' }, file: { type: 'string' }, ...formatOption },
    async run(client, _args, opts) {
      if (!opts.title) throw new Error('--title is required.');
      let spaceId;
      const parentId = opts.parent ? pageId(opts.parent) : undefined;
      if (opts.space) spaceId = await spaceIdForKey(client, opts.space);
      else if (parentId) spaceId = (await client.get(`/wiki/api/v2/pages/${parentId}`)).spaceId;
      else throw new Error('--space or --parent is required.');
      const raw = (await readBody(opts, { required: false })) ?? '';
      const res = await client.post('/wiki/api/v2/pages', { spaceId, status: 'current', title: opts.title, parentId, body: toBody(raw, opts.format) });
      print(res, opts, (r) => (r.dryRun ? '' : `Created page ${r.id}: ${pageUrl(client, r._links)}`));
    },
  },

  update: {
    summary: 'Update a page (replace or append body, rename)',
    usage: 'atl page update <id|url> [--title ..] [--body ..|--file <path>|<stdin>] [--append] [--format markdown|storage|wiki] [--message "<version note>"]',
    options: {
      title: { type: 'string' },
      body: { type: 'string' },
      file: { type: 'string' },
      append: { type: 'boolean' },
      message: { type: 'string' },
      ...formatOption,
    },
    async run(client, args, opts) {
      const id = pageId(args[0]);
      const current = await client.get(`/wiki/api/v2/pages/${id}`, { 'body-format': 'storage' });
      const raw = await readBody(opts, { required: !opts.title });
      let body = { representation: 'storage', value: current.body.storage.value };
      if (raw !== undefined) {
        const next = toBody(raw, opts.format);
        if (opts.append) {
          if (next.representation !== 'storage') throw new Error('--append supports --format markdown or storage only.');
          body = { representation: 'storage', value: current.body.storage.value + next.value };
        } else {
          body = next;
        }
      }
      const res = await client.put(`/wiki/api/v2/pages/${id}`, {
        id,
        status: 'current',
        title: opts.title || current.title,
        body,
        version: { number: current.version.number + 1, message: opts.message },
      });
      print(res, opts, (r) => (r.dryRun ? '' : `Updated page ${id} to v${r.version.number}: ${pageUrl(client, r._links)}`));
    },
  },

  comment: {
    summary: 'Add a footer comment, or reply to a comment',
    usage: 'atl page comment <id|url> --body "<markdown>" [--reply-to <commentId>] [--format markdown|storage]',
    options: { body: { type: 'string' }, file: { type: 'string' }, 'reply-to': { type: 'string' }, ...formatOption },
    async run(client, args, opts) {
      const raw = await readBody(opts);
      if (opts.format === 'wiki') throw new Error('Comments support --format markdown or storage.');
      const body = toBody(raw, opts.format);
      const payload = opts['reply-to'] ? { parentCommentId: opts['reply-to'], body } : { pageId: pageId(args[0]), body };
      const res = await client.post('/wiki/api/v2/footer-comments', payload);
      print(res, opts, (r) => (r.dryRun ? '' : `Comment ${r.id} added.`));
    },
  },
};

export const space = {
  list: {
    summary: 'List spaces',
    usage: 'atl space list [--keys A,B] [--limit 50]',
    options: { keys: { type: 'string' }, limit: { type: 'string', default: '50' } },
    async run(client, _args, opts) {
      const res = await client.get('/wiki/api/v2/spaces', { keys: opts.keys, limit: opts.limit, sort: 'name' });
      const items = res.results.map((s) => ({ id: s.id, key: s.key, name: s.name, type: s.type, homepageId: s.homepageId }));
      print(items, opts, (items) => table(items, [{ key: 'key', label: 'Key' }, { key: 'name', label: 'Name', max: 50 }, { key: 'type', label: 'Type' }, { key: 'homepageId', label: 'Home page' }]));
    },
  },
};
