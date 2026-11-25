// @vitest-environment jsdom

import { StrictMode } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getIndexDefinition, indexDocuments, listIndexes, listKnowledgeSources, queryKnowledgeGraph, searchDocuments, type JsonValue, type RestResult } from '../../lib/aiSearchRest'
import { EMPTY_ONTOLOGY } from '../../lib/knowledgeGraph'
import { paramTooltips } from '../../lib/translations'
import { KnowledgeGraphPlayground } from './KnowledgeGraphPlayground'

vi.mock('../../lib/aiSearchRest')
vi.mock('../viewers/KnowledgeGraphCanvas', () => ({ KnowledgeGraphCanvas: () => null }))
vi.mock('./GraphJsonEditor', () => ({
  GraphJsonEditor: ({ value, onChange, readOnly }: { value: string; onChange?: (value: string) => void; readOnly?: boolean }) =>
    <textarea aria-label="Graph draft" value={value} readOnly={readOnly ?? !onChange} onChange={(event) => onChange?.(event.target.value)} />,
}))

const profile = { endpoint: 'https://example.search.windows.net', apiVersion: '2026-11-01-preview' as const, authType: 'apiKey' as const, apiKey: 'test-key' }
const fields = {
  assertionIdField: 'id', subjectField: 'subject', subjectIdField: 'sid', subjectTypeField: 'stype',
  predicateField: 'predicate', objectField: 'object', objectIdField: 'oid', objectTypeField: 'otype', graphNameField: 'graph',
}
const definition = { fields: Object.values(fields).map((name) => ({ name, key: name === 'id' })), graphProfile: { fields } }
const document = { id: 'edge', subject: 'A', sid: 'a', stype: 'Person', predicate: 'knows', object: 'B', oid: 'b', otype: 'Person', graph: 'g' }
const success = (response: JsonValue): RestResult => ({ ok: true, status: 200, url: '/test', requestId: 'test-request', response })
const dialogMethods = {
  showModal: Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, 'showModal'),
  close: Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, 'close'),
}

function playground(active = true) {
  return <StrictMode><KnowledgeGraphPlayground active={active} profile={profile} language="en" theme="dark"
    ontologyJson={EMPTY_ONTOLOGY} onOntologyChange={() => {}} onOpenOntology={() => {}} /></StrictMode>
}

async function openGraph() {
  render(playground())
  await screen.findByRole('option', { name: 'graph-a' })
  fireEvent.change(screen.getByRole('combobox', { name: 'Graph index' }), { target: { value: 'graph-a' } })
  await waitFor(() => expect(screen.getByRole('button', { name: /Run query/ })).toBeEnabled())
}

