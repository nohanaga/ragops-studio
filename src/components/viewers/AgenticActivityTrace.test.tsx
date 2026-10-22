// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { AgenticActivityTimeline } from './AgenticActivityTimeline'
import { translations } from '../../lib/translations'

afterEach(cleanup)
const t = (key: keyof typeof translations.en) => translations.en[key]

describe('AgenticActivityTrace', () => {
  it('places Timeline after Trace and Graph and preserves proportional timing and recorded row order', () => {
    render(<AgenticActivityTimeline t={t} activity={[
      { type: 'modelQueryPlanning', id: 0, elapsedMs: 50 },
      { type: 'searchIndex', id: 1, startedAt: '2026-10-22T00:00:00.000Z', completedAt: '2026-10-22T00:00:00.100Z', elapsedMs: 9999 },
      { type: 'web', id: 2, startedAt: '2026-10-22T00:00:00.050Z', completedAt: '2026-10-22T00:00:00.150Z', elapsedMs: 1 },
    ]} />)
    const buttons = within(screen.getByRole('group', { name: 'Flow view mode' })).getAllByRole('button')
    expect(buttons.map((button) => button.textContent?.trim())).toEqual(['Trace', 'Graph', 'Timeline'])
    fireEvent.click(screen.getByRole('button', { name: 'Timeline' }))
    const search = screen.getByRole('button', { name: /^searchIndex #1 · startedAt:/ })
    const web = screen.getByRole('button', { name: /^web #2 · startedAt:/ })
    expect(parseFloat(search.style.left)).toBe(0)
    expect(parseFloat(web.style.left)).toBeCloseTo(100 / 3)
    expect(parseFloat(search.style.width)).toBeCloseTo(200 / 3)
    expect(parseFloat(web.style.width)).toBeCloseTo(200 / 3)
    expect(search).toHaveClass('actTrace__bar--parallel')
    expect(web).toHaveClass('actTrace__bar--parallel')
    expect(screen.getAllByRole('listitem').map((row) => row.dataset.activityId)).toEqual(['activity-0', 'activity-1', 'activity-2'])
    fireEvent.click(web)
    expect(screen.getByRole('button', { name: /^Hide details: web #2/ })).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByRole('region', { name: 'Node details' })).toHaveTextContent('web')
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument()
    expect(screen.getByText('Unplaced')).toBeInTheDocument()
    expect(screen.queryByText(translations.en.actTimelineElapsed)).not.toBeInTheDocument()
    expect(screen.queryByText('9,999 ms')).not.toBeInTheDocument()
  })

  it('does not fabricate an execution axis when only elapsedMs and queryTime are recorded', () => {
    render(<AgenticActivityTimeline t={t} activity={[
      { type: 'modelQueryPlanning', id: 0, elapsedMs: 80, queryTime: '2026-10-22T00:00:00Z' },
      { type: 'modelAnswerSynthesis', id: 1, elapsedMs: 40 },
    ]} />)
    fireEvent.click(screen.getByRole('button', { name: 'Timeline' }))
    expect(screen.getByText(translations.en.actTraceNoTimes)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^modelAnswerSynthesis #1 · startedAt:/ })).not.toBeInTheDocument()
    expect(screen.queryByText('Summed duration')).not.toBeInTheDocument()
  })

  it('shows invalid timestamp warnings rather than fabricated intervals', () => {
    render(<AgenticActivityTimeline t={t} activity={[
      { type: 'web', id: 1, startedAt: '2026-10-22T00:00:01Z', completedAt: '2026-10-22T00:00:00Z', elapsedMs: 100 },
    ]} />)
    fireEvent.click(screen.getByRole('button', { name: 'Timeline' }))
    expect(screen.getByRole('alert')).toHaveTextContent(translations.en.actTraceInvalidTimes)
    expect(screen.queryByRole('button', { name: /^web #1 · startedAt:/ })).not.toBeInTheDocument()
  })

  it('renders a lone timestamp as a point without using elapsedMs to infer a start', () => {
    render(<AgenticActivityTimeline t={t} activity={[
      { type: 'web', id: 1, completedAt: '2026-10-22T00:00:00Z', elapsedMs: 80 },
    ]} />)
    fireEvent.click(screen.getByRole('button', { name: 'Timeline' }))
    const point = screen.getByRole('button', { name: /^web #1 · startedAt:/ })
    expect(point).toHaveClass('actTrace__bar--point')
    expect(point).not.toHaveClass('actTrace__bar--parallel')
    expect(point.style.width).toBe('0%')
    expect(point).toHaveAttribute('title', expect.stringContaining('Duration: Unknown / not recorded'))
  })

  it('expands details within the selected row and keeps status and type badges visible', () => {
    const activity = [{
      type: 'searchIndex', id: 1, knowledgeSourceName: 'products',
      startedAt: '2026-10-22T00:00:00Z', completedAt: '2026-10-22T00:00:00.100Z',
    }]
    render(<AgenticActivityTimeline t={t} activity={activity} response={{
      at: undefined, requestId: '', url: '', status: 200, runType: 'agentic_retrieve',
      requestBody: {}, body: { activity, response: [] },
    }} />)
    fireEvent.click(screen.getByRole('button', { name: 'Timeline' }))
    expect(screen.getByText('Retrieval')).toHaveClass('actTrace__badge')
    expect(screen.getByRole('img', { name: 'Completed' })).toHaveClass('actTrace__status--completed')
    expect(screen.queryByRole('region', { name: 'Node details' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /^Show details: searchIndex/ }))
    const details = screen.getByRole('region', { name: 'Node details' })
    expect(details.closest('[data-activity-id]')).toHaveAttribute('data-activity-id', 'activity-0')
    fireEvent.click(screen.getByRole('button', { name: /^Hide details: searchIndex/ }))
    expect(screen.queryByRole('region', { name: 'Node details' })).not.toBeInTheDocument()
  })

  it('formats long durations in seconds without changing the measured interval', () => {
    render(<AgenticActivityTimeline t={t} activity={[
      { type: 'web', id: 1, startedAt: '2026-10-22T00:00:00Z', completedAt: '2026-10-22T00:01:28.540Z' },
    ]} />)
    fireEvent.click(screen.getByRole('button', { name: 'Timeline' }))
    const row = screen.getByRole('listitem')
    expect(within(row).getByText('88.54 s')).toHaveClass('actTrace__duration')
    expect(screen.getByRole('button', { name: /^web #1 · startedAt:/ }).style.width).toBe('100%')
  })

  it('uses the Japanese timeline label and localized action badges', () => {
    render(<AgenticActivityTimeline t={(key) => translations.ja[key]} language="ja" activity={[{ type: 'agenticReasoning', id: 1 }]} />)
    fireEvent.click(screen.getByRole('button', { name: 'タイムライン' }))
    expect(screen.getByText('推論')).toHaveClass('actTrace__badge')
    expect(screen.getByRole('list', { name: '実行タイムライン' })).toBeInTheDocument()
  })

  it('shows missing activity without creating trace rows', () => {
    render(<AgenticActivityTimeline t={t} activity={[]} response={{
      at: undefined, requestId: '', url: '', status: 200, runType: 'agentic_retrieve',
      requestBody: {}, body: { response: [] },
    }} />)
    fireEvent.click(screen.getByRole('button', { name: 'Timeline' }))
    expect(screen.getByText(translations.en.actGraphNoActivity)).toBeInTheDocument()
    expect(screen.queryByRole('listitem')).not.toBeInTheDocument()
  })
})
