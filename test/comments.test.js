import assert from 'node:assert/strict';
import { test } from 'node:test';
import { issue } from '../src/commands/jira.js';

function stubClient() {
  const calls = [];
  return {
    calls,
    put: async (path, body) => (calls.push({ method: 'PUT', path, body }), { id: '42' }),
    delete: async (path) => (calls.push({ method: 'DELETE', path }), null),
  };
}

test('comment-edit converts Markdown and PUTs to the comment endpoint', async () => {
  const client = stubClient();
  await issue['comment-edit'].run(client, ['abc-1', '42'], { body: 'Das ist **fett**', format: 'markdown', json: true });
  assert.deepEqual(client.calls, [{ method: 'PUT', path: '/rest/api/2/issue/ABC-1/comment/42', body: { body: 'Das ist *fett*' } }]);
});

test('comment-edit rejects non-numeric comment ids', async () => {
  await assert.rejects(issue['comment-edit'].run(stubClient(), ['ABC-1', 'abc'], { body: 'x' }), /Invalid comment id/);
});

test('comment-delete refuses without --yes but allows --dry-run', async () => {
  const client = stubClient();
  await assert.rejects(issue['comment-delete'].run(client, ['ABC-1', '42'], {}), /without --yes/);
  assert.equal(client.calls.length, 0);
  await issue['comment-delete'].run(client, ['ABC-1', '42'], { yes: true, json: true });
  assert.deepEqual(client.calls, [{ method: 'DELETE', path: '/rest/api/2/issue/ABC-1/comment/42' }]);
});
