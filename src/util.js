import { readFileSync } from 'node:fs';

export function print(data, opts, human) {
  if (opts.json) {
    process.stdout.write(JSON.stringify(data, null, 2) + '\n');
    return;
  }
  const out = human(data);
  if (out !== undefined && out !== null && out !== '') process.stdout.write(String(out).replace(/\n*$/, '\n'));
}

export function table(rows, columns) {
  if (!rows.length) return '(none)';
  const widths = columns.map((c) => Math.min(c.max ?? 60, Math.max(c.label.length, ...rows.map((r) => String(r[c.key] ?? '').length))));
  const cell = (v, w) => {
    const s = String(v ?? '').replace(/\s+/g, ' ');
    return s.length > w ? s.slice(0, w - 1) + '…' : s.padEnd(w);
  };
  const lines = [columns.map((c, i) => cell(c.label, widths[i])).join('  ')];
  for (const r of rows) lines.push(columns.map((c, i) => cell(r[c.key], widths[i])).join('  ').trimEnd());
  return lines.join('\n');
}

const ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  auml: 'ä', ouml: 'ö', uuml: 'ü', Auml: 'Ä', Ouml: 'Ö', Uuml: 'Ü', szlig: 'ß', euro: '€',
  ndash: '–', mdash: '—', hellip: '…', bdquo: '„', ldquo: '“', rdquo: '”', lsquo: '‘', rsquo: '’', sbquo: '‚',
  rarr: '→', larr: '←', middot: '·', bull: '•', times: '×', deg: '°', copy: '©', reg: '®', trade: '™',
};

function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e) => {
    if (e[0] === '#') return String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : Number(e.slice(1)));
    return ENTITIES[e] ?? m;
  });
}

function inlineText(html) {
  return blockText(html).trim().replace(/\s*\n\s*/g, ' / ').replace(/\s+/g, ' ');
}

function blockText(html) {
  return html
    .replace(/<ac:structured-macro[^>]*ac:name="code"[^>]*>([\s\S]*?)<\/ac:structured-macro>/g, (_, inner) => {
      const lang = inner.match(/<ac:parameter ac:name="language">([^<]*)<\/ac:parameter>/)?.[1] || '';
      const code = inner.match(/<!\[CDATA\[([\s\S]*?)\]\]>/)?.[1] ?? '';
      return `\n\`\`\`${lang}\n${code.replace(/</g, '\u0002lt;').replace(/&/g, '\u0002amp;')}\n\`\`\`\n`;
    })
    .replace(/<ac:task>[\s\S]*?<ac:task-status>(\w+)<\/ac:task-status>[\s\S]*?<ac:task-body>([\s\S]*?)<\/ac:task-body>[\s\S]*?<\/ac:task>/g, (_, st, body) => `\n- [${st === 'complete' ? 'x' : ' '}] ${inlineText(body)}`)
    .replace(/<a\s[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, (_, href, label) => {
      const text = inlineText(label);
      return !text || text === href ? `<${href}>` : `[${text}](${href})`;
    })
    .replace(/<(strong|b)(\s[^>]*)?>([\s\S]*?)<\/\1>/gi, (_, _t, _a, x) => (x.trim() ? `**${x.trim()}**` : x))
    .replace(/<(em|i)(\s[^>]*)?>([\s\S]*?)<\/\1>/gi, (_, _t, _a, x) => (x.trim() ? `*${x.trim()}*` : x))
    .replace(/<(del|s)(\s[^>]*)?>([\s\S]*?)<\/\1>/gi, (_, _t, _a, x) => (x.trim() ? `~~${x.trim()}~~` : x))
    .replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, '`$1`')
    .replace(/<ol[^>]*>([\s\S]*?)<\/ol>/gi, (_, inner) => inner.replace(/<li[^>]*>/gi, '\n1. ') + '\n')
    .replace(/<blockquote[^>]*>([\s\S]*?)<\/blockquote>/gi, (_, inner) => '\n\n' + blockText(inner).trim().split('\n').map((l) => `> ${l}`).join('\n') + '\n\n')
    .replace(/<table[^>]*>([\s\S]*?)<\/table>/gi, (_, t) => {
      const rows = [...t.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)].map((r) =>
        [...r[1].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((c) => inlineText(c[1]).replace(/\|/g, '\\|')),
      );
      const lines = rows.map((cells) => `| ${cells.join(' | ')} |`);
      if (rows.length) lines.splice(1, 0, `|${rows[0].map(() => ' --- ').join('|')}|`);
      return '\n\n' + lines.join('\n') + '\n\n';
    })
    .replace(/<(br|hr)\s*\/?>/gi, '\n')
    .replace(/<li[^>]*>/gi, '\n- ')
    .replace(/<h([1-6])[^>]*>/gi, (_, n) => '\n\n' + '#'.repeat(Number(n)) + ' ')
    .replace(/<\/(h[1-6]|ac:task-list)>/gi, '\n\n')
    .replace(/<\/(p|div|ul|ol|blockquote)>/gi, '\n')
    .replace(/<ri:user[^>]*ri:account-id="([^"]+)"[^>]*\/>/g, '@user:$1')
    .replace(/<ac:link>[\s\S]*?<ri:page[^>]*ri:content-title="([^"]+)"[^>]*\/>[\s\S]*?<\/ac:link>/g, '[[$1]]')
    .replace(/<ri:page[^>]*ri:content-title="([^"]+)"[^>]*\/>/g, '[[$1]]')
    .replace(/<[^>]+>/g, '');
}

export function htmlToText(html = '') {
  return decodeEntities(blockText(html || '').replace(/\*\*\*\*/g, ''))
    .replace(/\u0002(lt|amp);/g, (_, e) => (e === 'lt' ? '<' : '&'))
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// Body text from --body, --file, or stdin (`--body -` or piped input).
export async function readBody(opts, { required = true } = {}) {
  if (opts.file) return readFileSync(opts.file, 'utf8');
  if (opts.body !== undefined && opts.body !== '-') return opts.body;
  if (opts.body === '-' || !process.stdin.isTTY) {
    const chunks = [];
    for await (const c of process.stdin) chunks.push(c);
    const s = Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/, '');
    if (s.length) return s;
  }
  if (required) throw new Error('No body given. Use --body "<text>", --file <path>, or pipe via stdin.');
  return undefined;
}

export function shortDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function csv(v) {
  return v === undefined ? undefined : String(v).split(',').map((s) => s.trim()).filter(Boolean);
}
