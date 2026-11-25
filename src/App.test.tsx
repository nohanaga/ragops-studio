// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import App from './App'
import { AppProvider } from './contexts'

vi.mock('./components/builders/KnowledgeGraphPlayground', () => ({
  KnowledgeGraphPlayground: () => <h2>Playground content</h2>,
}))
vi.mock('./components/builders/OntologyEditor', () => ({
  OntologyEditor: () => <h2>Ontology content</h2>,
}))

afterEach(cleanup)

it('shows only the active graph tool, and restores ordinary results when returning to the results tab', async () => {
  render(<AppProvider><App /></AppProvider>)
  await screen.findByTitle('First Experiment (auto-created)')
  const banner = within(await screen.findByRole('banner'))
  const latest = screen.getByRole('button', { name: /\(latest\)/ })
  const compareButton = { name: /Compare as table|表で比較/ }
  fireEvent.click(latest)
  expect(screen.getByRole('button', compareButton)).toBeVisible()

  fireEvent.click(banner.getByRole('button', { name: 'Knowledge Graph Playground' }))
  expect(await screen.findByRole('heading', { name: 'Playground content' })).toBeVisible()
  expect(screen.queryByRole('button', compareButton)).not.toBeInTheDocument()

  fireEvent.click(banner.getByRole('button', { name: 'Ontology Editor' }))
  expect(await screen.findByRole('heading', { name: 'Ontology content' })).toBeVisible()
  expect(screen.queryByRole('heading', { name: 'Playground content' })).not.toBeInTheDocument()
  expect(screen.queryByRole('button', compareButton)).not.toBeInTheDocument()

  fireEvent.click(latest)
  expect(screen.getByRole('button', compareButton)).toBeVisible()
})
