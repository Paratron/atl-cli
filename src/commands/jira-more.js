import { basename, join } from 'node:path';
import { markdownToJira } from '../markdown.js';
import { print, shortDate, table } from '../util.js';

function issueKey(arg) {
  if (!arg) throw new Error('Missing issue key.');
  const m = arg.match(/browse\/([A-Z][A-Z0-9_]+-\d+)/i);
  return (m ? m[1] : arg).toUpperCase();
}

function requireYes(opts, what) {
  if (!opts.yes && !opts['dry-run']) throw new Error(`Refusing to ${what} without --yes.`);
}

async function accountId(client, who) {
  if (!who || who === 'me') return (await client.get('/rest/api/2/myself')).accountId;
  if (/^[0-9a-f:-]{20,}$/i.test(who)) return who;
  const users = (await client.get('/rest/api/2/user/search', { query: who, maxResults: 10 })).filter((u) => u.accountType === 'atlassian' && u.active !== false);
  if (users.length !== 1) throw new Error(users.length ? `"${who}" is ambiguous: ${users.map((u) => u.displayName).join(', ')}` : `No user found for "${who}".`);
  return users[0].accountId;
}

// Jira's started format: 2026-11-17T10:00:00.000+0100
function jiraDate(input) {
  const d = input ? new Date(input) : new Date();
  if (Number.isNaN(d.getTime())) throw new Error(`Invalid date "${input}".`);
  const p = (n, l = 2) => String(Math.abs(n)).padStart(l, '0');
  const off = -d.getTimezoneOffset();
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}${off >= 0 ? '+' : '-'}${p(Math.floor(Math.abs(off) / 60))}${p(Math.abs(off) % 60)}`;
}

export const issueMore = {
  link: {
    summary: 'Link two issues, e.g. "atl issue link A-1 blocks B-2" or "A-1 relates to B-2"',
    usage: 'atl issue link <KEY> "<link type | outward | inward phrase>" <OTHER-KEY> [--comment <markdown>]',
    options: { comment: { type: 'string' } },
    async run(client, args, opts) {
      if (args.length < 3) throw new Error('Usage: atl issue link <KEY> "<relation>" <OTHER-KEY>');
      const a = issueKey(args[0]);
      const b = issueKey(args[args.length - 1]);
      const phrase = args.slice(1, -1).join(' ').toLowerCase();
      const { issueLinkTypes } = await client.get('/rest/api/2/issueLinkType');
      let type = issueLinkTypes.find((t) => t.outward.toLowerCase() === phrase || t.name.toLowerCase() === phrase);
      let swap = false;
      if (!type) {
        type = issueLinkTypes.find((t) => t.inward.toLowerCase() === phrase);
        swap = Boolean(type);
      }
      if (!type) throw new Error(`Unknown relation "${phrase}". Available: ${issueLinkTypes.map((t) => `${t.outward} / ${t.inward}`).join(', ')}`);
      // In POST /issueLink the "inwardIssue" is the one the outward phrase applies to ("A blocks B" => inward A, outward B).
      const [from, to] = swap ? [b, a] : [a, b];
      const body = { type: { name: type.name }, inwardIssue: { key: from }, outwardIssue: { key: to } };
      if (opts.comment) body.comment = { body: markdownToJira(opts.comment) };
      const res = await client.post('/rest/api/2/issueLink', body);
      if (res?.dryRun) return;
      const check = await client.get(`/rest/api/2/issue/${a}`, { fields: 'issuelinks' });
      const link = check.fields.issuelinks.find((l) => (l.outwardIssue || l.inwardIssue)?.key === b && l.type.name === type.name);
      const desc = link ? `${a} ${link.outwardIssue ? link.type.outward : link.type.inward} ${b}` : `${type.name} link created`;
      print({ id: link?.id, relation: desc }, opts, () => `Linked: ${desc}`);
    },
  },

  unlink: {
    summary: 'Remove an issue link (link id from "atl issue links")',
    usage: 'atl issue unlink <linkId>',
    async run(client, args, opts) {
      if (!args[0]) throw new Error('Missing link id.');
      const res = await client.delete(`/rest/api/2/issueLink/${args[0]}`);
      print(res ?? { removed: args[0] }, opts, (r) => (r.dryRun ? '' : `Link ${args[0]} removed.`));
    },
  },

  links: {
    summary: 'List links of an issue (with link ids)',
    usage: 'atl issue links <KEY>',
    async run(client, args, opts) {
      const key = issueKey(args[0]);
      const i = await client.get(`/rest/api/2/issue/${key}`, { fields: 'issuelinks' });
      const items = i.fields.issuelinks.map((l) => {
        const o = l.outwardIssue || l.inwardIssue;
        return { id: l.id, relation: l.outwardIssue ? l.type.outward : l.type.inward, key: o.key, status: o.fields?.status?.name, summary: o.fields?.summary };
      });
      print(items, opts, (items) => table(items, [{ key: 'id', label: 'Link id' }, { key: 'relation', label: 'Relation' }, { key: 'key', label: 'Issue' }, { key: 'status', label: 'Status' }, { key: 'summary', label: 'Summary', max: 60 }]));
    },
  },

  'link-types': {
    summary: 'List available issue link types',
    usage: 'atl issue link-types',
    async run(client, _args, opts) {
      const { issueLinkTypes } = await client.get('/rest/api/2/issueLinkType');
      const items = issueLinkTypes.map((t) => ({ name: t.name, outward: t.outward, inward: t.inward }));
      print(items, opts, (items) => table(items, [{ key: 'name', label: 'Name' }, { key: 'outward', label: 'Outward' }, { key: 'inward', label: 'Inward' }]));
    },
  },

  'remote-link': {
    summary: 'Add a web link to an issue',
    usage: 'atl issue remote-link <KEY> <url> [--title "<text>"]',
    options: { title: { type: 'string' } },
    async run(client, args, opts) {
      const key = issueKey(args[0]);
      if (!args[1]) throw new Error('Missing URL.');
      const res = await client.post(`/rest/api/2/issue/${key}/remotelink`, { object: { url: args[1], title: opts.title || args[1] } });
      print(res, opts, (r) => (r.dryRun ? '' : `Web link added to ${key}.`));
    },
  },

  watchers: {
    summary: 'List watchers of an issue',
    usage: 'atl issue watchers <KEY>',
    async run(client, args, opts) {
      const res = await client.get(`/rest/api/2/issue/${issueKey(args[0])}/watchers`);
      const items = res.watchers.map((w) => ({ name: w.displayName, accountId: w.accountId }));
      print(items, opts, (items) => items.map((w) => w.name).join('\n') || '(no watchers)');
    },
  },

  watch: {
    summary: 'Add a watcher (default: me)',
    usage: 'atl issue watch <KEY> [user]',
    async run(client, args, opts) {
      const key = issueKey(args[0]);
      const id = await accountId(client, args.slice(1).join(' ') || 'me');
      const res = await client.post(`/rest/api/2/issue/${key}/watchers`, id);
      print(res ?? { key, watching: id }, opts, (r) => (r.dryRun ? '' : `Watching ${key}.`));
    },
  },

  unwatch: {
    summary: 'Remove a watcher (default: me)',
    usage: 'atl issue unwatch <KEY> [user]',
    async run(client, args, opts) {
      const key = issueKey(args[0]);
      const id = await accountId(client, args.slice(1).join(' ') || 'me');
      const res = await client.delete(`/rest/api/2/issue/${key}/watchers`, { accountId: id });
      print(res ?? { key, unwatched: id }, opts, (r) => (r.dryRun ? '' : `Stopped watching ${key}.`));
    },
  },

  worklog: {
    summary: 'List worklogs of an issue',
    usage: 'atl issue worklog <KEY>',
    async run(client, args, opts) {
      const res = await client.get(`/rest/api/2/issue/${issueKey(args[0])}/worklog`, { maxResults: 100 });
      const items = res.worklogs.map((w) => ({ id: w.id, author: w.author?.displayName, started: w.started, timeSpent: w.timeSpent, comment: w.comment }));
      print(items, opts, (items) => table(items.map((w) => ({ ...w, started: shortDate(w.started) })), [{ key: 'started', label: 'Started' }, { key: 'timeSpent', label: 'Time' }, { key: 'author', label: 'Author' }, { key: 'comment', label: 'Comment', max: 60 }]));
    },
  },

  'log-work': {
    summary: 'Log time on an issue',
    usage: 'atl issue log-work <KEY> <1h 30m> [--started "2026-11-17 09:00"] [--comment "<markdown>"]',
    options: { started: { type: 'string' }, comment: { type: 'string' } },
    async run(client, args, opts) {
      const key = issueKey(args[0]);
      const timeSpent = args.slice(1).join(' ');
      if (!timeSpent) throw new Error('Missing time, e.g. "1h 30m".');
      const body = { timeSpent, started: jiraDate(opts.started) };
      if (opts.comment) body.comment = markdownToJira(opts.comment);
      const res = await client.post(`/rest/api/2/issue/${key}/worklog`, body);
      print(res, opts, (r) => (r.dryRun ? '' : `Logged ${timeSpent} on ${key}.`));
    },
  },

  changelog: {
    summary: 'Show the change history of an issue',
    usage: 'atl issue changelog <KEY> [--limit 50]',
    options: { limit: { type: 'string', default: '50' } },
    async run(client, args, opts) {
      const key = issueKey(args[0]);
      const res = await client.get(`/rest/api/2/issue/${key}/changelog`, { maxResults: 100 });
      const values = res.values || [];
      const items = values
        .slice(-Number(opts.limit))
        .reverse()
        .flatMap((h) => h.items.map((it) => ({ when: h.created, author: h.author?.displayName, field: it.field, from: it.fromString, to: it.toString })));
      print(items, opts, (items) => table(items.map((i) => ({ ...i, when: shortDate(i.when) })), [{ key: 'when', label: 'When' }, { key: 'author', label: 'Author', max: 22 }, { key: 'field', label: 'Field', max: 18 }, { key: 'from', label: 'From', max: 30 }, { key: 'to', label: 'To', max: 30 }]));
    },
  },

  dev: {
    summary: 'Linked branches, commits and pull requests',
    usage: 'atl issue dev <KEY>',
    async run(client, args, opts) {
      const key = issueKey(args[0]);
      const { id } = await client.get(`/rest/api/2/issue/${key}`, { fields: 'summary' });
      const summary = await client.get('/rest/dev-status/latest/issue/summary', { issueId: id });
      const out = { pullRequests: [], branches: [], repositories: [] };
      for (const applicationType of Object.keys(Object.values(summary.summary || {}).reduce((acc, v) => ({ ...acc, ...(v.byInstanceType || {}) }), {}))) {
        for (const dataType of ['pullrequest', 'branch']) {
          let d;
          try {
            d = await client.get('/rest/dev-status/latest/issue/detail', { issueId: id, applicationType, dataType });
          } catch {
            continue;
          }
          for (const det of d.detail || []) {
            for (const pr of det.pullRequests || []) out.pullRequests.push({ name: pr.name, status: pr.status, url: pr.url, author: pr.author?.name, repo: pr.repositoryName, updated: pr.lastUpdate });
            for (const br of det.branches || []) out.branches.push({ name: br.name, repo: br.repository?.name, url: br.url });
          }
        }
      }
      print(out, opts, (o) =>
        [
          `Pull requests:\n${o.pullRequests.map((p) => `- [${p.status}] ${p.name} (${p.repo}) ${p.url}`).join('\n') || '(none)'}`,
          `Branches:\n${o.branches.map((b) => `- ${b.name} (${b.repo})`).join('\n') || '(none)'}`,
        ].join('\n\n'),
      );
    },
  },

  attachments: {
    summary: 'List attachments of an issue',
    usage: 'atl issue attachments <KEY>',
    async run(client, args, opts) {
      const i = await client.get(`/rest/api/2/issue/${issueKey(args[0])}`, { fields: 'attachment' });
      const items = i.fields.attachment.map((a) => ({ id: a.id, filename: a.filename, size: a.size, mimeType: a.mimeType, created: a.created, author: a.author?.displayName }));
      print(items, opts, (items) => table(items, [{ key: 'id', label: 'Id' }, { key: 'filename', label: 'File', max: 50 }, { key: 'size', label: 'Bytes' }, { key: 'author', label: 'Author' }]));
    },
  },

  download: {
    summary: 'Download attachments of an issue (all, or by id/filename)',
    usage: 'atl issue download <KEY> [id|filename]... [--dir .]',
    options: { dir: { type: 'string', default: '.' } },
    async run(client, args, opts) {
      const i = await client.get(`/rest/api/2/issue/${issueKey(args[0])}`, { fields: 'attachment' });
      const want = args.slice(1);
      const files = i.fields.attachment.filter((a) => !want.length || want.includes(a.id) || want.includes(a.filename));
      const saved = [];
      for (const a of files) saved.push(await client.download(a.content, join(opts.dir, basename(a.filename))));
      print(saved, opts, (s) => s.join('\n') || '(nothing to download)');
    },
  },

  attach: {
    summary: 'Upload files as attachments',
    usage: 'atl issue attach <KEY> <file>...',
    async run(client, args, opts) {
      const key = issueKey(args[0]);
      if (args.length < 2) throw new Error('Give at least one file.');
      const res = await client.upload('POST', `/rest/api/2/issue/${key}/attachments`, args.slice(1));
      print(res, opts, (r) => (r.dryRun ? '' : r.map((a) => `Attached ${a.filename} (${a.id})`).join('\n')));
    },
  },

  delete: {
    summary: 'Delete an issue (requires --yes)',
    usage: 'atl issue delete <KEY> --yes [--subtasks]',
    options: { yes: { type: 'boolean' }, subtasks: { type: 'boolean' } },
    async run(client, args, opts) {
      const key = issueKey(args[0]);
      requireYes(opts, `delete ${key}`);
      const res = await client.delete(`/rest/api/2/issue/${key}`, { deleteSubtasks: opts.subtasks ? 'true' : undefined });
      print(res ?? { deleted: key }, opts, (r) => (r.dryRun ? '' : `${key} deleted.`));
    },
  },

  meta: {
    summary: 'Issue types of a project, or the fields of one type (for create)',
    usage: 'atl issue meta --project KEY [--type <name>]',
    options: { project: { type: 'string' }, type: { type: 'string' } },
    async run(client, _args, opts) {
      if (!opts.project) throw new Error('--project is required.');
      const p = opts.project.toUpperCase();
      const types = (await client.get(`/rest/api/2/issue/createmeta/${p}/issuetypes`, { maxResults: 100 })).issueTypes || [];
      if (!opts.type) {
        const items = types.map((t) => ({ id: t.id, name: t.name, subtask: t.subtask }));
        return print(items, opts, (items) => table(items, [{ key: 'id', label: 'Id' }, { key: 'name', label: 'Type' }, { key: 'subtask', label: 'Subtask' }]));
      }
      const t = types.find((t) => t.name.toLowerCase() === opts.type.toLowerCase());
      if (!t) throw new Error(`Type "${opts.type}" not in ${p}. Available: ${types.map((t) => t.name).join(', ')}`);
      const fields = (await client.get(`/rest/api/2/issue/createmeta/${p}/issuetypes/${t.id}`, { maxResults: 200 })).fields || [];
      const items = fields.map((f) => ({ key: f.fieldId, name: f.name, required: f.required, type: f.schema?.type, allowed: (f.allowedValues || []).slice(0, 15).map((v) => v.name || v.value).join(', ') }));
      print(items, opts, (items) => table(items, [{ key: 'key', label: 'Field' }, { key: 'name', label: 'Name', max: 30 }, { key: 'required', label: 'Req' }, { key: 'type', label: 'Type' }, { key: 'allowed', label: 'Allowed values', max: 60 }]));
    },
  },
};

export const project = {
  list: {
    summary: 'List or search projects',
    usage: 'atl project list [query]',
    async run(client, args, opts) {
      const res = await client.get('/rest/api/2/project/search', { query: args.join(' ') || undefined, maxResults: 100, orderBy: 'name' });
      const items = res.values.map((p) => ({ key: p.key, name: p.name, type: p.projectTypeKey, lead: p.lead?.displayName }));
      print(items, opts, (items) => table(items, [{ key: 'key', label: 'Key' }, { key: 'name', label: 'Name', max: 50 }, { key: 'type', label: 'Type' }]));
    },
  },
  versions: {
    summary: 'List versions of a project',
    usage: 'atl project versions <KEY> [--unreleased]',
    options: { unreleased: { type: 'boolean' } },
    async run(client, args, opts) {
      const res = await client.get(`/rest/api/2/project/${args[0]?.toUpperCase()}/versions`);
      const items = res.filter((v) => !opts.unreleased || !v.released).map((v) => ({ id: v.id, name: v.name, released: v.released, archived: v.archived, releaseDate: v.releaseDate, description: v.description }));
      print(items, opts, (items) => table(items, [{ key: 'id', label: 'Id' }, { key: 'name', label: 'Name', max: 40 }, { key: 'released', label: 'Released' }, { key: 'releaseDate', label: 'Date' }]));
    },
  },
  'create-version': {
    summary: 'Create a version in a project',
    usage: 'atl project create-version <KEY> <name> [--release-date YYYY-MM-DD] [--start-date YYYY-MM-DD] [--description ..]',
    options: { 'release-date': { type: 'string' }, 'start-date': { type: 'string' }, description: { type: 'string' } },
    async run(client, args, opts) {
      const [key, ...name] = args;
      if (!key || !name.length) throw new Error('Usage: atl project create-version <KEY> <name>');
      const res = await client.post('/rest/api/2/version', { project: key.toUpperCase(), name: name.join(' '), releaseDate: opts['release-date'], startDate: opts['start-date'], description: opts.description });
      print(res, opts, (r) => (r.dryRun ? '' : `Version ${r.name} (${r.id}) created.`));
    },
  },
  components: {
    summary: 'List components of a project',
    usage: 'atl project components <KEY>',
    async run(client, args, opts) {
      const res = await client.get(`/rest/api/2/project/${args[0]?.toUpperCase()}/components`);
      const items = res.map((c) => ({ id: c.id, name: c.name, lead: c.lead?.displayName, description: c.description }));
      print(items, opts, (items) => table(items, [{ key: 'id', label: 'Id' }, { key: 'name', label: 'Name', max: 40 }, { key: 'lead', label: 'Lead' }]));
    },
  },
};

export const field = {
  search: {
    summary: 'Find fields (incl. custom fields) by name or id',
    usage: 'atl field search [text]',
    async run(client, args, opts) {
      const q = args.join(' ').toLowerCase();
      const res = await client.get('/rest/api/2/field');
      const items = res
        .filter((f) => !q || f.name.toLowerCase().includes(q) || f.id.toLowerCase().includes(q))
        .map((f) => ({ id: f.id, name: f.name, custom: f.custom, type: f.schema?.type }));
      print(items, opts, (items) => table(items, [{ key: 'id', label: 'Id' }, { key: 'name', label: 'Name', max: 50 }, { key: 'type', label: 'Type' }]));
    },
  },
};

export const sprintMore = {
  add: {
    summary: 'Move issues into a sprint',
    usage: 'atl sprint add <sprintId> <KEY>...',
    async run(client, args, opts) {
      const [id, ...keys] = args;
      if (!id || !keys.length) throw new Error('Usage: atl sprint add <sprintId> <KEY>...');
      const res = await client.post(`/rest/agile/1.0/sprint/${id}/issue`, { issues: keys.map(issueKey) });
      print(res ?? { sprint: id, issues: keys }, opts, (r) => (r.dryRun ? '' : `Moved ${keys.length} issue(s) to sprint ${id}.`));
    },
  },
  backlog: {
    summary: 'Move issues to the backlog',
    usage: 'atl sprint backlog <KEY>...',
    async run(client, args, opts) {
      if (!args.length) throw new Error('Give at least one issue key.');
      const res = await client.post('/rest/agile/1.0/backlog/issue', { issues: args.map(issueKey) });
      print(res ?? { backlog: args }, opts, (r) => (r.dryRun ? '' : `Moved ${args.length} issue(s) to the backlog.`));
    },
  },
  create: {
    summary: 'Create a sprint',
    usage: 'atl sprint create --board <id> --name "<name>" [--start ISO] [--end ISO] [--goal ..]',
    options: { board: { type: 'string' }, name: { type: 'string' }, start: { type: 'string' }, end: { type: 'string' }, goal: { type: 'string' } },
    async run(client, _args, opts) {
      if (!opts.board || !opts.name) throw new Error('--board and --name are required.');
      const res = await client.post('/rest/agile/1.0/sprint', { originBoardId: Number(opts.board), name: opts.name, startDate: opts.start, endDate: opts.end, goal: opts.goal });
      print(res, opts, (r) => (r.dryRun ? '' : `Sprint ${r.name} (${r.id}) created.`));
    },
  },
  update: {
    summary: 'Update a sprint (name, dates, goal, state)',
    usage: 'atl sprint update <sprintId> [--name ..] [--start ISO] [--end ISO] [--goal ..] [--state active|closed]',
    options: { name: { type: 'string' }, start: { type: 'string' }, end: { type: 'string' }, goal: { type: 'string' }, state: { type: 'string' } },
    async run(client, args, opts) {
      if (!args[0]) throw new Error('Missing sprint id.');
      const body = { name: opts.name, startDate: opts.start, endDate: opts.end, goal: opts.goal, state: opts.state };
      Object.keys(body).forEach((k) => body[k] === undefined && delete body[k]);
      if (!Object.keys(body).length) throw new Error('Nothing to update.');
      const res = await client.post(`/rest/agile/1.0/sprint/${args[0]}`, body);
      print(res, opts, (r) => (r.dryRun ? '' : `Sprint ${r.id} updated.`));
    },
  },
};

