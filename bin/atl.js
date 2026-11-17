#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { Client } from '../src/client.js';
import { auth } from '../src/commands/auth.js';
import { page, space } from '../src/commands/confluence.js';
import { pageMore } from '../src/commands/confluence-more.js';
import { field, issueMore, project, sprintMore } from '../src/commands/jira-more.js';
import { board, issue, sprint, user } from '../src/commands/jira.js';
import { notifications } from '../src/commands/notifications.js';

const GROUPS = {
  issue: { ...issue, ...issueMore },
  sprint: { ...sprint, ...sprintMore },
  board,
  project,
  field,
  user,
  page: { ...page, ...pageMore },
  space,
  notifications,
  auth,
};
const ALIASES = { n: 'notifications', notif: 'notifications', i: 'issue', p: 'page' };
const GLOBAL_OPTIONS = {
  json: { type: 'boolean' },
  'dry-run': { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
};

function help(groupName) {
  const groups = groupName ? { [groupName]: GROUPS[groupName] } : GROUPS;
  const lines = groupName ? [] : ['atl – Jira, Confluence and notifications from the command line', '', 'Usage: atl <group> <command> [args] [--json] [--dry-run]', ''];
  for (const [g, cmds] of Object.entries(groups)) {
    lines.push(`${g}:`);
    for (const c of Object.values(cmds)) lines.push(`  ${c.usage}\n      ${c.summary}`);
    lines.push('');
  }
  if (!groupName) {
    lines.push('Global flags:', '  --json      machine-readable output', '  --dry-run   print write requests instead of sending them', '');
    lines.push('Credentials: atl set-token · atl status · atl remove-token · env overrides: ATL_SITE, ATL_EMAIL, ATL_TOKEN');
  }
  return lines.join('\n');
}

const SHORTCUTS = { 'set-token': ['auth', 'set-token'], 'remove-token': ['auth', 'remove-token'], status: ['auth', 'status'] };

async function main(argv) {
  if (SHORTCUTS[argv[0]]) argv = [...SHORTCUTS[argv[0]], ...argv.slice(1)];
  const [rawGroup, cmdName, ...rest] = argv;
  const groupName = ALIASES[rawGroup] || rawGroup;
  if (!groupName || groupName === 'help' || groupName === '--help' || groupName === '-h') return console.log(help());
  if (groupName === '--version' || groupName === '-v') {
    const { default: pkg } = await import('../package.json', { with: { type: 'json' } });
    return console.log(pkg.version);
  }
  const group = GROUPS[groupName];
  if (!group) throw new Error(`Unknown command "${rawGroup}". Run: atl help`);
  if (!cmdName || cmdName === 'help' || cmdName === '--help' || cmdName === '-h') return console.log(help(groupName));
  const cmd = group[cmdName];
  if (!cmd) throw new Error(`Unknown command "${groupName} ${cmdName}".\n\n${help(groupName)}`);

  const { values: opts, positionals } = parseArgs({
    args: rest,
    options: { ...GLOBAL_OPTIONS, ...(cmd.options || {}) },
    allowPositionals: true,
    strict: true,
  });
  if (opts.help) return console.log(`${cmd.usage}\n  ${cmd.summary}`);
  const client = new Client({ dryRun: opts['dry-run'] });
  await cmd.run(client, positionals, opts);
}

process.stdout.on('error', (err) => {
  if (err.code === 'EPIPE') process.exit(0);
  throw err;
});

main(process.argv.slice(2)).catch((err) => {
  console.error(`atl: ${err.message}`); if (process.env.ATL_DEBUG) console.error(err.stack);
  process.exit(1);
});
