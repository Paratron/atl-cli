import assert from 'node:assert/strict';
import { test } from 'node:test';
import { lineDiff } from '../src/commands/confluence-more.js';
import { jiraToMarkdown, markdownToJira, markdownToStorage } from '../src/markdown.js';
import { htmlToText } from '../src/util.js';

test('markdown → Jira wiki: inline, lists, code, tables', () => {
  const wiki = markdownToJira(
    ['## Ziel', '', 'Mach **das** mit `x` und [Link](https://a.de), snake_case bleibt.', '', '- a', '  - b', '1. eins', '', '```ts', 'const o = {a: 1};', '```', '', '| A | B |', '|---|---|', '| 1 | 2 |'].join('\n'),
  );
  assert.match(wiki, /^h2\. Ziel/);
  assert.match(wiki, /Mach \*das\* mit \{\{x\}\} und \[Link\|https:\/\/a\.de\], snake_case bleibt\./);
  assert.match(wiki, /^\* a\n\*\* b/m);
  assert.match(wiki, /\{code:javascript\}\nconst o = \{a: 1\};\n\{code\}/);
  assert.match(wiki, /\|\|A\|\|B\|\|\n\|1\|2\|/);
});

test('Jira wiki → markdown keeps code blocks and inline code intact', () => {
  const md = jiraToMarkdown('h1. T\n*fett* und {{inline}}\n{code:java}\nint *a* = 1;\n{code}\n* item\n## nested\n----');
  assert.equal(md, '# T\n**fett** und `inline`\n```java\nint *a* = 1;\n```\n- item\n  1. nested\n---');
});

test('markdown → Confluence storage escapes HTML and builds macros', () => {
  const s = markdownToStorage('Text <b> & co\n\n- [ ] offen\n- [x] erledigt\n\n```\na ]]> b\n```');
  assert.match(s, /<p>Text &lt;b&gt; &amp; co<\/p>/);
  assert.match(s, /<ac:task-status>incomplete<\/ac:task-status><ac:task-body>offen/);
  assert.match(s, /<ac:task-status>complete<\/ac:task-status><ac:task-body>erledigt/);
  assert.match(s, /CDATA\[a ]]]]><!\[CDATA\[> b]]>/);
});

test('storage → markdown round trip for common elements', () => {
  const md = '# T\n\n**b** *i* [L](https://x.de)\n\n- [ ] t\n\n| A | B |\n| --- | --- |\n| 1 | 2 |';
  assert.equal(htmlToText(markdownToStorage(md)), md);
});

test('lineDiff marks added and removed lines', () => {
  const ops = lineDiff('a\nb\nc', 'a\nc\nd').map((d) => d.op + d.line);
  assert.deepEqual(ops, [' a', '-b', ' c', '+d']);
});
