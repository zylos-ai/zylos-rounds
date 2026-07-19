/**
 * Minimal markdown renderer for LLM-generated digest text.
 * Supports: ###/##/# headings, -/* bullets, 1. ordered lists,
 * **bold**, `inline code`, paragraphs. No raw HTML pass-through —
 * everything renders as text nodes, so no sanitizing needed.
 */

function inline(text, keyBase) {
  const out = [];
  // split on **bold** and `code` tokens
  const re = /(\*\*[^*]+\*\*|`[^`]+`)/g;
  let last = 0, m, i = 0;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const tok = m[0];
    if (tok.startsWith('**')) out.push(<strong key={`${keyBase}-b${i++}`}>{tok.slice(2, -2)}</strong>);
    else out.push(<code key={`${keyBase}-c${i++}`} className="rounded bg-muted px-1 py-0.5 text-[0.85em]">{tok.slice(1, -1)}</code>);
    last = m.index + tok.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export function Markdown({ text, className }) {
  const lines = String(text || '').replace(/\r\n/g, '\n').split('\n');
  const blocks = [];
  let list = null; // { ordered, items }

  const flushList = () => {
    if (!list) return;
    const k = `l${blocks.length}`;
    const items = list.items.map((it, i) => <li key={`${k}-${i}`}>{inline(it, `${k}-${i}`)}</li>);
    blocks.push(list.ordered
      ? <ol key={k} className="my-1.5 list-decimal space-y-1 pl-5">{items}</ol>
      : <ul key={k} className="my-1.5 list-disc space-y-1 pl-5">{items}</ul>);
    list = null;
  };

  for (const raw of lines) {
    const line = raw.trimEnd();
    const h = /^(#{1,4})\s+(.*)$/.exec(line);
    const ul = /^\s*[-*]\s+(.*)$/.exec(line);
    const ol = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (h) {
      flushList();
      const k = `h${blocks.length}`;
      // digests live inside a card — render all heading levels compact
      blocks.push(<p key={k} className={cnHeading(h[1].length)}>{inline(h[2], k)}</p>);
    } else if (ul || ol) {
      const item = (ul || ol)[1];
      const ordered = !!ol;
      if (list && list.ordered !== ordered) flushList();
      if (!list) list = { ordered, items: [] };
      list.items.push(item);
    } else if (!line.trim()) {
      flushList();
    } else {
      flushList();
      const k = `p${blocks.length}`;
      blocks.push(<p key={k} className="my-1.5">{inline(line, k)}</p>);
    }
  }
  flushList();
  return <div className={className}>{blocks}</div>;
}

function cnHeading(level) {
  if (level <= 2) return 'mb-1.5 mt-4 text-[1.02em] font-semibold first:mt-0';
  return 'mb-1 mt-3 font-semibold first:mt-0';
}
