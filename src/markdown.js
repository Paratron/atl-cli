// Minimal, dependency-free Markdown conversion for Jira wiki markup and Confluence storage format.

const JIRA_CODE_LANGS = new Set([
  'actionscript', 'ada', 'applescript', 'bash', 'c', 'c#', 'c++', 'css', 'erlang', 'go', 'groovy', 'haskell', 'html',
  'java', 'javascript', 'json', 'lua', 'objc', 'perl', 'php', 'python', 'r', 'ruby', 'scala', 'sql', 'swift', 'visualbasic', 'xml', 'yaml',
]);
const LANG_ALIASES = { js: 'javascript', jsx: 'javascript', ts: 'javascript', tsx: 'javascript', typescript: 'javascript', sh: 'bash', shell: 'bash', zsh: 'bash', py: 'python', yml: 'yaml', rb: 'ruby', kt: 'java', csharp: 'c#', cs: 'c#', cpp: 'c++' };

// ---------- block parser ----------

const RE = {
  fence: /^\s*(```+|~~~+)\s*([\w#+.-]*)\s*$/,
  heading: /^(#{1,6})\s+(.*?)\s*#*\s*$/,
  hr: /^\s*([-*_])(\s*\1){2,}\s*$/,
  list: /^(\s*)([-*+]|\d+[.)])\s+(.*)$/,
  quote: /^\s*>\s?(.*)$/,
  tableRow: /^\s*\|.*\|\s*$/,
  tableSep: /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/,
};

function splitRow(line) {
  return line.trim().replace(/^\|/, '').replace(/\|$/, '').split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'));
}

export function parseBlocks(md) {
  const lines = md.replace(/\r\n?/g, '\n').split('\n');
  const blocks = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
      continue;
    }
    let m;
    if ((m = line.match(RE.fence))) {
      const fence = m[1];
      const body = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith(fence)) body.push(lines[i++]);
      i++;
      blocks.push({ type: 'code', lang: m[2].toLowerCase(), text: body.join('\n') });
      continue;
    }
    if ((m = line.match(RE.heading))) {
      blocks.push({ type: 'heading', level: m[1].length, text: m[2] });
      i++;
      continue;
    }
    if (RE.hr.test(line) && !RE.list.test(line.replace(/^\s*[-*]\s+[-*]/, 'x'))) {
      blocks.push({ type: 'hr' });
      i++;
      continue;
    }
    if (RE.tableRow.test(line) && i + 1 < lines.length && RE.tableSep.test(lines[i + 1])) {
      const head = splitRow(line);
      const rows = [];
      i += 2;
      while (i < lines.length && RE.tableRow.test(lines[i])) rows.push(splitRow(lines[i++]));
      blocks.push({ type: 'table', head, rows });
      continue;
    }
    if (RE.quote.test(line)) {
      const body = [];
      while (i < lines.length && RE.quote.test(lines[i])) body.push(lines[i++].match(RE.quote)[1]);
      blocks.push({ type: 'quote', blocks: parseBlocks(body.join('\n')) });
      continue;
    }
    if (RE.list.test(line)) {
      const items = [];
      while (i < lines.length) {
        const l = lines[i];
        const lm = l.match(RE.list);
        if (lm) {
          const task = lm[3].match(/^\[([ xX])\]\s+(.*)$/);
          items.push({
            indent: lm[1].replace(/\t/g, '    ').length,
            ordered: /\d/.test(lm[2]),
            text: task ? task[2] : lm[3],
            task: task ? (task[1] === ' ' ? 'todo' : 'done') : null,
          });
          i++;
        } else if (l.trim() && /^\s+/.test(l) && items.length) {
          items[items.length - 1].text += '\n' + l.trim();
          i++;
        } else break;
      }
      blocks.push({ type: 'list', tree: buildTree(items) });
      continue;
    }
    const para = [];
    while (
      i < lines.length &&
      lines[i].trim() &&
      !RE.fence.test(lines[i]) &&
      !RE.heading.test(lines[i]) &&
      !RE.quote.test(lines[i]) &&
      !RE.list.test(lines[i]) &&
      !(RE.tableRow.test(lines[i]) && RE.tableSep.test(lines[i + 1] || ''))
    ) {
      para.push(lines[i++].trim());
    }
    if (para.length) blocks.push({ type: 'para', text: para.join('\n') });
    else i++;
  }
  return blocks;
}

function buildTree(items) {
  const root = { children: [], indent: -1 };
  const stack = [root];
  for (const it of items) {
    while (stack.length > 1 && it.indent <= stack[stack.length - 1].indent) stack.pop();
    const node = { ...it, children: [] };
    stack[stack.length - 1].children.push(node);
    stack.push(node);
  }
  return root.children;
}

// ---------- inline ----------

function withPlaceholders(text, fn) {
  const store = [];
  const keep = (s) => `\u0000${store.push(s) - 1}\u0000`;
  const out = fn(text, keep);
  return out.replace(/\u0000(\d+)\u0000/g, (_, n) => store[Number(n)]);
}

const escapeHtml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function emphasis(s, [b0, b1], [i0, i1], [s0, s1]) {
  return s
    .replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, `${b0}$1${b1}`)
    .replace(/(^|[^\w])__(?=\S)([\s\S]*?\S)__(?![\w])/g, `$1${b0}$2${b1}`)
    .replace(/(^|[^\w*])\*(?=[^\s*])([^*\n]*?[^\s*])?\*(?![\w*])/g, (m, pre, body = '') => `${pre}${i0}${m.slice(pre.length + 1, -1)}${i1}`)
    .replace(/(^|[^\w])_(?=\S)([^_\n]*?\S)_(?![\w])/g, `$1${i0}$2${i1}`)
    .replace(/~~(?=\S)([\s\S]*?\S)~~/g, `${s0}$1${s1}`);
}

export function inlineToStorage(text) {
  return withPlaceholders(text, (t, keep) => {
    t = t.replace(/`([^`\n]+)`/g, (_, c) => keep(`<code>${escapeHtml(c)}</code>`));
    t = t.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (_, alt, src) =>
      keep(/^https?:/.test(src) ? `<ac:image ac:alt="${escapeHtml(alt)}"><ri:url ri:value="${escapeHtml(src)}"/></ac:image>` : `<ac:image ac:alt="${escapeHtml(alt)}"><ri:attachment ri:filename="${escapeHtml(src)}"/></ac:image>`),
    );
    t = t.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (_, label, href) => keep(`<a href="${escapeHtml(href)}">${inlineToStorage(label)}</a>`));
    t = t.replace(/<(https?:\/\/[^>\s]+)>/g, (_, u) => keep(`<a href="${escapeHtml(u)}">${escapeHtml(u)}</a>`));
    t = t.replace(/(^|[\s(])(https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"])/g, (_, pre, u) => pre + keep(`<a href="${escapeHtml(u)}">${escapeHtml(u)}</a>`));
    t = escapeHtml(t);
    t = emphasis(t, ['<strong>', '</strong>'], ['<em>', '</em>'], ['<del>', '</del>']);
    return t.replace(/\n/g, '<br/>');
  });
}

export function inlineToJira(text) {
  return withPlaceholders(text, (t, keep) => {
    t = t.replace(/`([^`\n]+)`/g, (_, c) => keep(`{{${c}}}`));
    t = t.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (_, alt, src) => keep(`!${src}${alt ? `|alt=${alt}` : ''}!`));
    t = t.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (_, label, href) => keep(`[${inlineToJira(label)}|${href}]`));
    t = t.replace(/<(https?:\/\/[^>\s]+)>/g, (_, u) => keep(`[${u}]`));
    t = t.replace(/(^|[\s(])(https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"])/g, (_, pre, u) => pre + keep(u));
    t = t.replace(/([{}])/g, '\\$1');
    return emphasis(t, ['\u0001', '\u0001'], ['_', '_'], ['-', '-']).replace(/\u0001/g, '*');
  });
}

// ---------- renderers ----------

function storageList(nodes) {
  if (nodes.length && nodes.every((n) => n.task)) {
    return `<ac:task-list>${nodes
      .map((n) => `<ac:task><ac:task-status>${n.task === 'done' ? 'complete' : 'incomplete'}</ac:task-status><ac:task-body>${inlineToStorage(n.text)}${n.children.length ? storageList(n.children) : ''}</ac:task-body></ac:task>`)
      .join('')}</ac:task-list>`;
  }
  const tag = nodes[0]?.ordered ? 'ol' : 'ul';
  return `<${tag}>${nodes.map((n) => `<li>${n.task ? (n.task === 'done' ? '☑ ' : '☐ ') : ''}${inlineToStorage(n.text)}${n.children.length ? storageList(n.children) : ''}</li>`).join('')}</${tag}>`;
}

function renderStorage(blocks) {
  return blocks
    .map((b) => {
      switch (b.type) {
        case 'heading':
          return `<h${b.level}>${inlineToStorage(b.text)}</h${b.level}>`;
        case 'hr':
          return '<hr/>';
        case 'code':
          return `<ac:structured-macro ac:name="code">${b.lang ? `<ac:parameter ac:name="language">${escapeHtml(b.lang)}</ac:parameter>` : ''}<ac:plain-text-body><![CDATA[${b.text.replace(/]]>/g, ']]]]><![CDATA[>')}]]></ac:plain-text-body></ac:structured-macro>`;
        case 'table':
          return `<table><tbody><tr>${b.head.map((c) => `<th>${inlineToStorage(c)}</th>`).join('')}</tr>${b.rows
            .map((r) => `<tr>${b.head.map((_, i) => `<td>${inlineToStorage(r[i] ?? '')}</td>`).join('')}</tr>`)
            .join('')}</tbody></table>`;
        case 'quote':
          return `<blockquote>${renderStorage(b.blocks)}</blockquote>`;
        case 'list':
          return storageList(b.tree);
        default:
          return `<p>${inlineToStorage(b.text)}</p>`;
      }
    })
    .join('');
}

export function markdownToStorage(md) {
  return renderStorage(parseBlocks(md));
}

function jiraList(nodes, prefix = '') {
  return nodes
    .map((n) => {
      const marker = prefix + (n.ordered ? '#' : '*');
      const task = n.task ? (n.task === 'done' ? '☑ ' : '☐ ') : '';
      return `${marker} ${task}${inlineToJira(n.text).replace(/\n/g, '\\\\ ')}` + (n.children.length ? '\n' + jiraList(n.children, marker) : '');
    })
    .join('\n');
}

function renderJira(blocks) {
  return blocks
    .map((b) => {
      switch (b.type) {
        case 'heading':
          return `h${b.level}. ${inlineToJira(b.text)}`;
        case 'hr':
          return '----';
        case 'code': {
          const lang = LANG_ALIASES[b.lang] || b.lang;
          if (JIRA_CODE_LANGS.has(lang)) return `{code:${lang}}\n${b.text}\n{code}`;
          return b.lang ? `{code}\n${b.text}\n{code}` : `{noformat}\n${b.text}\n{noformat}`;
        }
        case 'table':
          return [`||${b.head.map(inlineToJira).join('||')}||`, ...b.rows.map((r) => `|${b.head.map((_, i) => inlineToJira((r[i] ?? '').replace(/\|/g, '\\|')) || ' ').join('|')}|`)].join('\n');
        case 'quote':
          return `{quote}\n${renderJira(b.blocks)}\n{quote}`;
        case 'list':
          return jiraList(b.tree);
        default:
          return inlineToJira(b.text);
      }
    })
    .join('\n\n');
}

export function markdownToJira(md) {
  return renderJira(parseBlocks(md));
}

// ---------- Jira wiki markup -> Markdown (for reading) ----------

export function jiraToMarkdown(wiki) {
  if (!wiki) return wiki;
  return withPlaceholders(wiki.replace(/\r\n?/g, '\n'), (t, keep) => {
    t = t.replace(/(?<![{\\])\{code(?::([^}|]*))?[^}]*\}\n?([\s\S]*?)\n?(?<!\\)\{code\}/g, (_, lang = '', body) => keep('```' + (lang.split('|')[0] || '') + '\n' + body + '\n```'));
    t = t.replace(/(?<![{\\])\{noformat[^}]*\}\n?([\s\S]*?)\n?\{noformat\}/g, (_, body) => keep('```\n' + body + '\n```'));
    t = t.replace(/\{\{([^}]+)\}\}/g, (_, c) => keep('`' + c + '`'));
    t = t.replace(/\{quote\}\n?([\s\S]*?)\n?\{quote\}/g, (_, body) => body.split('\n').map((l) => `> ${l}`).join('\n'));
    t = t.replace(/\{color(?::[^}]*)?\}([\s\S]*?)\{color\}/g, '$1');
    t = t.replace(/\[~accountid:([^\]]+)\]/g, '@user:$1');
    t = t.replace(/\[([^\]|\n]+)\|([^\]\n]+)\]/g, (_, label, href) => keep(`[${label}](${href.split('|')[0]})`));
    t = t.replace(/\[(https?:\/\/[^\]\s]+)\]/g, (_, u) => keep(`<${u}>`));
    t = t.replace(/!([^!\s|]+)(?:\|[^!]*)?!/g, (_, src) => keep(`![](${src})`));
    const lines = t.split('\n');
    const out = [];
    for (let i = 0; i < lines.length; i++) {
      let l = lines[i];
      let m;
      if ((m = l.match(/^h([1-6])\.\s+(.*)$/))) l = `${'#'.repeat(Number(m[1]))} ${m[2]}`;
      else if ((m = l.match(/^bq\.\s+(.*)$/))) l = `> ${m[1]}`;
      else if (/^-{4,}\s*$/.test(l)) l = keep('---');
      else if ((m = l.match(/^([*#-]+)\s+(.*)$/))) {
        const depth = m[1].length - 1;
        l = `${'  '.repeat(depth)}${m[1].endsWith('#') ? '1.' : '-'} ${m[2]}`;
      } else if ((m = l.match(/^\s*\|\|(.*)\|\|\s*$/))) {
        const cells = m[1].split('||');
        l = `| ${cells.join(' | ')} |\n` + keep(`|${cells.map(() => ' --- ').join('|')}|`);
      } else if ((m = l.match(/^\s*\|(.*)\|\s*$/))) l = `| ${m[1].split(/(?<!\\)\|/).join(' | ')} |`;
      out.push(l);
    }
    t = out.join('\n');
    t = t.replace(/(^|[\s(>\[])\*(?=\S)([^*\n]*?\S)\*(?=$|[\s).,:;!?\]])/gm, '$1**$2**');
    t = t.replace(/(^|[\s(>\[])_(?=\S)([^_\n]*?\S)_(?=$|[\s).,:;!?\]])/gm, '$1*$2*');
    t = t.replace(/(^|\s)-(?=\S)([^-\n]*?\S)-(?=$|[\s).,:;!?])/gm, '$1~~$2~~');
    return t.replace(/\\([{}])/g, '$1');
  });
}
