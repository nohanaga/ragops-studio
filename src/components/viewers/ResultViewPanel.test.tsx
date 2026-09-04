import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { translations } from '../../lib/translations'
import { ResultViewPanel } from './ResultViewPanel'

describe('ResultViewPanel', () => {
  it('identifies streaming execution before the first event arrives', () => {
    render(
      <ResultViewPanel
        view={{
          id: 'latest',
          label: 'Results (latest)',
          response: null,
          runType: null,
        }}
        currentPage={1}
        onPageChange={vi.fn()}
        t={(key) => translations.ja[key]}
        language="ja"
        compareMode={false}
        onCompareModeChange={vi.fn()}
        isStreamingResponse
      />,
    )

    expect(screen.getByText('ストリーミング中')).toBeInTheDocument()
    expect(screen.getByText('ストリーミング応答を受信中')).toBeInTheDocument()
    expect(screen.getByText('接続し、最初のイベントを待っています。')).toBeInTheDocument()
    expect(screen.queryByText(translations.ja.noResults)).not.toBeInTheDocument()
  })
})