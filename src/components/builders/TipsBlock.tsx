/**
 * Tiny inline renderer used by the EDAG Tips section.
 *
 * Supported syntax (kept intentionally minimal so we don't pull in a
 * full markdown library):
 *   - line breaks via `\n`
 *   - lines starting with `・` or `- ` are grouped into an unordered list
 *   - other lines render as paragraphs
 *   - inline:  **bold**   `code`   [text](url)
 *
 * No raw HTML is interpreted, so user-provided text cannot inject markup.
 */

import type { ReactNode } from 'react'

function isSafeExternalLink(url: string): boolean {
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
  } catch {
    return false
  }
}

/** Split inline `**bold**`, `` `code` ``, and `[text](url)` into ReactNodes. */
function renderInline(text: string): ReactNode[] {
  // Tokenize: bold, code, link, text. Order matters: code first to avoid
  // `**` clashes inside snippets.
  const out: ReactNode[] = []
  const re = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\[[^\]]+\]\((?:[^()\s]+|\([^)]*\))+\))/g
  let lastIndex = 0
  let m: RegExpExecArray | null
  let key = 0
  while ((m = re.exec(text))) {
    if (m.index > lastIndex) out.push(text.slice(lastIndex, m.index))
    const tok = m[0]
    if (tok.startsWith('`')) {
      out.push(<code key={`c${key++}`}>{tok.slice(1, -1)}</code>)
    } else if (tok.startsWith('**')) {
      out.push(<strong key={`b${key++}`}>{tok.slice(2, -2)}</strong>)
    } else {
      // [text](url)
      const lm = /^\[([^\]]+)\]\(((?:[^()\s]+|\([^)]*\))+)\)$/.exec(tok)
      if (lm) {
        if (isSafeExternalLink(lm[2])) {
          out.push(
            <a key={`a${key++}`} href={lm[2]} target="_blank" rel="noreferrer noopener">
              {lm[1]}
            </a>,
          )
        } else {
          out.push(lm[1])
        }
      } else {
        out.push(tok)
      }
    }
    lastIndex = re.lastIndex
  }
  if (lastIndex < text.length) out.push(text.slice(lastIndex))
  return out
}

interface TipsBlockProps {
  text: string
}

/**
 * Render a Tips text blob with line-level structure (paragraphs +
 * bullet groups) and inline emphasis / code / links.
 */
export function TipsBlock({ text }: TipsBlockProps): ReactNode {
  const lines = text.split('\n')
  type Para = { kind: 'p'; text: string }
  type List = { kind: 'ul'; items: string[] }
  const blocks: Array<Para | List> = []
  for (const raw of lines) {
    const line = raw.trim()
    if (!line) continue
    const isBullet = line.startsWith('・') || line.startsWith('- ')
    const stripped = isBullet ? line.replace(/^・|^- /, '').trim() : line
    if (isBullet) {
      const last = blocks[blocks.length - 1]
      if (last && last.kind === 'ul') last.items.push(stripped)
      else blocks.push({ kind: 'ul', items: [stripped] })
    } else {
      blocks.push({ kind: 'p', text: stripped })
    }
  }
  return (
    <>
      {blocks.map((b, i) =>
        b.kind === 'ul' ? (
          <ul key={i} className="edgTips__list">
            {b.items.map((it, j) => (
              <li key={j}>{renderInline(it)}</li>
            ))}
          </ul>
        ) : (
          <p key={i} className="edgTips__para">
            {renderInline(b.text)}
          </p>
        ),
      )}
    </>
  )
}
