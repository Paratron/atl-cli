import { jiraToMarkdown, markdownToJira } from '../markdown.js';
import { csv, print, readBody, shortDate, table } from '../util.js';

const formatOption = { format: { type: 'string', default: 'markdown' } };

// Input text is Markdown by default; --format wiki passes Jira wiki markup through unchanged.
function toWiki(text, format = 'markdown') {
  if (text === undefined || text === null) return text;
  if (format === 'wiki') return text;
  if (format === 'markdown' || format === 'md') return markdownToJira(text);
  throw new Error(`Unknown --format "${format}" (use markdown or wiki).`);
}

const fromWiki = (text, raw) => (raw ? text : jiraToMarkdown(text));

// Replaces @user:<accountId> (from Jira mentions) with @Display Name.
async function resolveMentions(client, texts) {
  const ids = [...new Set(texts.flatMap((t) => [...(t || '').matchAll(/@user:([\w:-]+)/g)].map((m) => m[1])))];
  if (!ids.length) return texts;
  const names = {};
  for (let i = 0; i < ids.length; i += 50) {
    try {
      const res = await client.get('/rest/api/2/user/bulk', { accountId: ids.slice(i, i + 50), maxResults: 50 });
      for (const u of res.values || []) names[u.accountId] = u.displayName;
    } catch {}
  }
  return texts.map((t) => t && t.replace(/@user:([\w:-]+)/g, (m, id) => (names[id] ? `@${names[id]}` : m)));
}

const DEFAULT_FIELDS = 'summary,status,assignee,reporter,priority,issuetype,created,updated,duedate,labels,parent';

function issueKey(arg) {
  if (!arg) throw new Error('Missing issue key.');
  const m = arg.match(/browse\/([A-Z][A-Z0-9_]+-\d+)/i) || arg.match(/selectedIssue=([A-Z][A-Z0-9_]+-\d+)/i);
  return (m ? m[1] : arg).toUpperCase();
}

