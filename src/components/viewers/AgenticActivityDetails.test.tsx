// @vitest-environment jsdom

import { cleanup, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { buildActivityGraph } from '../../lib/agenticActivityGraph'
import type { JsonValue } from '../../lib/aiSearchRest'
import { translations, type Language } from '../../lib/translations'
import { AgenticActivityDetails } from './AgenticActivityDetails'

afterEach(cleanup)

function renderDetails(selectedId: 'request' | 'result', requestBody: JsonValue, body: JsonValue, language: Language = 'en') {
  const t = (key: keyof typeof translations.en) => translations[language][key]
  const { nodes } = buildActivityGraph({
    items: [], t,
    response: { at: undefined, requestId: '', url: '', status: 200, runType: 'agentic_retrieve', requestBody, body },
  })
  render(<AgenticActivityDetails nodes={nodes} selectedId={selectedId} onSelect={() => {}} t={t} language={language} renderActivity={() => null} />)
  return screen.getByRole('region', { name: t(selectedId === 'request' ? 'actGraphRequestText' : 'actGraphResultText') })
}

describe('AgenticActivityDetails text fields', () => {
  it('shows every request message and intent in dedicated blocks without flattening roles or losing newlines', () => {
    const region = renderDetails('request', {
      messages: [
        { role: 'system', content: 'Use the supplied data.' },
        { role: 'user', content: [{ type: 'text', text: 'First question\nwith another line' }, { type: 'image', url: 'not-text' }, { type: 'text', text: 'Second question' }] },
      ],
      intents: [{ type: 'semantic', search: 'First intent' }, { type: 'semantic', search: 'Second intent' }],
    }, {})
    const bodies = region.querySelectorAll('.actGraph__textBody')
    expect(Array.from(bodies, (node) => node.textContent)).toEqual([
      'Use the supplied data.', 'First question\nwith another line', 'Second question', 'First intent', 'Second intent',
    ])
    expect(within(region).getByText('system')).toBeInTheDocument()
    expect(within(region).getAllByText('user')).toHaveLength(2)
    expect(within(region).getAllByText('intents · semantic')).toHaveLength(2)
    expect(region).not.toHaveTextContent('not-text')
    expect(screen.getByText('Recorded data')).toBeInTheDocument()
  })

  it('renders the complete final result text literally, including long content and markup-like text', () => {
    const text = `<img src=x onerror=alert(1)>\n${'Full response. '.repeat(1000)}\nLast line.`
    const region = renderDetails('result', {}, { response: [{ role: 'assistant', content: [{ type: 'text', text }] }] })
    expect(region.querySelector('.actGraph__textBody')?.textContent).toBe(text)
    expect(region.querySelector('img')).toBeNull()
    expect(within(region).getByText('assistant')).toBeInTheDocument()
  })

  it('shows extractive text and multiple output messages without treating serialized grounding text as absent', () => {
    const grounding = '[{"ref_id":"0","content":"Evidence"}]'
    const region = renderDetails('result', { outputMode: 'extractiveData' }, {
      response: [
        { content: [{ type: 'text', text: grounding }, { type: 'image', url: 'not-text' }] },
        { role: 'assistant', content: 'Additional output' },
      ],
    })
    expect(Array.from(region.querySelectorAll('.actGraph__textBody'), (node) => node.textContent)).toEqual([grounding, 'Additional output'])
  })

  it.each(['request', 'result'] as const)('explicitly indicates missing %s text instead of substituting error text', (selectedId) => {
    const region = renderDetails(selectedId, {}, { error: { message: 'source failed' } })
    expect(within(region).getByText('No text is included.')).toBeInTheDocument()
    expect(region.querySelector('.actGraph__textBody')).toBeNull()
    expect(region).not.toHaveTextContent('source failed')
  })

  it('localizes request and result headings in Japanese', () => {
    const region = renderDetails('request', { intents: [{ type: 'semantic', search: '検索したい内容' }] }, {}, 'ja')
    expect(within(region).getByRole('heading', { name: '検索要求のテキスト' })).toBeInTheDocument()
    expect(within(region).getByText('検索したい内容')).toBeInTheDocument()
  })
})