describe('KnowledgeGraphPlayground controls', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    Object.defineProperties(HTMLDialogElement.prototype, {
      showModal: { configurable: true, value(this: HTMLDialogElement) { this.setAttribute('open', '') } },
      close: { configurable: true, value(this: HTMLDialogElement) { this.removeAttribute('open') } },
    })
    vi.stubGlobal('ResizeObserver', class {
      observe() {}
      disconnect() {}
    })
    vi.mocked(listIndexes).mockResolvedValue(success({ value: [{ name: 'graph-a', ...definition }, { name: 'graph-b', ...definition }] }))
    vi.mocked(listKnowledgeSources).mockResolvedValue(success({ value: [] }))
    vi.mocked(getIndexDefinition).mockImplementation(async ({ indexName }) => success({ name: indexName, ...definition }))
    vi.mocked(searchDocuments).mockResolvedValue(success({ value: [document] }))
  })
  afterEach(() => {
    cleanup()
    for (const [method, descriptor] of Object.entries(dialogMethods)) {
      if (descriptor) Object.defineProperty(HTMLDialogElement.prototype, method, descriptor)
      else Reflect.deleteProperty(HTMLDialogElement.prototype, method)
    }
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('lists resources once per active tab visit without reloading the selected graph', async () => {
    const { rerender } = render(playground(false))
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
    expect(listIndexes).not.toHaveBeenCalled()
    expect(listKnowledgeSources).not.toHaveBeenCalled()

    rerender(playground())
    await screen.findByRole('option', { name: 'graph-a' })
    expect(listIndexes).toHaveBeenCalledTimes(1)
    expect(listKnowledgeSources).toHaveBeenCalledTimes(1)

    const index = screen.getByRole('combobox', { name: 'Graph index' })
    fireEvent.change(index, { target: { value: 'graph-a' } })
    await waitFor(() => expect(screen.getByRole('button', { name: /Run query/ })).toBeEnabled())
    rerender(playground(false))
    rerender(playground())
    await waitFor(() => expect(listIndexes).toHaveBeenCalledTimes(2))
    expect(listKnowledgeSources).toHaveBeenCalledTimes(2)
    expect(index).toHaveValue('graph-a')
    expect(searchDocuments).toHaveBeenCalledTimes(1)
  })

  it('shows read-only property details before JSON and retains the selection when the pane is toggled', async () => {
    vi.mocked(searchDocuments).mockResolvedValue(success({ value: [{ ...document, confidence: 0, verified: false }] }))
    await openGraph()
    expect(screen.getByText('Select a node or relationship to view the properties of its associated record.')).toBeVisible()
    fireEvent.click(screen.getByText('Relationships', { exact: false, selector: 'summary' }))
    fireEvent.click(screen.getByRole('button', { name: /A knows B/ }))
    const inspector = screen.getByRole('complementary')
    const grid = within(inspector).getByRole('table', { name: 'Selected definition / assertion' })
    expect(within(grid).getByRole('cell', { name: 'knows' })).toBeVisible()
    expect(within(grid).getByRole('cell', { name: '0' })).toBeVisible()
    expect(within(grid).getByRole('cell', { name: 'false' })).toBeVisible()
    expect(within(inspector).queryByRole('textbox')).not.toBeInTheDocument()
    fireEvent.click(within(inspector).getByRole('button', { name: 'Selected record JSON' }))
    expect(within(inspector).getByRole('textbox')).toHaveAttribute('readonly')
    fireEvent.click(screen.getByRole('button', { name: 'Hide inspector' }))
    expect(inspector).not.toBeVisible()
    expect(screen.queryByRole('separator')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Show inspector' }))
    expect(within(inspector).getByRole('cell', { name: 'knows' })).toBeVisible()
  })

  it('starts with a predicate-scoped query and preserves manually edited GQL across index changes', async () => {
    await openGraph()
    const input = screen.getByRole('textbox', { name: 'GQL' })
    expect(input).toHaveValue('MATCH (a)-[r:`knows`]->(b) RETURN a.name AS subject, r.predicate AS predicate, b.name AS object LIMIT 25')
    const custom = 'MATCH (a:`Person`)-[r]->(b) RETURN a.name LIMIT 10'
    fireEvent.change(input, { target: { value: custom } })
    fireEvent.change(screen.getByRole('combobox', { name: 'Graph index' }), { target: { value: 'graph-b' } })
    await waitFor(() => expect(searchDocuments).toHaveBeenLastCalledWith(expect.objectContaining({ indexName: 'graph-b' })))
    expect(input).toHaveValue(custom)
  })

  it('restores the last GQL guide visibility after reopening the playground', () => {
    const first = render(playground(false))
    expect(screen.getByRole('heading', { name: 'GQL input guide' })).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'Hide guide', expanded: true }))
    first.unmount()

    const second = render(playground(false))
    expect(screen.queryByRole('heading', { name: 'GQL input guide' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Show guide', expanded: false }))
    second.unmount()

    render(playground(false))
    expect(screen.getByRole('button', { name: 'Hide guide', expanded: true })).toBeVisible()
    expect(screen.getByRole('heading', { name: 'GQL input guide' })).toBeVisible()
  })

  it('allows the GQL guide to be toggled when browser storage is blocked', () => {
    vi.spyOn(window, 'localStorage', 'get').mockImplementation(() => { throw new DOMException('Storage blocked', 'SecurityError') })
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    render(playground(false))

    expect(screen.getByRole('heading', { name: 'GQL input guide' })).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'Hide guide', expanded: true }))
    expect(screen.getByRole('button', { name: 'Show guide', expanded: false })).toBeVisible()
    expect(screen.queryByRole('heading', { name: 'GQL input guide' })).not.toBeInTheDocument()
  })

  it('inserts a template generated from the loaded graph, announces it and restores the previous query on undo', async () => {
    await openGraph()
    const input = screen.getByRole('textbox', { name: 'GQL' })
    const starter = (input as HTMLTextAreaElement).value
    const card = screen.getByRole('heading', { name: 'Retrieve one relationship by node types' }).closest('article')!
    expect(within(card).getByText('Values from this graph')).toBeVisible()
    fireEvent.click(within(card).getByRole('button', { name: 'Insert into editor' }))
    expect(input).toHaveValue([
      'MATCH (a:Person)-[r]->(b:Person)',
      "WHERE r.predicate = 'knows'",
      'RETURN a.name AS subject, r.predicate AS predicate, b.name AS object',
      'ORDER BY subject, object',
      'LIMIT 25',
    ].join('\n'))
    expect(queryKnowledgeGraph).not.toHaveBeenCalled()
    expect(screen.getByText('"Retrieve one relationship by node types" was put into the editor.')).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }))
    expect(input).toHaveValue(starter)
  })

  it('runs a template immediately with its provenance setting and the required hydrateDocuments object', async () => {
    vi.mocked(getIndexDefinition).mockImplementation(async ({ indexName }) =>
      success({ name: indexName, ...definition, graphProfile: { ...definition.graphProfile, provenanceIndexName: 'chunks' } }))
    vi.mocked(queryKnowledgeGraph).mockResolvedValue(success({ value: [] }))
    await openGraph()
    const card = screen.getByRole('heading', { name: 'See results with their evidence' }).closest('article')!
    expect(within(card).getByText('Switches Provenance to hydrate.')).toBeVisible()
    fireEvent.click(within(card).getByRole('button', { name: 'Insert and run' }))
    await waitFor(() => expect(queryKnowledgeGraph).toHaveBeenCalledTimes(1))
    expect(vi.mocked(queryKnowledgeGraph).mock.calls[0][0].body).toMatchObject({
      gql: expect.stringContaining("a.name = 'A' AND r.predicate = 'knows'"),
      provenance: { kind: 'hydrate', hydrateDocuments: {} },
    })
    expect(screen.getByRole('combobox', { name: /Provenance/ })).toHaveValue('hydrate')
  })

  it('omits provenance from the request when none is selected', async () => {
    vi.mocked(queryKnowledgeGraph).mockResolvedValue(success({ value: [] }))
    await openGraph()
    fireEvent.change(screen.getByRole('combobox', { name: /Provenance/ }), { target: { value: 'none' } })
    fireEvent.click(screen.getByRole('button', { name: /Run query/ }))
    await waitFor(() => expect(queryKnowledgeGraph).toHaveBeenCalledTimes(1))
    expect(vi.mocked(queryKnowledgeGraph).mock.calls[0][0].body).not.toHaveProperty('provenance')
  })

  it('suggests node types while typing and inserts the chosen suggestion', async () => {
    await openGraph()
    const input = screen.getByRole('textbox', { name: 'GQL' })
    fireEvent.change(input, { target: { value: 'MATCH (a:Pe' } })
    const suggestions = screen.getByRole('group', { name: 'Suggestions' })
    fireEvent.click(within(suggestions).getByRole('button', { name: /^Person/ }))
    expect(input).toHaveValue('MATCH (a:Person')
  })

  it('shows beginner hints for a query that is easy to get wrong', async () => {
    await openGraph()
    fireEvent.change(screen.getByRole('textbox', { name: 'GQL' }), { target: { value: "MATCH (a)-[r]->(b) WHERE a.name == 'A'" } })
    const check = screen.getByRole('group', { name: 'Query check' })
    expect(within(check).getByText(/"==" is not a GQL operator/)).toBeVisible()
    expect(within(check).getByText(/RETURN is missing/)).toBeVisible()
  })

  it('filters entity and topic candidates and shows graph-specific filter guidance', async () => {
    vi.mocked(listIndexes).mockResolvedValue(success({ value: [
      { name: 'graph-a', ...definition }, { name: 'graph-b', ...definition },
      { name: 'content', vectorSearch: { topicGraphProfiles: [{ name: 'topics', indexName: 'graph-b' }] } },
    ] }))
    vi.mocked(listKnowledgeSources).mockResolvedValue(success({ value: [
      { name: 'source-a', kind: 'azureBlob', azureBlobParameters: { createdResources: { graphIndex: 'graph-a' } } },
    ] }))
    await openGraph()
    expect(screen.queryByRole('option', { name: 'graph-b' })).not.toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: 'OData filter' })).toHaveAttribute('placeholder', "predicate eq 'knows'")
    expect(screen.getByTitle(paramTooltips.en.graphODataFilter)).toBeInTheDocument()
    fireEvent.change(screen.getByRole('combobox', { name: 'Graph kind' }), { target: { value: 'topic' } })
    expect(screen.queryByRole('option', { name: 'graph-a' })).not.toBeInTheDocument()
    expect(screen.getByRole('option', { name: 'graph-b' })).toBeInTheDocument()
  })

  it('shows retrieved topic titles immediately, allows a custom title predicate and excludes relationship rows', async () => {
    vi.mocked(listIndexes).mockResolvedValue(success({ value: [
      { name: 'graph-a', ...definition },
      { name: 'content', vectorSearch: { topicGraphProfiles: [{ name: 'topics', indexName: 'graph-a' }] } },
    ] }))
    vi.mocked(searchDocuments).mockResolvedValue(success({ value: [
      { ...document, predicate: 'title', object: 'Security policies', oid: '', otype: 'String' },
      { ...document, id: 'second', predicate: 'topicTitle', object: 'Custom topic title', oid: '', otype: 'String' },
      { ...document, id: 'relation', predicate: 'parentTopic' },
    ] }))
    await openGraph()
    expect(screen.getByRole('cell', { name: 'Security policies' })).toBeInTheDocument()
    expect(screen.queryByRole('cell', { name: 'parentTopic' })).not.toBeInTheDocument()
    fireEvent.change(screen.getByRole('combobox', { name: 'Title predicate' }), { target: { value: 'topicTitle' } })
    expect(screen.getByRole('cell', { name: 'Custom topic title' })).toBeInTheDocument()
  })

  it('loads the selected index immediately and places resource refresh beside the dropdown', async () => {
    await openGraph()
    const dropdown = screen.getByRole('combobox', { name: 'Graph index' })
    const refresh = screen.getByRole('button', { name: 'Load resources' })
    expect(refresh.parentElement).toBe(dropdown.parentElement)
    expect(refresh.textContent?.trim()).toBe('')
    expect(getIndexDefinition).toHaveBeenLastCalledWith(expect.objectContaining({ indexName: 'graph-a' }))
    fireEvent.change(dropdown, { target: { value: 'graph-b' } })
    await waitFor(() => expect(searchDocuments).toHaveBeenLastCalledWith(expect.objectContaining({ indexName: 'graph-b' })))
  })

  it('previews form edits locally, protects the loaded selection and only writes after confirmation', async () => {
    await openGraph()
    fireEvent.click(screen.getByRole('button', { name: 'Edit graph documents' }))
    const editor = screen.getByRole('dialog', { name: 'Edit graph documents' })
    const predicate = within(editor).getByRole('textbox', { name: 'Predicate (relationship name)' })
    expect(predicate).toHaveValue('knows')
    fireEvent.change(predicate, { target: { value: '' } })
    expect(within(editor).getByRole('button', { name: 'Preview in graph' })).toBeDisabled()
    fireEvent.change(predicate, { target: { value: 'worksWith' } })
    fireEvent.click(within(editor).getByRole('button', { name: 'Preview in graph' }))
    fireEvent.click(screen.getByText('Relationships', { exact: false, selector: 'summary' }))
    expect(screen.getByRole('button', { name: 'A worksWith B' })).toBeVisible()
    fireEvent.change(screen.getByRole('combobox', { name: 'Graph index' }), { target: { value: 'graph-b' } })
    expect(await screen.findByRole('alert')).toHaveTextContent('An unsaved preview exists')
    expect(screen.getByRole('combobox', { name: 'Graph index' })).toHaveValue('graph-a')
    expect(getIndexDefinition).toHaveBeenCalledTimes(1)

    vi.mocked(indexDocuments).mockResolvedValue(success({ value: [{ key: 'edge', status: true }] }))
    fireEvent.click(screen.getByRole('button', { name: 'Review changes for Azure' }))
    const review = await screen.findByRole('dialog', { name: 'Review changes for Azure' })
    expect(within(review).getByRole('cell', { name: 'A → knows → B' })).toBeVisible()
    expect(within(review).getByRole('cell', { name: 'A → worksWith → B' })).toBeVisible()
    expect(indexDocuments).not.toHaveBeenCalled()
    fireEvent.click(within(review).getByRole('button', { name: 'Apply reviewed changes to Azure' }))
    await waitFor(() => expect(indexDocuments).toHaveBeenCalledWith(expect.objectContaining({
      indexName: 'graph-a', body: { value: [{ '@search.action': 'mergeOrUpload', ...document, predicate: 'worksWith' }] },
    })))
    await waitFor(() => expect(review).not.toBeInTheDocument())
  })

  it('dismisses the document editor from the header without applying staged edits', async () => {
    await openGraph()
    const open = screen.getByRole('button', { name: 'Edit graph documents' })
    fireEvent.click(open)
    const editor = screen.getByRole('dialog', { name: 'Edit graph documents' })
    fireEvent.change(within(editor).getByRole('textbox', { name: 'Predicate (relationship name)' }), { target: { value: 'worksWith' } })
    fireEvent.click(within(editor).getByRole('button', { name: 'Close', exact: true }))
    expect(editor).not.toBeInTheDocument()
    fireEvent.click(open)
    expect(within(screen.getByRole('dialog', { name: 'Edit graph documents' })).getByRole('textbox', { name: 'Predicate (relationship name)' })).toHaveValue('knows')
    expect(indexDocuments).not.toHaveBeenCalled()
  })

  it('can preview and export a managed graph but offers no Azure write action', async () => {
    vi.mocked(listKnowledgeSources).mockResolvedValue(success({ value: [
      { name: 'source-a', kind: 'azureBlob', azureBlobParameters: { createdResources: { graphIndex: 'graph-a' } } },
    ] }))
    await openGraph()
    fireEvent.click(screen.getByRole('button', { name: 'Edit graph documents' }))
    const editor = screen.getByRole('dialog', { name: 'Edit graph documents' })
    expect(within(editor).getByRole('button', { name: 'Export JSON' })).toBeEnabled()
    fireEvent.click(within(editor).getByRole('button', { name: 'Bulk edit (JSON)' }))
    fireEvent.change(within(editor).getByRole('textbox', { name: 'Graph draft' }), { target: { value: '[]' } })
    fireEvent.click(within(editor).getByRole('button', { name: 'Preview in graph' }))
    expect(screen.getByText('Preview · Not saved to Azure')).toBeVisible()
    expect(screen.queryByRole('button', { name: 'Review changes for Azure' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Reset preview' }))
    expect(screen.queryByText('Preview · Not saved to Azure')).not.toBeInTheDocument()
    expect(indexDocuments).not.toHaveBeenCalled()
  })

  it('shows GQL failures and request information in the query section, then clears them on editing', async () => {
    await openGraph()
    vi.mocked(queryKnowledgeGraph).mockResolvedValue({
      ok: false, status: 400, url: '/test', requestId: 'failed-request',
      error: { message: 'HTTP 400: Invalid GQL', response: { error: { code: 'InvalidGql', message: 'Invalid GQL' } } },
    })
    fireEvent.click(screen.getByRole('button', { name: /Run query/ }))
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('Invalid GQL')
    expect(alert).toHaveTextContent('failed-request')
    expect(alert.closest('.kgQuerySection')).toBe(screen.getByRole('textbox', { name: 'GQL' }).closest('.kgQuerySection'))
    fireEvent.change(screen.getByRole('textbox', { name: 'GQL' }), { target: { value: 'MATCH (a) RETURN a.name LIMIT 5' } })
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('opens relationship results as a graph and offers a themed JSON view instead of a raw tree', async () => {
    await openGraph()
    vi.mocked(queryKnowledgeGraph).mockResolvedValue(success({ value: [{ subject: 'A', predicate: 'knows', object: 'B' }] }))
    fireEvent.click(screen.getByRole('button', { name: /Run query/ }))
    const heading = await screen.findByRole('heading', { name: 'Response / provenance / diagnostics' })
    const section = heading.closest('section')
    if (!section) throw new Error('Missing result section')
    const result = within(section)
    expect(result.getByRole('button', { name: 'Result graph' })).toHaveAttribute('aria-pressed', 'true')
    fireEvent.click(result.getByRole('button', { name: 'Table', exact: true }))
    expect(result.getByRole('cell', { name: 'knows' })).toBeInTheDocument()
    fireEvent.click(result.getByRole('button', { name: 'JSON', exact: true }))
    expect(result.getByRole('textbox', { name: 'Graph draft' })).toHaveValue(JSON.stringify({ value: [{ subject: 'A', predicate: 'knows', object: 'B' }] }, null, 2))
  })
})