function commentId(arg) {
  if (!arg) throw new Error('Missing comment id (see: atl issue comments <KEY>).');
  const id = String(arg).replace(/^#/, '');
  if (!/^\d+$/.test(id)) throw new Error(`Invalid comment id "${arg}" (expected a number).`);
  return id;
}

function flatIssue(i, site) {
  const f = i.fields || {};
  return {
    key: i.key,
    url: `${site}/browse/${i.key}`,
    summary: f.summary,
    status: f.status?.name,
    type: f.issuetype?.name,
    priority: f.priority?.name,
    assignee: f.assignee?.displayName ?? null,
    reporter: f.reporter?.displayName ?? null,
    created: f.created,
    updated: f.updated,
    due: f.duedate ?? null,
    labels: f.labels,
    parent: f.parent?.key ?? null,
  };
}

async function resolveAccountId(client, who) {
  if (!who || who === 'none' || who === 'unassigned') return null;
  if (who === 'me') return (await client.get('/rest/api/2/myself')).accountId;
  if (/^[0-9a-f:-]{20,}$/i.test(who)) return who;
  const users = await client.get('/rest/api/2/user/search', { query: who, maxResults: 10 });
  const active = users.filter((u) => u.active !== false && u.accountType === 'atlassian');
  if (active.length === 1) return active[0].accountId;
  if (!active.length) throw new Error(`No user found for "${who}".`);
  throw new Error(`"${who}" is ambiguous: ${active.map((u) => `${u.displayName} <${u.emailAddress || u.accountId}>`).join(', ')}`);
}

function parseFieldArgs(list = []) {
  const fields = {};
  for (const kv of list) {
    const i = kv.indexOf('=');
    if (i < 1) throw new Error(`--field expects key=value, got "${kv}"`);
    const k = kv.slice(0, i);
    const v = kv.slice(i + 1);
    try {
      fields[k] = JSON.parse(v);
    } catch {
      fields[k] = v;
    }
  }
  return fields;
}

export const issue = {
  get: {
    summary: 'Show an issue (description included)',
    usage: 'atl issue get <KEY|url> [--comments] [--raw] [--fields a,b,c]',
    options: { comments: { type: 'boolean' }, raw: { type: 'boolean' }, fields: { type: 'string' } },
    async run(client, args, opts) {
      const key = issueKey(args[0]);
      const fields = opts.fields || `${DEFAULT_FIELDS},description,components,fixVersions,issuelinks,subtasks`;
      const i = await client.get(`/rest/api/2/issue/${key}`, { fields });
      const out = { ...flatIssue(i, client.config.site), description: fromWiki(i.fields.description ?? null, opts.raw) };
      if (opts.fields) out.fields = i.fields;
      out.links = (i.fields.issuelinks || []).map((l) => {
        const o = l.outwardIssue || l.inwardIssue;
        return { type: l.outwardIssue ? l.type.outward : l.type.inward, key: o?.key, summary: o?.fields?.summary, status: o?.fields?.status?.name };
      });
      out.subtasks = (i.fields.subtasks || []).map((s) => ({ key: s.key, summary: s.fields.summary, status: s.fields.status?.name }));
      if (opts.comments) {
        const c = await client.get(`/rest/api/2/issue/${key}/comment`, { orderBy: '-created', maxResults: 20 });
        out.comments = c.comments.map((x) => ({ id: x.id, author: x.author?.displayName, created: x.created, body: fromWiki(x.body, opts.raw) }));
      }
      if (!opts.raw) {
        const [description, ...bodies] = await resolveMentions(client, [out.description, ...(out.comments || []).map((c) => c.body)]);
        out.description = description;
        (out.comments || []).forEach((c, i) => (c.body = bodies[i]));
      }
      print(out, opts, (o) =>
        [
          `${o.key}  ${o.summary}`,
          `${o.type} · ${o.status} · ${o.priority ?? '-'} · assignee: ${o.assignee ?? '-'} · reporter: ${o.reporter ?? '-'}`,
          `created ${shortDate(o.created)} · updated ${shortDate(o.updated)}${o.due ? ` · due ${o.due}` : ''}${o.parent ? ` · parent ${o.parent}` : ''}`,
          o.labels?.length ? `labels: ${o.labels.join(', ')}` : null,
          o.url,
          '',
          o.description || '(no description)',
          o.links.length ? `\nLinks:\n${o.links.map((l) => `- ${l.type} ${l.key} [${l.status}] ${l.summary}`).join('\n')}` : null,
          o.subtasks.length ? `\nSubtasks:\n${o.subtasks.map((s) => `- ${s.key} [${s.status}] ${s.summary}`).join('\n')}` : null,
          o.comments ? `\nComments (newest first):\n${o.comments.map((c) => `--- ${c.author} · ${shortDate(c.created)}\n${c.body}`).join('\n')}` : null,
        ]
          .filter((l) => l !== null)
          .join('\n'),
      );
    },
  },

  search: {
    summary: 'Search issues with JQL',
    usage: 'atl issue search "<JQL>" [--limit 25] [--fields a,b,c]',
    options: { limit: { type: 'string', default: '25' }, fields: { type: 'string' } },
    async run(client, args, opts) {
      const jql = args.join(' ');
      if (!jql) throw new Error('Missing JQL.');
      const limit = Number(opts.limit);
      const issues = [];
      let nextPageToken;
      do {
        const res = await client.get('/rest/api/2/search/jql', {
          jql,
          maxResults: Math.min(100, limit - issues.length),
          fields: opts.fields || DEFAULT_FIELDS,
          nextPageToken,
        });
        issues.push(...res.issues);
        nextPageToken = res.nextPageToken;
      } while (nextPageToken && issues.length < limit);
      const items = issues.map((i) => (opts.fields ? { key: i.key, ...i.fields } : flatIssue(i, client.config.site)));
      print({ items, hasMore: Boolean(nextPageToken) }, opts, ({ items, hasMore }) =>
        table(
          items.map((i) => ({ ...i, updated: shortDate(i.updated) })),
          [
            { key: 'key', label: 'Key' },
            { key: 'type', label: 'Type', max: 10 },
            { key: 'status', label: 'Status', max: 18 },
            { key: 'assignee', label: 'Assignee', max: 22 },
            { key: 'updated', label: 'Updated' },
            { key: 'summary', label: 'Summary', max: 70 },
          ],
        ) + (hasMore ? '\n… more available (raise --limit)' : ''),
      );
    },
  },

  comments: {
    summary: 'List comments of an issue (newest first)',
    usage: 'atl issue comments <KEY> [--limit 20] [--raw]',
    options: { limit: { type: 'string', default: '20' }, raw: { type: 'boolean' } },
    async run(client, args, opts) {
      const key = issueKey(args[0]);
      const c = await client.get(`/rest/api/2/issue/${key}/comment`, { orderBy: '-created', maxResults: opts.limit });
      const items = c.comments.map((x) => ({ id: x.id, author: x.author?.displayName, created: x.created, body: fromWiki(x.body, opts.raw) }));
      if (!opts.raw) (await resolveMentions(client, items.map((c) => c.body))).forEach((b, i) => (items[i].body = b));
      print(items, opts, (items) => items.map((c) => `--- ${c.author} · ${shortDate(c.created)} (#${c.id})\n${c.body}`).join('\n') || '(no comments)');
    },
  },

  comment: {
    summary: 'Add a comment (Markdown, or --format wiki)',
    usage: 'atl issue comment <KEY> --body "<markdown>" | --file <path> | <stdin> [--format markdown|wiki]',
    options: { body: { type: 'string' }, file: { type: 'string' }, ...formatOption },
    async run(client, args, opts) {
      const key = issueKey(args[0]);
      const body = toWiki(await readBody(opts), opts.format);
      const res = await client.post(`/rest/api/2/issue/${key}/comment`, { body });
      print(res, opts, (r) => (r.dryRun ? '' : `Comment #${r.id} added to ${key}.`));
    },
  },

  'comment-edit': {
    summary: 'Edit an existing comment (Markdown, or --format wiki)',
    usage: 'atl issue comment-edit <KEY> <commentId> --body "<markdown>" | --file <path> | <stdin> [--format markdown|wiki]',
    options: { body: { type: 'string' }, file: { type: 'string' }, ...formatOption },
    async run(client, args, opts) {
      const key = issueKey(args[0]);
      const id = commentId(args[1]);
      const body = toWiki(await readBody(opts), opts.format);
      const res = await client.put(`/rest/api/2/issue/${key}/comment/${id}`, { body });
      print(res, opts, (r) => (r.dryRun ? '' : `Comment #${r.id} of ${key} updated.`));
    },
  },

  'comment-delete': {
    summary: 'Delete a comment (requires --yes)',
    usage: 'atl issue comment-delete <KEY> <commentId> --yes',
    options: { yes: { type: 'boolean' } },
    async run(client, args, opts) {
      const key = issueKey(args[0]);
      const id = commentId(args[1]);
      if (!opts.yes && !opts['dry-run']) throw new Error(`Refusing to delete comment #${id} of ${key} without --yes.`);
      const res = await client.delete(`/rest/api/2/issue/${key}/comment/${id}`);
      print(res ?? { deleted: id, key }, opts, (r) => (r.dryRun ? '' : `Comment #${id} deleted from ${key}.`));
    },
  },

  assign: {
    summary: 'Assign an issue (me | none | name/email | accountId)',
    usage: 'atl issue assign <KEY> <me|none|user>',
    async run(client, args, opts) {
      const key = issueKey(args[0]);
      if (!args[1]) throw new Error('Missing assignee (me, none, name, email or accountId).');
      const accountId = await resolveAccountId(client, args.slice(1).join(' '));
      const res = await client.put(`/rest/api/2/issue/${key}/assignee`, { accountId });
      print(res ?? { key, accountId }, opts, (r) => (r.dryRun ? '' : `${key} assigned to ${accountId ?? 'nobody'}.`));
    },
  },

  transitions: {
    summary: 'List available status transitions',
    usage: 'atl issue transitions <KEY>',
    async run(client, args, opts) {
      const key = issueKey(args[0]);
      const res = await client.get(`/rest/api/2/issue/${key}/transitions`);
      const items = res.transitions.map((t) => ({ id: t.id, name: t.name, to: t.to?.name }));
      print(items, opts, (items) => table(items, [{ key: 'id', label: 'Id' }, { key: 'name', label: 'Transition' }, { key: 'to', label: 'To status' }]));
    },
  },

  transition: {
    summary: 'Move an issue to another status (by transition name, target status or id)',
    usage: 'atl issue transition <KEY> "<transition|status|id>" [--comment "<markdown>"] [--format markdown|wiki]',
    options: { comment: { type: 'string' }, ...formatOption },
    async run(client, args, opts) {
      const key = issueKey(args[0]);
      const want = args.slice(1).join(' ').trim().toLowerCase();
      if (!want) throw new Error('Missing transition name or id.');
      const { transitions } = await client.get(`/rest/api/2/issue/${key}/transitions`);
      const t =
        transitions.find((t) => t.id === want) ||
        transitions.find((t) => t.name.toLowerCase() === want) ||
        transitions.find((t) => t.to?.name?.toLowerCase() === want);
      if (!t) throw new Error(`No transition "${want}". Available: ${transitions.map((t) => `${t.name} → ${t.to?.name}`).join(', ')}`);
      const body = { transition: { id: t.id } };
      if (opts.comment) body.update = { comment: [{ add: { body: toWiki(opts.comment, opts.format) } }] };
      const res = await client.post(`/rest/api/2/issue/${key}/transitions`, body);
      print(res ?? { key, transition: t.name, to: t.to?.name }, opts, (r) => (r.dryRun ? '' : `${key} → ${t.to?.name ?? t.name}`));
    },
  },

  create: {
    summary: 'Create an issue',
    usage:
      'atl issue create --project <KEY> --type <Task|Bug|Story|...> --summary "<text>" [--description "<markdown>"|--file <path>] [--format markdown|wiki] [--assignee me] [--labels a,b] [--parent KEY] [--priority High] [--components a,b] [--field key=value]...',
    options: {
      project: { type: 'string' },
      type: { type: 'string', default: 'Task' },
      summary: { type: 'string' },
      description: { type: 'string' },
      file: { type: 'string' },
      assignee: { type: 'string' },
      labels: { type: 'string' },
      parent: { type: 'string' },
      priority: { type: 'string' },
      components: { type: 'string' },
      field: { type: 'string', multiple: true },
      ...formatOption,
    },
    async run(client, _args, opts) {
      if (!opts.project || !opts.summary) throw new Error('--project and --summary are required.');
      const fields = {
        project: { key: opts.project.toUpperCase() },
        issuetype: { name: opts.type },
        summary: opts.summary,
        ...parseFieldArgs(opts.field),
      };
      const description = opts.file || opts.description !== undefined ? await readBody({ file: opts.file, body: opts.description }) : undefined;
      if (description !== undefined) fields.description = toWiki(description, opts.format);
      if (opts.components) fields.components = csv(opts.components).map((name) => ({ name }));
      if (opts.labels) fields.labels = csv(opts.labels);
      if (opts.parent) fields.parent = { key: issueKey(opts.parent) };
      if (opts.priority) fields.priority = { name: opts.priority };
      if (opts.assignee) fields.assignee = { accountId: await resolveAccountId(client, opts.assignee) };
      const res = await client.post('/rest/api/2/issue', { fields });
      print(res, opts, (r) => (r.dryRun ? '' : `Created ${r.key}: ${client.config.site}/browse/${r.key}`));
    },
  },

  update: {
    summary: 'Update issue fields',
    usage: 'atl issue update <KEY> [--summary ..] [--description <markdown>|--file <path>] [--format markdown|wiki] [--assignee me|none|user] [--labels a,b] [--add-labels a] [--remove-labels b] [--priority ..] [--due YYYY-MM-DD] [--field key=value]...',
    options: {
      summary: { type: 'string' },
      description: { type: 'string' },
      file: { type: 'string' },
      labels: { type: 'string' },
      'add-labels': { type: 'string' },
      'remove-labels': { type: 'string' },
      priority: { type: 'string' },
      due: { type: 'string' },
      assignee: { type: 'string' },
      field: { type: 'string', multiple: true },
      ...formatOption,
    },
    async run(client, args, opts) {
      const key = issueKey(args[0]);
      const fields = parseFieldArgs(opts.field);
      const update = {};
      if (opts.summary) fields.summary = opts.summary;
      if (opts.file || opts.description !== undefined) fields.description = toWiki(await readBody({ file: opts.file, body: opts.description }), opts.format);
      if (opts.assignee) fields.assignee = { accountId: await resolveAccountId(client, opts.assignee) };
      if (opts.labels !== undefined) fields.labels = csv(opts.labels);
      if (opts.priority) fields.priority = { name: opts.priority };
      if (opts.due !== undefined) fields.duedate = opts.due || null;
      const labelOps = [...(csv(opts['add-labels']) || []).map((l) => ({ add: l })), ...(csv(opts['remove-labels']) || []).map((l) => ({ remove: l }))];
      if (labelOps.length) update.labels = labelOps;
      if (!Object.keys(fields).length && !Object.keys(update).length) throw new Error('Nothing to update.');
      const res = await client.put(`/rest/api/2/issue/${key}`, { fields, update });
      print(res ?? { key, updated: Object.keys({ ...fields, ...update }) }, opts, (r) => (r.dryRun ? '' : `${key} updated.`));
    },
  },
};

export const sprint = {
  current: {
    summary: 'Issues in the active sprint of a board',
    usage: 'atl sprint current --board <id> [--mine] [--limit 200]',
    options: { board: { type: 'string' }, mine: { type: 'boolean' }, limit: { type: 'string', default: '200' } },
    async run(client, _args, opts) {
      if (!opts.board) throw new Error('--board is required (find it with: atl board list --project KEY).');
      const { values } = await client.get(`/rest/agile/1.0/board/${opts.board}/sprint`, { state: 'active' });
      if (!values.length) return print({ sprint: null, items: [] }, opts, () => 'No active sprint.');
      const s = values[0];
      const res = await client.get(`/rest/agile/1.0/sprint/${s.id}/issue`, {
        fields: DEFAULT_FIELDS,
        maxResults: opts.limit,
        jql: opts.mine ? 'assignee = currentUser()' : undefined,
      });
      const items = res.issues.map((i) => flatIssue(i, client.config.site));
      print({ sprint: { id: s.id, name: s.name, start: s.startDate, end: s.endDate, goal: s.goal }, items }, opts, ({ sprint, items }) =>
        [
          `${sprint.name} (${shortDate(sprint.start)} → ${shortDate(sprint.end)})${sprint.goal ? `\nGoal: ${sprint.goal}` : ''}`,
          '',
          table(items, [
            { key: 'key', label: 'Key' },
            { key: 'status', label: 'Status', max: 18 },
            { key: 'assignee', label: 'Assignee', max: 22 },
            { key: 'summary', label: 'Summary', max: 70 },
          ]),
        ].join('\n'),
      );
    },
  },

  list: {
    summary: 'List sprints of a board',
    usage: 'atl sprint list --board <id> [--state active,future,closed]',
    options: { board: { type: 'string' }, state: { type: 'string', default: 'active,future' } },
    async run(client, _args, opts) {
      if (!opts.board) throw new Error('--board is required.');
      const { values } = await client.get(`/rest/agile/1.0/board/${opts.board}/sprint`, { state: opts.state, maxResults: 50 });
      const items = values.map((s) => ({ id: s.id, name: s.name, state: s.state, start: s.startDate, end: s.endDate, goal: s.goal }));
      print(items, opts, (items) =>
        table(items.map((s) => ({ ...s, start: shortDate(s.start), end: shortDate(s.end) })), [
          { key: 'id', label: 'Id' },
          { key: 'state', label: 'State' },
          { key: 'name', label: 'Name', max: 40 },
          { key: 'start', label: 'Start' },
          { key: 'end', label: 'End' },
        ]),
      );
    },
  },
};

export const board = {
  list: {
    summary: 'Find agile boards',
    usage: 'atl board list [--project KEY] [--name <text>]',
    options: { project: { type: 'string' }, name: { type: 'string' } },
    async run(client, _args, opts) {
      const { values } = await client.get('/rest/agile/1.0/board', { projectKeyOrId: opts.project, name: opts.name, maxResults: 50 });
      const items = values.map((b) => ({ id: b.id, name: b.name, type: b.type, project: b.location?.projectKey }));
      print(items, opts, (items) => table(items, [{ key: 'id', label: 'Id' }, { key: 'type', label: 'Type' }, { key: 'project', label: 'Project' }, { key: 'name', label: 'Name' }]));
    },
  },
};

export const user = {
  me: {
    summary: 'Show the authenticated user',
    usage: 'atl user me',
    async run(client, _args, opts) {
      const u = await client.get('/rest/api/2/myself');
      print({ accountId: u.accountId, displayName: u.displayName, email: u.emailAddress, timeZone: u.timeZone }, opts, (u) => `${u.displayName} <${u.email}> (${u.accountId})`);
    },
  },
  search: {
    summary: 'Find users by name or email',
    usage: 'atl user search <query>',
    async run(client, args, opts) {
      const users = await client.get('/rest/api/2/user/search', { query: args.join(' '), maxResults: 20 });
      const items = users.filter((u) => u.accountType === 'atlassian').map((u) => ({ accountId: u.accountId, name: u.displayName, email: u.emailAddress, active: u.active }));
      print(items, opts, (items) => table(items, [{ key: 'name', label: 'Name' }, { key: 'email', label: 'Email' }, { key: 'accountId', label: 'Account id' }]));
    },
  },
};
