const esc = (s: string) =>
  s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

function inline(s: string): string {
  return s
    .replace(/`([^`]+)`/g, (_, c: string) => `<code class="md__code">${esc(c)}</code>`)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[\s(])\*([^*\n]+)\*/g, '$1<em>$2</em>')
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>');
}

export function markdown(src: string): string {
  const lines = src.split('\n');
  const out: string[] = [];
  let i = 0;
  let list: string[] | null = null;

  const flushList = () => {
    if (list) {
      out.push(`<ul class="md__list">${list.map((li) => `<li>${inline(li)}</li>`).join('')}</ul>`);
      list = null;
    }
  };

  while (i < lines.length) {
    const line = lines[i];

    if (line.startsWith('```')) {
      flushList();
      const lang = line.slice(3).trim();
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith('```')) {
        body.push(lines[i]);
        i++;
      }
      i++;
      out.push(
        `<pre class="md__pre" data-lang="${esc(lang)}"><code>${esc(body.join('\n'))}</code></pre>`,
      );
      continue;
    }

    if (/^\s*$/.test(line)) {
      flushList();
      i++;
      continue;
    }

    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    if (heading) {
      flushList();
      const level = heading[1].length;
      out.push(`<h${level + 2} class="md__h">${inline(heading[2])}</h${level + 2}>`);
      i++;
      continue;
    }

    if (/^\s*[-*]\s+/.test(line)) {
      list = list ?? [];
      list.push(line.replace(/^\s*[-*]\s+/, ''));
      i++;
      continue;
    }

    if (/^\s*>\s?/.test(line)) {
      flushList();
      const body: string[] = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
        body.push(lines[i].replace(/^\s*>\s?/, ''));
        i++;
      }
      out.push(`<blockquote class="md__quote">${inline(body.join(' '))}</blockquote>`);
      continue;
    }

    flushList();
    const para: string[] = [];
    while (
      i < lines.length &&
      !/^\s*$/.test(lines[i]) &&
      !/^(#{1,4}\s|```|\s*[-*]\s|\s*>\s?)/.test(lines[i])
    ) {
      para.push(lines[i]);
      i++;
    }
    out.push(`<p class="md__p">${inline(para.join(' '))}</p>`);
  }

  flushList();
  return out.join('');
}

export function plain(src: string, max = 220): string {
  const flat = src
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/[*#>]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}
