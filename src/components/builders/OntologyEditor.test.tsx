// @vitest-environment jsdom

import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PORTAL_CARDS } from '../../app/featurePortalCards'
import { BASIC_GUIDES } from '../../app/featurePortalGuides.basic'
import { EMPTY_ONTOLOGY } from '../../lib/knowledgeGraph'
import { OntologyEditor } from './OntologyEditor'

vi.mock('../viewers/KnowledgeGraphCanvas', () => ({ KnowledgeGraphCanvas: () => null }))
vi.mock('./GraphJsonEditor', () => ({ GraphJsonEditor: () => null }))

describe('OntologyEditor', () => {
  afterEach(cleanup)

  it('renders every element that the Feature Portal guides highlight', () => {
    render(<OntologyEditor value={EMPTY_ONTOLOGY} onChange={() => {}} onOpenPlayground={() => {}} language="en" theme="dark" />)
    const guides = [PORTAL_CARDS.find((card) => card.id === 'ontology-editor')?.guide, BASIC_GUIDES['ontology-editor']]
    const selectors = new Set(guides.flatMap((guide) => guide?.steps ?? []).flatMap((step) => step.targetSelector ?? []).filter((selector) => selector.includes('"oe-')))
    expect(selectors.size).toBeGreaterThan(0)
    for (const selector of selectors) expect(document.querySelector(selector), selector).not.toBeNull()
  })
})
