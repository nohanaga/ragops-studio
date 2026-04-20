import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'

import { TipsBlock } from './TipsBlock'

function html(text: string): string {
  return renderToStaticMarkup(<TipsBlock text={text} />)
}

describe('TipsBlock', () => {
  it('renders paragraphs for non-bullet lines', () => {
    const out = html('hello world\n\nsecond line')
    expect(out).toContain('<p class="edgTips__para">hello world</p>')
    expect(out).toContain('<p class="edgTips__para">second line</p>')
  })

  it('groups consecutive ・ lines into a single ul', () => {
    const out = html('・one\n・two\n・three')
    expect(out).toMatch(/<ul[^>]*><li>one<\/li><li>two<\/li><li>three<\/li><\/ul>/)
  })

  it('also accepts "- " bullets', () => {
    const out = html('- alpha\n- beta')
    expect(out).toMatch(/<ul[^>]*><li>alpha<\/li><li>beta<\/li><\/ul>/)
  })

  it('renders **bold**, `code`, and [link](url) inline', () => {
    const out = html('this is **bold** and `code` and a [site](https://example.com).')
    expect(out).toContain('<strong>bold</strong>')
    expect(out).toContain('<code>code</code>')
    expect(out).toContain('<a href="https://example.com" target="_blank" rel="noreferrer noopener">site</a>')
  })

  it('renders non-http(s) links as plain text', () => {
    const out = html('bad [x](javascript:alert1) and [y](data:text/plain,1)')
    expect(out).not.toContain('<a href="javascript:alert1"')
    expect(out).not.toContain('<a href="data:text/plain,1"')
    expect(out).toContain('bad x and y')
  })

  it('keeps bullets and paragraphs separate when interleaved', () => {
    const out = html('intro line\n・first item\n・second item\noutro line')
    expect(out).toMatch(
      /<p[^>]*>intro line<\/p><ul[^>]*><li>first item<\/li><li>second item<\/li><\/ul><p[^>]*>outro line<\/p>/,
    )
  })

  it('does not interpret raw HTML', () => {
    const out = html('<script>alert(1)</script>')
    expect(out).not.toContain('<script>')
    expect(out).toContain('&lt;script&gt;')
  })
})
