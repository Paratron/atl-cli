import { createInterface } from 'node:readline';
import { Client } from '../client.js';
import { CONFIG_FILE, keychainDelete, keychainSet, normalizeSite, readConfigFile, writeConfigFile } from '../config.js';
import { print } from '../util.js';

async function readSecret(prompt) {
  if (!process.stdin.isTTY) {
    const chunks = [];
    for await (const c of process.stdin) chunks.push(c);
    return Buffer.concat(chunks).toString('utf8').trim();
  }
  const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: true });
  rl._writeToOutput = (s) => {
    if (s.startsWith(prompt)) rl.output.write(prompt);
  };
  return new Promise((resolve) =>
    rl.question(prompt, (answer) => {
      rl.close();
      process.stderr.write('\n');
      resolve(answer.trim());
    }),
  );
}

export const auth = {
  'set-token': {
    summary: 'Store site, email and API token (token goes to the macOS keychain)',
    usage: 'atl set-token [--site <site> --email <you@example.com>]   (token is prompted, or piped via stdin)',
    options: { site: { type: 'string' }, email: { type: 'string' } },
    async run(_client, _args, opts) {
      const file = readConfigFile();
      const site = normalizeSite(opts.site || file.site);
      const email = opts.email || file.email;
      if (!site || !email) throw new Error('--site and --email are required the first time.');
      const token = await readSecret('API token (https://id.atlassian.com/manage-profile/security/api-tokens): ');
      if (!token) throw new Error('No token given.');
      keychainSet(email, token);
      writeConfigFile({ site, email });
      const me = await new Client().get('/rest/api/2/myself');
      print({ site, email, user: me.displayName }, opts, () => `Token for ${site} works (${me.displayName}). Stored in keychain, config in ${CONFIG_FILE}.`);
    },
  },

  status: {
    summary: 'Check the configured credentials',
    usage: 'atl status',
    async run(client, _args, opts) {
      const { site, email, token } = client.config;
      const source = process.env.ATL_TOKEN ? 'ATL_TOKEN' : token ? 'keychain' : 'missing';
      let user = null;
      if (token) user = (await client.get('/rest/api/2/myself')).displayName;
      print({ site, email, tokenSource: source, user }, opts, (s) => `site:  ${s.site ?? '-'}\nemail: ${s.email ?? '-'}\ntoken: ${s.tokenSource}\nuser:  ${s.user ?? '-'}`);
    },
  },

  'remove-token': {
    summary: 'Remove the stored token from the keychain',
    usage: 'atl remove-token',
    async run(client, _args, opts) {
      const removed = client.config.email ? keychainDelete(client.config.email) : false;
      print({ removed }, opts, () => (removed ? 'Token removed from keychain.' : 'No stored token found.'));
    },
  },
};
