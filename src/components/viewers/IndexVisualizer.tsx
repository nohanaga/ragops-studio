/**
 * Index Cluster Visualizer – Phase 1 & Phase 2
 *
 * Phase 1: Scan vectors → cluster → PCA → scatter plot
 * Phase 2: LLM cluster summarization → meta-index generation → 2-stage search
 */

import { useEffect, useRef, useMemo, useState, useCallback, type ChangeEvent } from 'react'
import type { ConnectionProfile, SearchApiVersion } from '../../lib/model'
import { translations, type Language } from '../../lib/translations'
import { useIndexVisualization, type ScannedDoc, type VisualizationData } from '../../hooks/useIndexVisualization'
import type { ReductionMethod } from '../../lib/dimensionReduction'
import { useMetaIndex } from '../../hooks/useMetaIndex'
import { type JsonValue } from '../../lib/aiSearchRest'
import type { ClusterSummary, ClusterSummaryMode, MetaClusterTrace } from '../../lib/metaIndex'
import type { ClusterEdge, ClusterGraphData, EdgeConfidence, EdgeReason } from '../../lib/clusterGraph'
import { rebuildClusterGraphFromMeta } from '../../lib/clusterGraph'
import type { SharedLlmConfig } from '../../hooks/useSharedLlmConfig'
import { LlmProfileSelector } from '../builders/LlmProfileSelector'
import { TipsBlock } from '../builders/TipsBlock'
import { IvPipelineFlow } from './IvPipelineFlow'
import {
  buildSnapshot,
  restoreFromSnapshot,
  exportSnapshotToFile,
  importSnapshotFromFile,
} from '../../app/persistedVisualization'

type TranslationKey = keyof typeof translations.ja

export type IndexVisualizerProps = {
  profile: ConnectionProfile | null
  apiVersion: SearchApiVersion
  indexName: string
  language: Language
  availableIndexNames: string[]
  sharedLlm: SharedLlmConfig
  onOpenLlmSettings: () => void
  openIndexInspector: (name?: string) => void
}

const CLUSTER_COLORS = [
  '#4e79a7', '#f28e2b', '#e15759', '#76b7b2', '#59a14f',
  '#edc948', '#b07aa1', '#ff9da7', '#9c755f', '#bab0ac',
  '#86bcb6', '#8cd17d', '#b6992d', '#499894', '#d37295',
  '#a0cbe8', '#ffbe7d', '#ff9888', '#89d4cf', '#8dca6b',
]

/** Parse hex color to [r, g, b]. */
function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '')
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)]
}

/** Interpolate a single channel towards white (lighten) or black (darken). */
function adjustChannel(c: number, factor: number): number {
  // factor > 0 → lighten, factor < 0 → darken
  if (factor >= 0) return Math.round(c + (255 - c) * factor)
  return Math.round(c * (1 + factor))
}

/**
 * Map a normalized value t in [0, 1] to a heat color.
 * Gradient: deep blue → cyan → green → yellow → red.
 */
function heatColor(t: number): string {
  const x = Math.max(0, Math.min(1, t))
  // 5 stops
  const stops: [number, [number, number, number]][] = [
    [0.0, [44, 90, 160]],   // deep blue
    [0.25, [0, 170, 255]],  // cyan
    [0.5, [0, 200, 120]],   // green
    [0.75, [255, 221, 0]],  // yellow
    [1.0, [255, 68, 68]],   // red
  ]
  for (let i = 1; i < stops.length; i++) {
    if (x <= stops[i][0]) {
      const [t0, c0] = stops[i - 1]
      const [t1, c1] = stops[i]
      const k = (x - t0) / (t1 - t0)
      const r = Math.round(c0[0] + (c1[0] - c0[0]) * k)
      const g = Math.round(c0[1] + (c1[1] - c0[1]) * k)
      const b = Math.round(c0[2] + (c1[2] - c0[2]) * k)
      return `rgb(${r},${g},${b})`
    }
  }
  return 'rgb(255,68,68)'
}

/** Generate `count` shade variants from a base hex color. */
function generateShades(baseHex: string, count: number): string[] {
  if (count <= 1) return [baseHex]
  const [r, g, b] = hexToRgb(baseHex)
  const shades: string[] = []
  for (let i = 0; i < count; i++) {
    // Range from -0.3 (darker) to +0.4 (lighter), centered around the base
    const factor = count === 1 ? 0 : -0.3 + (0.7 * i) / (count - 1)
    const nr = adjustChannel(r, factor)
    const ng = adjustChannel(g, factor)
    const nb = adjustChannel(b, factor)
    shades.push(`#${nr.toString(16).padStart(2, '0')}${ng.toString(16).padStart(2, '0')}${nb.toString(16).padStart(2, '0')}`)
  }
  return shades
}

function t(lang: Language, key: TranslationKey): string {
  return String((translations[lang] as Record<string, string>)[key] ?? (translations.en as Record<string, string>)[key] ?? key)
}

export function IndexVisualizer({
  profile,
  apiVersion,
  indexName: appIndexName,
  language,
  availableIndexNames,
  sharedLlm,
  onOpenLlmSettings,
  openIndexInspector,
}: IndexVisualizerProps) {
  const [selectedLlmProfileId, setSelectedLlmProfileId] = useState<string>('')
  const vis = useIndexVisualization({ profile, apiVersion, language })
  const meta = useMetaIndex({ profile, apiVersion, language, llmConfig: sharedLlm.resolve(selectedLlmProfileId) })

  // ─── New state for save/load, highlight, browse ───────────────────────────
  const [highlightedCluster, setHighlightedCluster] = useState<number | null>(null)
  const [browseClusterId, setBrowseClusterId] = useState<number | null>(null)
  const [browseClusterPage, setBrowseClusterPage] = useState(0)
  const [saveLoadMessage, setSaveLoadMessage] = useState<string | null>(null)
  const [metaAction, setMetaAction] = useState<'overwrite' | 'create-new'>('overwrite')
  const [summaryMode, setSummaryMode] = useState<ClusterSummaryMode>('v1')
  const [metaContentFields, setMetaContentFields] = useState('')
  const [dataSourceLabel, setDataSourceLabel] = useState<{ type: 'file'; name: string } | null>(null)
  const [traceClusterId, setTraceClusterId] = useState<number | null>(null)
  const [rebuiltGraph, setRebuiltGraph] = useState<ClusterGraphData | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  /** Export current visualization to a .ragvis.json file. */
  const handleExportFile = useCallback(() => {
    if (!vis.data) return
    const snapshot = buildSnapshot({
      indexName: vis.selectedIndex,
      vectorField: vis.selectedVectorField,
      settings: {
        k: vis.k,
        microK: vis.microK,
        maxDocs: vis.maxDocs,
        enableHierarchical: vis.enableHierarchical,
        enableGraph: vis.enableGraph,
        graphEdgeThreshold: vis.graphEdgeThreshold,
        reductionMethod: vis.reductionMethod,
        enableAdaptiveSampling: vis.enableAdaptiveSampling,
      },
      data: vis.data,
      clusterSummaries: meta.clusterSummaries,
    })
    exportSnapshotToFile(snapshot)
  }, [vis.data, vis.selectedIndex, vis.selectedVectorField, vis.k, vis.microK, vis.maxDocs, vis.enableHierarchical, vis.enableGraph, vis.graphEdgeThreshold, vis.reductionMethod, vis.enableAdaptiveSampling, meta.clusterSummaries])

  /** Import visualization from a file. */
  const handleImportFile = useCallback(async (file: File) => {
    const snapshot = await importSnapshotFromFile(file)
    if (!snapshot) {
      setSaveLoadMessage(t(language, 'ivLoadError'))
      setTimeout(() => setSaveLoadMessage(null), 3000)
      return
    }
    const restored = restoreFromSnapshot(snapshot)
    vis.restoreData(restored.data)
    if (restored.clusterSummaries) {
      meta.restoreSummaries(restored.clusterSummaries)
    }
    setDataSourceLabel({ type: 'file', name: file.name })
    setSaveLoadMessage(t(language, 'ivLoadSuccess'))
    setTimeout(() => setSaveLoadMessage(null), 3000)
  }, [vis, meta, language])

  // Sync index name from app when component first opens
  useEffect(() => {
    if (appIndexName && !vis.selectedIndex) {
      vis.setSelectedIndex(appIndexName)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Load vector fields when selected index changes
  useEffect(() => {
    if (vis.selectedIndex) {
      vis.loadVectorFields(vis.selectedIndex)
      meta.checkExists(vis.selectedIndex)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vis.selectedIndex])

  const isRunning = vis.phase === 'detecting' || vis.phase === 'scanning' || vis.phase === 'clustering' || vis.phase === 'graphing' || vis.phase === 'projecting'
  const canRun = !!profile && !!vis.selectedIndex && !!vis.selectedVectorField && !isRunning
  const isMetaRunning = meta.metaPhase !== 'idle' && meta.metaPhase !== 'done' && meta.metaPhase !== 'error'

  // Can generate meta-index only if Phase 1 is done
  const canGenerateMeta = vis.data && vis.phase === 'done' && !isMetaRunning
  const vectorDims = vis.vectorFields.find((f) => f.name === vis.selectedVectorField)?.dimensions ?? 0

  return (
    <div className="pane__centerContent">
      <div className="section">
        <div className="section__title">
          <i className="bi bi-diagram-3 icon--mr6" />
          {t(language, 'indexVisualizer')}
        </div>
        <div className="app__hint">{t(language, 'ivDescription')}</div>

        {/* Settings panel */}
        <div className="form" data-guide-target="iv-settings">
          {/* Index selection */}
          <div className="field">
            <span className="field__label">{t(language, 'ivIndexLabel')}</span>
            <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
              {availableIndexNames.length > 0 ? (
                <select
                  className="field__input"
                  value={vis.selectedIndex}
                  onChange={(e: ChangeEvent<HTMLSelectElement>) => vis.setSelectedIndex(e.target.value)}
                  disabled={isRunning}
                  style={{ flex: 1 }}
                >
                  <option value="">--</option>
                  {availableIndexNames.map((name) => (
                    <option key={name} value={name}>{name}</option>
                  ))}
                </select>
              ) : (
                <input
                  className="field__input"
                  value={vis.selectedIndex}
                  onChange={(e) => vis.setSelectedIndex(e.target.value)}
                  disabled={isRunning}
                  style={{ flex: 1 }}
                />
              )}
              <button
                type="button"
                className="btn btn--xs"
                onClick={() => openIndexInspector(vis.selectedIndex)}
                disabled={!profile || !vis.selectedIndex.trim()}
                title={t(language, 'indexInspector')}
              >
                <i className="bi bi-eye" />
              </button>
            </div>
          </div>

          {/* Vector field selection */}
          <label className="field">
            <span className="field__label">{t(language, 'ivVectorFieldLabel')}</span>
            <select
              className="field__input"
              value={vis.selectedVectorField}
              onChange={(e: ChangeEvent<HTMLSelectElement>) => vis.setSelectedVectorField(e.target.value)}
              disabled={isRunning || vis.vectorFields.length === 0}
            >
              {vis.vectorFields.length === 0 && (
                <option value="">{t(language, 'ivNoVectorFields')}</option>
              )}
              {vis.vectorFields.map((f) => (
                <option key={f.name} value={f.name}>
                  {f.name} ({f.dimensions}d)
                </option>
              ))}
            </select>
          </label>

          {/* K value */}
          <label className="field">
            <span className="field__label">{t(language, 'ivClusterCount')}</span>
            <input
              className="field__input"
              type="number"
              min={2}
              max={30}
              value={vis.k}
              onChange={(e) => vis.setK(Math.max(2, Math.min(30, parseInt(e.target.value) || 2)))}
              disabled={isRunning}
            />
          </label>

          {/* Max documents */}
          <label className="field">
            <span className="field__label">{t(language, 'ivMaxDocs')}</span>
            <input
              className="field__input"
              type="number"
              min={50}
              max={10000}
              step={50}
              value={vis.maxDocs}
              onChange={(e) => vis.setMaxDocs(Math.max(50, Math.min(10000, parseInt(e.target.value) || 500)))}
              disabled={isRunning}
            />
          </label>

          {/* Reduction method */}
          <label className="field">
            <span className="field__label">{t(language, 'ivReductionMethodLabel')}</span>
            <select
              className="field__input"
              value={vis.reductionMethod}
              onChange={(e) => vis.setReductionMethod(e.target.value as ReductionMethod)}
              disabled={isRunning}
            >
              <option value="pca">{t(language, 'ivReductionPCA')}</option>
              <option value="umap">{t(language, 'ivReductionUMAP')}</option>
              <option value="tsne">{t(language, 'ivReductionTSNE')}</option>
              <option value="pca-umap">{t(language, 'ivReductionPCAUMAP')}</option>
            </select>
          </label>
        </div>

        {/* Option checkboxes — stacked vertically, left-aligned */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', marginTop: '10px' }}>
          {/* Adaptive Sampling toggle */}
          <div className="field">
            <label className="field__label edgCheckboxLabel">
              <input
                type="checkbox"
                checked={vis.enableAdaptiveSampling}
                onChange={(e) => vis.setEnableAdaptiveSampling(e.target.checked)}
                disabled={isRunning}
              />{' '}
              {t(language, 'ivAdaptiveSamplingLabel')}
            </label>
            <div className="field__hint">{t(language, 'ivAdaptiveSamplingHint')}</div>
            {vis.indexStructure && (
              <div
                className={vis.indexStructure.type === 'unknown' ? 'notice notice--warning' : 'field__hint'}
                style={{ marginTop: '4px' }}
              >
                {vis.indexStructure.type === 'chunked'
                  ? t(language, 'ivStructureChunked')
                      .replace('{field}', vis.indexStructure.parentField ?? '')
                      .replace('{count}', String(vis.indexStructure.parentCount ?? 0))
                  : vis.indexStructure.type === 'independent'
                    ? t(language, 'ivStructureIndependent').replace('{count}', String(vis.indexStructure.documentCount))
                    : `⚠️ ${t(language, 'ivStructureUnknown')}`}
              </div>
            )}
          </div>

          {/* Hierarchical Clustering toggle + Micro K */}
          <div className="field">
            <label className="field__label edgCheckboxLabel">
              <input
                type="checkbox"
                checked={vis.enableHierarchical}
                onChange={(e) => vis.setEnableHierarchical(e.target.checked)}
                disabled={isRunning}
              />{' '}
              {t(language, 'ivHierarchicalLabel')}
            </label>
            <div className="field__hint">{t(language, 'ivHierarchicalHint')}</div>
            {vis.enableHierarchical && (
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginTop: '8px' }}>
                <span className="field__label" style={{ marginBottom: 0, whiteSpace: 'nowrap' }}>
                  {t(language, 'ivMicroKLabel')}
                </span>
                <input
                  className="field__input"
                  type="number"
                  min={2}
                  max={10}
                  style={{ width: '80px' }}
                  value={vis.microK}
                  onChange={(e) => vis.setMicroK(Math.max(2, Math.min(10, parseInt(e.target.value) || 3)))}
                  disabled={isRunning}
                />
                <span className="field__hint" style={{ margin: 0 }}>
                  {t(language, 'ivMicroKHint')}
                </span>
              </div>
            )}
          </div>

          {/* Graph Structure toggle + Edge Threshold */}
          <div className="field">
            <label className="field__label edgCheckboxLabel">
              <input
                type="checkbox"
                checked={vis.enableGraph}
                onChange={(e) => vis.setEnableGraph(e.target.checked)}
                disabled={isRunning}
              />{' '}
              {t(language, 'ivGraphLabel')}
            </label>
            <div className="field__hint">{t(language, 'ivGraphHint')}</div>
            {vis.enableGraph && (
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginTop: '8px' }}>
                <span className="field__label" style={{ marginBottom: 0, whiteSpace: 'nowrap' }}>
                  {t(language, 'ivGraphThresholdLabel')}
                </span>
                <input
                  className="field__input"
                  type="number"
                  min={0.1}
                  max={0.95}
                  step={0.05}
                  style={{ width: '80px' }}
                  value={vis.graphEdgeThreshold}
                  onChange={(e) => vis.setGraphEdgeThreshold(Math.max(0.1, Math.min(0.95, parseFloat(e.target.value) || 0.5)))}
                  disabled={isRunning}
                />
                <span className="field__hint" style={{ margin: 0 }}>
                  {t(language, 'ivGraphThresholdHint')}
                </span>
              </div>
            )}
          </div>
        </div>

        {/* Action buttons */}
        <div className="actions" style={{ marginTop: '12px' }} data-guide-target="iv-run">
          <button
            type="button"
            className="btn btn--primary"
            onClick={() => { setDataSourceLabel(null); vis.run() }}
            disabled={!canRun}
          >
            <i className="bi bi-play-fill icon--mr6" />
            {t(language, 'ivRunButton')}
          </button>
          {isRunning && (
            <button
              type="button"
              className="btn btn--secondary"
              onClick={vis.cancel}
            >
              {t(language, 'ivCancelButton')}
            </button>
          )}
          {(vis.data || meta.clusterSummaries) && !isRunning && (
            <button
              type="button"
              className="btn btn--secondary"
              onClick={() => {
                vis.clearData()
                meta.clearAll()
                setDataSourceLabel(null)
                setBrowseClusterId(null)
                setBrowseClusterPage(0)
                setHighlightedCluster(null)
              }}
            >
              <i className="bi bi-x-circle icon--mr6" />
              {t(language, 'ivClearButton')}
            </button>
          )}
        </div>

        {/* Progress */}
        {isRunning && (
          <div className="app__hint" style={{ marginTop: '8px' }}>
            {vis.phase === 'detecting' && t(language, 'ivPhaseDetecting')}
            {vis.phase === 'scanning' && (
              <>
                {t(language, 'ivPhaseScanning')} ({vis.progress}/{vis.progressTotal})
                <div className="progress" style={{ marginTop: '4px', height: '6px' }}>
                  <div
                    className="progress-bar"
                    role="progressbar"
                    style={{ width: `${vis.progressTotal > 0 ? (vis.progress / vis.progressTotal) * 100 : 0}%` }}
                  />
                </div>
              </>
            )}
            {vis.phase === 'clustering' && t(language, 'ivPhaseClustering')}
            {vis.phase === 'graphing' && t(language, 'ivPhaseGraphing')}
            {vis.phase === 'projecting' && t(language, 'ivPhaseProjecting')}
          </div>
        )}

        {/* Error */}
        {vis.error && (
          <div className="notice notice--error" style={{ marginTop: '8px' }}>
            {vis.error}
          </div>
        )}
      </div>

      {/* Data source indicator */}
      {vis.data && vis.phase === 'done' && dataSourceLabel && (
        <div style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: '6px',
          padding: '4px 12px',
          marginTop: '12px',
          background: 'var(--panel2)',
          borderRadius: '6px',
          fontSize: '12px',
          border: '1px solid var(--border)',
        }}>
          <i className="bi bi-file-earmark-arrow-up" style={{ opacity: 0.7 }} />
          <span>
            {t(language, 'ivDataSourceFile').replace('{name}', dataSourceLabel.name)}
          </span>
          <button
            type="button"
            style={{
              background: 'none',
              border: 'none',
              padding: '0 2px',
              cursor: 'pointer',
              opacity: 0.5,
              fontSize: '14px',
              color: 'inherit',
            }}
            onClick={() => setDataSourceLabel(null)}
            title="×"
          >
            ×
          </button>
        </div>
      )}

      {/* Scatter plot */}
      {vis.data && vis.phase === 'done' && (
        <ScatterPlot
          data={vis.data}
          language={language}
          clusterSummariesFromMeta={meta.clusterSummaries}
          highlightedCluster={highlightedCluster}
          onClusterHover={setHighlightedCluster}
          onBrowseCluster={(id) => { setBrowseClusterId(id); setBrowseClusterPage(0) }}
        />
      )}

      {/* Phase 4: Cluster relationship graph */}
      {vis.data && vis.phase === 'done' && vis.data.graph && (
        <ClusterGraphView
          graph={vis.data.graph}
          data={vis.data}
          language={language}
          clusterSummariesFromMeta={meta.clusterSummaries}
          onBrowseCluster={(id) => { setBrowseClusterId(id); setBrowseClusterPage(0) }}
        />
      )}

      {/* Rebuilt graph from meta-index (shown when no scan data) */}
      {!vis.data?.graph && rebuiltGraph && (
        <ClusterGraphView
          graph={rebuiltGraph}
          data={vis.data}
          language={language}
          clusterSummariesFromMeta={meta.clusterSummaries}
          onBrowseCluster={(id) => { setBrowseClusterId(id); setBrowseClusterPage(0) }}
        />
      )}

      {/* ================================================================ */}
      {/* Save / Load Visualization */}
      {/* ================================================================ */}
      <div className="section" style={{ marginTop: '24px' }}>
        <div className="section__title">
          <i className="bi bi-floppy icon--mr6" />
          {t(language, 'ivSaveTitle')}
        </div>

        <div className="actions" style={{ marginTop: '8px' }}>
          <button type="button" className="btn btn--primary" onClick={handleExportFile} disabled={!vis.data}>
            <i className="bi bi-download icon--mr6" />
            {t(language, 'ivSaveAsFileButton')}
          </button>
          <button type="button" className="btn btn--secondary" onClick={() => fileInputRef.current?.click()}>
            <i className="bi bi-upload icon--mr6" />
            {t(language, 'ivLoadFromFileButton')}
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept=".ragvis.json,.json"
            style={{ display: 'none' }}
            onChange={(e) => {
              const file = e.target.files?.[0]
              if (file) handleImportFile(file)
              e.target.value = ''
            }}
          />
        </div>

        {saveLoadMessage && (
          <div className="notice notice--success" style={{ marginTop: '6px' }}>
            {saveLoadMessage}
          </div>
        )}
      </div>

      {/* ================================================================ */}
      {/* Cluster Document Browser */}
      {/* ================================================================ */}
      {browseClusterId !== null && (
        <ClusterDocBrowser
          data={vis.data ?? null}
          clusterId={browseClusterId}
          page={browseClusterPage}
          onPageChange={setBrowseClusterPage}
          onClose={() => { setBrowseClusterId(null); setBrowseClusterPage(0) }}
          language={language}
          clusterSummariesFromMeta={meta.clusterSummaries}
          titleFieldName={vis.titleFieldName}
        />
      )}

      {/* Meta Cluster Trace Modal */}
      {traceClusterId !== null && meta.metaTraces[traceClusterId] && (
        <MetaTraceModal
          trace={meta.metaTraces[traceClusterId]}
          language={language}
          onClose={() => setTraceClusterId(null)}
        />
      )}

      {/* ================================================================ */}
      {/* Phase 2: Meta-Index Generation */}
      {/* ================================================================ */}
      <div className="section" style={{ marginTop: '24px' }} data-guide-target="iv-meta">
        <div className="section__title">
          <i className="bi bi-database-add icon--mr6" />
          {t(language, 'ivMetaTitle')}
        </div>
        <div className="app__hint">{t(language, 'ivMetaDescription')}</div>

        {/* Meta-index status */}
        {meta.metaIndexExists !== null && (
          <div className="app__hint" style={{ marginTop: '6px', fontStyle: 'italic' }}>
            {meta.metaIndexExists
              ? `✅ ${t(language, 'ivMetaExists').replace('{name}', meta.metaIndexName ?? '')}`
              : `⬜ ${t(language, 'ivMetaNotExists')}`}
          </div>
        )}

        {/* LLM Settings */}
        <div style={{ marginTop: '12px' }}>
          <div className="section__subtitle" style={{ marginBottom: '6px' }}>
            <i className="bi bi-robot icon--mr6" />
            {t(language, 'ivMetaLlmTitle')}
          </div>
          <LlmProfileSelector
            sharedLlm={sharedLlm}
            selectedProfileId={selectedLlmProfileId}
            onSelect={setSelectedLlmProfileId}
            t={(key) => t(language, key)}
            language={language}
            disabled={isMetaRunning}
            onOpenSettings={onOpenLlmSettings}
            modelType="chat"
          />
        </div>

        {/* Summary Mode */}
        <div style={{ marginTop: '12px' }}>
          <div className="section__subtitle" style={{ marginBottom: '4px' }}>
            {t(language, 'ivMetaSummaryModeTitle')}
          </div>
          <div style={{ display: 'grid', gap: '6px', fontSize: '13px' }}>
            <label style={{ display: 'flex', alignItems: 'flex-start', gap: '6px', cursor: isMetaRunning ? 'default' : 'pointer' }}>
              <input
                type="radio"
                name="summaryMode"
                checked={summaryMode === 'v1'}
                onChange={() => setSummaryMode('v1')}
                disabled={isMetaRunning}
              />
              <span>
                <strong>{t(language, 'ivMetaSummaryModeV1')}</strong>
                <span style={{ display: 'block', opacity: 0.7 }}>{t(language, 'ivMetaSummaryModeV1Hint')}</span>
              </span>
            </label>
            <label style={{ display: 'flex', alignItems: 'flex-start', gap: '6px', cursor: isMetaRunning ? 'default' : 'pointer' }}>
              <input
                type="radio"
                name="summaryMode"
                checked={summaryMode === 'v2'}
                onChange={() => setSummaryMode('v2')}
                disabled={isMetaRunning}
              />
              <span>
                <strong>{t(language, 'ivMetaSummaryModeV2')}</strong>
                <span style={{ display: 'block', opacity: 0.7 }}>{t(language, 'ivMetaSummaryModeV2Hint')}</span>
              </span>
            </label>
          </div>
        </div>

        {/* Meta-index action choice when it already exists */}
        {meta.metaIndexExists && !isMetaRunning && (
          <div style={{ marginTop: '12px' }}>
            <div className="section__subtitle" style={{ marginBottom: '4px' }}>
              {t(language, 'ivMetaOverwriteTitle')}
            </div>
            <div style={{ display: 'flex', gap: '16px', fontSize: '13px' }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: '4px', cursor: 'pointer' }}>
                <input
                  type="radio"
                  name="metaAction"
                  checked={metaAction === 'overwrite'}
                  onChange={() => setMetaAction('overwrite')}
                />
                {t(language, 'ivMetaOverwriteOption')}
              </label>
              <label style={{ display: 'flex', alignItems: 'center', gap: '4px', cursor: 'pointer' }}>
                <input
                  type="radio"
                  name="metaAction"
                  checked={metaAction === 'create-new'}
                  onChange={() => setMetaAction('create-new')}
                />
                {t(language, 'ivMetaCreateNewOption')}
              </label>
            </div>
          </div>
        )}

        {/* Content Fields */}
        <div style={{ marginTop: '12px' }}>
          <label className="field" style={{ marginBottom: 0 }}>
            <span className="field__label">{t(language, 'ivMetaContentFieldsLabel')}</span>
            <input
              className="field__input"
              value={metaContentFields}
              onChange={(e) => setMetaContentFields(e.target.value)}
              placeholder={t(language, 'ivMetaContentFieldsPlaceholder')}
              disabled={isMetaRunning}
            />
            <span className="field__hint">{t(language, 'ivMetaContentFieldsHint')}</span>
          </label>
        </div>

        {/* Actions */}
        <div className="actions" style={{ marginTop: '12px' }}>
          <button
            type="button"
            className="btn btn--primary"
            onClick={() => {
              if (!vis.data) return
              const fields = metaContentFields.split(',').map((s) => s.trim()).filter(Boolean)
              meta.generateMetaIndex(
                vis.selectedIndex,
                vis.selectedVectorField,
                vectorDims,
                vis.data.docs,
                vis.data.cluster,
                fields.length > 0 ? fields : undefined,
                summaryMode,
              )
            }}
            disabled={!canGenerateMeta}
            title={!vis.data ? t(language, 'ivRequireClusterFirst') : ''}
          >
            <i className="bi bi-gear-fill icon--mr6" />
            {meta.metaIndexExists && metaAction === 'overwrite'
              ? t(language, 'ivMetaOverwriteOption')
              : t(language, 'ivMetaGenerateButton')}
          </button>
          <button
            type="button"
            className="btn btn--secondary"
            onClick={() => meta.loadExisting(vis.selectedIndex)}
            disabled={isMetaRunning || !vis.selectedIndex}
            title={t(language, 'ivMetaLoadOption')}
          >
            <i className="bi bi-arrow-repeat icon--mr6" />
            {t(language, 'ivMetaLoadOption')}
          </button>
          {meta.clusterSummaries && meta.clusterSummaries.length > 0 && meta.clusterSummaries[0].centroidVector?.length > 0 && (
            <button
              type="button"
              className="btn btn--secondary"
              onClick={() => {
                const g = rebuildClusterGraphFromMeta(meta.clusterSummaries!, vis.graphEdgeThreshold)
                setRebuiltGraph(g)
              }}
              disabled={isMetaRunning}
              title={t(language, 'ivGraphRebuildHint')}
            >
              <i className="bi bi-diagram-2 icon--mr6" />
              {t(language, 'ivGraphRebuild')}
            </button>
          )}
          {meta.metaIndexExists && (
            <button
              type="button"
              className="btn btn--danger-text"
              onClick={() => {
                if (!window.confirm(t(language, 'ivMetaDeleteConfirm'))) return
                meta.deleteMeta(vis.selectedIndex)
              }}
              disabled={isMetaRunning}
            >
              <i className="bi bi-trash icon--mr6" />
              {t(language, 'ivMetaDeleteButton')}
            </button>
          )}
          {isMetaRunning && (
            <button
              type="button"
              className="btn btn--secondary"
              onClick={meta.cancel}
            >
              {t(language, 'ivCancelButton')}
            </button>
          )}
        </div>

        {/* Meta progress */}
        {isMetaRunning && (
          <div className="app__hint" style={{ marginTop: '8px' }}>
            {meta.metaPhase === 'fetching-texts' && t(language, 'ivMetaPhaseFetching')}
            {meta.metaPhase === 'summarizing' && (
              <>
                {t(language, 'ivMetaPhaseSummarizing')
                  .replace('{current}', String(meta.summarizeProgress.current))
                  .replace('{total}', String(meta.summarizeProgress.total))}
                {meta.summarizeProgress.currentLabel && (
                  <span style={{ marginLeft: '8px', opacity: 0.7 }}>
                    — {meta.summarizeProgress.currentLabel}
                  </span>
                )}
                <div className="progress" style={{ marginTop: '4px', height: '6px' }}>
                  <div
                    className="progress-bar"
                    role="progressbar"
                    style={{
                      width: `${meta.summarizeProgress.total > 0
                        ? (meta.summarizeProgress.current / meta.summarizeProgress.total) * 100
                        : 0}%`,
                    }}
                  />
                </div>
              </>
            )}
            {meta.metaPhase === 'creating-index' && t(language, 'ivMetaPhaseCreating')}
            {meta.metaPhase === 'uploading' && t(language, 'ivMetaPhaseUploading')}
          </div>
        )}
        {meta.metaPhase === 'done' && !meta.metaWarning && (
          <div className="notice notice--success" style={{ marginTop: '8px' }}>
            ✅ {t(language, 'ivMetaPhaseDone')}
            {meta.metaTokenUsage.total > 0 && (
              <span style={{ marginLeft: '8px', fontSize: '11px', opacity: 0.7 }}>
                (input: {meta.metaTokenUsage.prompt.toLocaleString()} / output: {meta.metaTokenUsage.completion.toLocaleString()} tokens)
              </span>
            )}
          </div>
        )}
        {meta.metaPhase === 'done' && meta.metaWarning && (
          <div className="notice notice--warning" style={{ marginTop: '8px', whiteSpace: 'pre-wrap' }}>
            {meta.metaWarning}
          </div>
        )}
        {meta.metaError && (
          <div className="notice notice--error" style={{ marginTop: '8px' }}>
            {meta.metaError}
          </div>
        )}

        {/* Cluster summaries preview */}
        {meta.clusterSummaries && (
          <div style={{ marginTop: '12px' }}>
            <div className="section__subtitle" style={{ marginBottom: '6px' }}>
              {t(language, 'ivClusterLegend')} (LLM)
              <span style={{ marginLeft: '12px', fontSize: '11px', opacity: 0.5, fontWeight: 400 }}>
                {t(language, 'ivHighlightHint')}
              </span>
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
              {meta.clusterSummaries.map((cs, idx) => (
                <div
                  key={cs.clusterId}
                  style={{
                    background: highlightedCluster === idx ? 'var(--panel3, var(--panel2))' : 'var(--panel2)',
                    borderRadius: '8px',
                    padding: '8px 12px',
                    minWidth: '200px',
                    flex: '1 1 220px',
                    maxWidth: '320px',
                    borderLeft: `3px solid ${CLUSTER_COLORS[idx % CLUSTER_COLORS.length]}`,
                    outline: highlightedCluster === idx ? `2px solid ${CLUSTER_COLORS[idx % CLUSTER_COLORS.length]}` : 'none',
                    transition: 'outline 0.15s, background 0.15s',
                  }}
                  onMouseEnter={() => setHighlightedCluster(idx)}
                  onMouseLeave={() => setHighlightedCluster(null)}
                >
                  <div style={{ fontWeight: 600, marginBottom: '2px' }}>
                    <span style={{ color: CLUSTER_COLORS[idx % CLUSTER_COLORS.length], marginRight: '6px' }}>●</span>
                    {cs.label}
                    {cs.summaryVersion === 'v2' && (
                      <span style={{ marginLeft: '6px', fontSize: '10px', opacity: 0.65 }}>
                        EFLC v2
                      </span>
                    )}
                    <span style={{ fontWeight: 400, marginLeft: '8px', opacity: 0.7 }}>
                      ({cs.documentCount} docs)
                    </span>
                  </div>
                  <div style={{ fontSize: '12px', opacity: 0.8, marginBottom: '4px' }}>
                    {cs.summary}
                  </div>
                  {cs.keywords.length > 0 && (
                    <div style={{ fontSize: '11px', opacity: 0.6 }}>
                      {cs.keywords.join(', ')}
                    </div>
                  )}
                  {cs.facetLabels && cs.facetLabels.length > 0 && (
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px', marginTop: '6px' }}>
                      {cs.facetLabels.slice(0, 5).map((facet) => (
                        <span
                          key={facet}
                          style={{
                            border: '1px solid var(--border, rgba(128,128,128,.3))',
                            borderRadius: '999px',
                            padding: '1px 6px',
                            fontSize: '10px',
                            opacity: 0.78,
                          }}
                        >
                          {facet}
                        </span>
                      ))}
                    </div>
                  )}
                  {cs.inclusionCriteria && cs.inclusionCriteria.length > 0 && (
                    <div style={{ fontSize: '11px', opacity: 0.65, marginTop: '5px' }}>
                      {t(language, 'ivMetaInclusionCriteria')}: {cs.inclusionCriteria.slice(0, 2).join(' / ')}
                    </div>
                  )}
                  {cs.memberDocIds && cs.memberDocIds.length > 0 && (
                    <div style={{ fontSize: '11px', opacity: 0.6, marginTop: '2px' }}>
                      {t(language, 'ivClusterDocsMemberIds')}: {cs.memberDocIds.length}
                    </div>
                  )}
                  {(vis.data || (cs.memberDocIds && cs.memberDocIds.length > 0)) && (
                    <button
                      type="button"
                      className="btn btn--secondary"
                      style={{ marginTop: '6px', padding: '2px 8px', fontSize: '11px' }}
                      onClick={() => { setBrowseClusterId(idx); setBrowseClusterPage(0) }}
                    >
                      <i className="bi bi-list-ul icon--mr6" />
                      {t(language, 'ivClusterDocsBrowse')}
                    </button>
                  )}
                  {meta.metaTraces.length > 0 && meta.metaTraces[idx] && (
                    <button
                      type="button"
                      className="btn btn--secondary"
                      style={{ marginTop: '6px', marginLeft: '4px', padding: '2px 8px', fontSize: '11px' }}
                      onClick={() => setTraceClusterId(idx)}
                    >
                      <i className="bi bi-bug icon--mr6" />
                      Trace
                    </button>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* ================================================================ */}
      {/* Phase 2: 2-Stage Search */}
      {/* ================================================================ */}
      <div className="section" style={{ marginTop: '24px' }} data-guide-target="iv-search">
        <div className="section__title">
          <i className="bi bi-search icon--mr6" />
          {t(language, 'ivSearchTitle')}
        </div>
        <div className="app__hint">{t(language, 'ivSearchDescription')}</div>

        {!meta.metaIndexExists && (
          <div className="app__hint" style={{ marginTop: '8px', fontStyle: 'italic', opacity: 0.7 }}>
            ⚠️ {t(language, 'ivSearchNoMetaIndex')}
          </div>
        )}

        <div className="form" style={{ marginTop: '8px' }}>
          <label className="field">
            <span className="field__label">{t(language, 'ivSearchQueryLabel')}</span>
            <input
              className="field__input"
              value={meta.searchQuery}
              onChange={(e) => meta.setSearchQuery(e.target.value)}
              placeholder={language === 'ja' ? '検索テキストを入力...' : 'Enter search text...'}
              disabled={!meta.metaIndexExists || meta.searchPhase === 'searching'}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && meta.metaIndexExists) meta.executeSearch(vis.selectedIndex)
              }}
            />
          </label>
          <label className="field">
            <span className="field__label">{t(language, 'ivSearchTopClusters')}</span>
            <input
              className="field__input"
              type="number"
              min={1}
              max={10}
              value={meta.topClusters}
              onChange={(e) => meta.setTopClusters(Math.max(1, Math.min(10, parseInt(e.target.value) || 3)))}
              disabled={!meta.metaIndexExists || meta.searchPhase === 'searching'}
            />
          </label>
          <label className="field">
            <span className="field__label">{t(language, 'ivSearchTopDocs')}</span>
            <input
              className="field__input"
              type="number"
              min={1}
              max={50}
              value={meta.topDocs}
              onChange={(e) => meta.setTopDocs(Math.max(1, Math.min(50, parseInt(e.target.value) || 10)))}
              disabled={!meta.metaIndexExists || meta.searchPhase === 'searching'}
            />
          </label>
        </div>

        <div className="actions" style={{ marginTop: '8px' }}>
          <button
            type="button"
            className="btn btn--primary"
            onClick={() => meta.executeSearch(vis.selectedIndex)}
            disabled={!meta.metaIndexExists || !meta.searchQuery.trim() || meta.searchPhase === 'searching'}
          >
            <i className="bi bi-search icon--mr6" />
            {t(language, 'ivSearchButton')}
          </button>
        </div>

        {meta.searchPhase === 'searching' && (
          <div className="app__hint" style={{ marginTop: '8px' }}>
            <i className="bi bi-hourglass-split icon--mr6" />
            Searching...
          </div>
        )}

        {meta.searchError && (
          <div className="notice notice--error" style={{ marginTop: '8px' }}>
            {meta.searchError}
          </div>
        )}

        {/* Search results */}
        {meta.searchResult && (
          <TwoStageSearchResults result={meta.searchResult} language={language} />
        )}
      </div>

      {/* ================================================================ */}
      {/* Tips: theory / technology / known limitations */}
      {/* ================================================================ */}
      <div className="section">
        <details>
          <summary className="section__title" style={{ cursor: 'pointer' }}>
            <i className="bi bi-info-circle icon--mr6"></i>
            {t(language, 'ivTipsTitle')}
          </summary>
          <div className="edgTips">
            <div className="edgTips__lead">
              <TipsBlock text={String(t(language, 'ivTipsLead'))} />
            </div>

            <div className="edgTips__group">
              <div className="edgTips__groupTitle">{t(language, 'ivTipsWhatItDoesH')}</div>
              <IvPipelineFlow language={language} />
            </div>

            <div className="edgTips__group">
              <div className="edgTips__groupTitle">{t(language, 'ivTipsTechH')}</div>
              <TipsBlock text={String(t(language, 'ivTipsTech'))} />
            </div>

            <div className="edgTips__group">
              <div className="edgTips__groupTitle">{t(language, 'ivTipsTheoryH')}</div>
              <TipsBlock text={String(t(language, 'ivTipsTheory'))} />
            </div>

            <div className="edgTips__group">
              <div className="edgTips__groupTitle">{t(language, 'ivTipsLimitsH')}</div>
              <TipsBlock text={String(t(language, 'ivTipsLimits'))} />
            </div>

            <div className="edgTips__group">
              <div className="edgTips__groupTitle">{t(language, 'ivTipsRecH')}</div>
              <TipsBlock text={String(t(language, 'ivTipsRec'))} />
            </div>
          </div>
        </details>
      </div>
    </div>
  )
}

// ============================================================================
// Scatter Plot (Canvas-based for performance)
// ============================================================================

function ScatterPlot({ data, language, clusterSummariesFromMeta, highlightedCluster, onClusterHover, onBrowseCluster }: {
  data: VisualizationData
  language: Language
  clusterSummariesFromMeta?: ClusterSummary[] | null
  highlightedCluster?: number | null
  onBrowseCluster?: (clusterId: number) => void
  onClusterHover?: (clusterId: number | null) => void
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const tooltipRef = useRef<HTMLDivElement>(null)
  const [viewMode, setViewMode] = useState<'flat' | 'hierarchy'>('flat')

  const { docs, cluster, pca, hierarchical } = data
  const { coords, explainedVariance } = pca
  const hasHierarchical = !!hierarchical

  // Determine which labels to use based on view mode
  const activeLabels = useMemo(() => {
    if (viewMode === 'hierarchy' && hierarchical) return hierarchical.microLabels
    return cluster.labels
  }, [viewMode, hierarchical, cluster.labels])

  // Build a color map: in hierarchy mode, micro clusters share the macro's color family
  const colorOf = useMemo(() => {
    const map = new Map<number, string>()
    if (viewMode === 'hierarchy' && hierarchical) {
      // Group micro IDs by macro
      const macroGroups = new Map<number, number[]>()
      for (let microId = 0; microId < hierarchical.microToMacro.length; microId++) {
        const macroId = hierarchical.microToMacro[microId]
        if (!macroGroups.has(macroId)) macroGroups.set(macroId, [])
        macroGroups.get(macroId)!.push(microId)
      }
      for (const [macroId, microIds] of macroGroups) {
        const baseColor = CLUSTER_COLORS[macroId % CLUSTER_COLORS.length]
        const shades = generateShades(baseColor, microIds.length)
        for (let i = 0; i < microIds.length; i++) {
          map.set(microIds[i], shades[i])
        }
      }
    }
    return (label: number) => map.get(label) ?? CLUSTER_COLORS[label % CLUSTER_COLORS.length]
  }, [viewMode, hierarchical])

  // Pre-compute bounds
  const bounds = useMemo(() => {
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity
    for (const [x, y] of coords) {
      if (x < minX) minX = x
      if (x > maxX) maxX = x
      if (y < minY) minY = y
      if (y > maxY) maxY = y
    }
    const padX = (maxX - minX) * 0.05 || 1
    const padY = (maxY - minY) * 0.05 || 1
    return { minX: minX - padX, maxX: maxX + padX, minY: minY - padY, maxY: maxY + padY }
  }, [coords])

  // Build a lookup from numeric cluster label → LLM-generated name
  const metaLabelMap = useMemo(() => {
    if (!clusterSummariesFromMeta) return null
    const map = new Map<number, string>()

    if (viewMode === 'hierarchy' && hierarchical) {
      // In hierarchy mode: derive micro cluster labels from macro labels
      const macroLabels = new Map<number, string>()
      for (let i = 0; i < clusterSummariesFromMeta.length; i++) {
        macroLabels.set(i, clusterSummariesFromMeta[i].label)
      }
      // Group micro IDs by macro
      const microGroupsPerMacro = new Map<number, number[]>()
      for (let microId = 0; microId < hierarchical.microToMacro.length; microId++) {
        const macroId = hierarchical.microToMacro[microId]
        if (!microGroupsPerMacro.has(macroId)) microGroupsPerMacro.set(macroId, [])
        microGroupsPerMacro.get(macroId)!.push(microId)
      }
      for (const [macroId, microIds] of microGroupsPerMacro) {
        const macroLabel = macroLabels.get(macroId) ?? `Cluster ${macroId}`
        for (let sub = 0; sub < microIds.length; sub++) {
          map.set(microIds[sub], `${macroLabel} / ${sub + 1}`)
        }
      }
    } else {
      // Flat mode: direct macro label mapping
      for (let i = 0; i < clusterSummariesFromMeta.length; i++) {
        map.set(i, clusterSummariesFromMeta[i].label)
      }
    }
    return map
  }, [clusterSummariesFromMeta, hierarchical, viewMode])

  // Cluster summary
  const clusterSummary = useMemo(() => {
    const groups: Map<number, ScannedDoc[]> = new Map()
    for (let i = 0; i < docs.length; i++) {
      const label = activeLabels[i]
      if (!groups.has(label)) groups.set(label, [])
      groups.get(label)!.push(docs[i])
    }
    return Array.from(groups.entries())
      .sort((a, b) => a[0] - b[0])
      .map(([label, members]) => ({
        label,
        displayLabel: metaLabelMap?.get(label)
          ?? (viewMode === 'flat' ? `Cluster ${label}` : `${t(language, 'ivHierarchicalMicro')} ${label}`),
        macroLabel: viewMode === 'hierarchy' && hierarchical
          ? hierarchical.microToMacro[label]
          : undefined,
        count: members.length,
        color: colorOf(label),
        sampleTitles: members.slice(0, 5).map((d) => d.title),
      }))
  }, [docs, activeLabels, metaLabelMap, viewMode, hierarchical, language, colorOf])

  // Draw
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const container = containerRef.current
    if (!container) return

    const dpr = window.devicePixelRatio || 1
    const width = container.clientWidth
    const height = Math.min(width * 0.6, 500)
    canvas.width = width * dpr
    canvas.height = height * dpr
    canvas.style.width = `${width}px`
    canvas.style.height = `${height}px`

    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.scale(dpr, dpr)

    // Clear
    ctx.clearRect(0, 0, width, height)

    // Resolve CSS variables for canvas
    const computedStyle = getComputedStyle(container)
    const textColor = computedStyle.getPropertyValue('--color-text-secondary').trim() || '#888'
    const borderColor = computedStyle.getPropertyValue('--color-border').trim() || '#ccc'

    // Margins
    const ml = 40, mr = 20, mt = 20, mb = 30
    const pw = width - ml - mr
    const ph = height - mt - mb

    // Axes
    ctx.strokeStyle = borderColor
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.moveTo(ml, mt)
    ctx.lineTo(ml, mt + ph)
    ctx.lineTo(ml + pw, mt + ph)
    ctx.stroke()

    // Axis labels
    ctx.fillStyle = textColor
    ctx.font = '11px system-ui, sans-serif'
    ctx.textAlign = 'center'
    const hasVariance = explainedVariance[0] > 0 || explainedVariance[1] > 0
    const xLabel = hasVariance ? `PC1 (${(explainedVariance[0] * 100).toFixed(1)}%)` : 'Dim 1'
    const yLabel = hasVariance ? `PC2 (${(explainedVariance[1] * 100).toFixed(1)}%)` : 'Dim 2'
    ctx.fillText(xLabel, ml + pw / 2, height - 4)
    ctx.save()
    ctx.translate(12, mt + ph / 2)
    ctx.rotate(-Math.PI / 2)
    ctx.fillText(yLabel, 0, 0)
    ctx.restore()

    // Points
    const radius = docs.length > 2000 ? 2 : docs.length > 500 ? 3 : 4
    const { minX, maxX, minY, maxY } = bounds
    const rangeX = maxX - minX
    const rangeY = maxY - minY

    for (let i = 0; i < coords.length; i++) {
      const [px, py] = coords[i]
      const sx = ml + ((px - minX) / rangeX) * pw
      const sy = mt + ph - ((py - minY) / rangeY) * ph
      ctx.fillStyle = colorOf(activeLabels[i])
      // Dim non-highlighted clusters when one is highlighted
      if (highlightedCluster !== null && highlightedCluster !== undefined) {
        const docCluster = viewMode === 'flat' ? cluster.labels[i] : (hierarchical?.microToMacro[activeLabels[i]] ?? activeLabels[i])
        ctx.globalAlpha = docCluster === highlightedCluster ? 0.9 : 0.15
      } else {
        ctx.globalAlpha = 0.7
      }
      ctx.beginPath()
      ctx.arc(sx, sy, radius, 0, Math.PI * 2)
      ctx.fill()
    }
    ctx.globalAlpha = 1.0
  }, [coords, activeLabels, bounds, docs, explainedVariance, colorOf, highlightedCluster, viewMode, cluster.labels, hierarchical])

  // Tooltip on hover
  useEffect(() => {
    const canvas = canvasRef.current
    const container = containerRef.current
    const tooltip = tooltipRef.current
    if (!canvas || !container || !tooltip) return

    const ml = 40, mr = 20, mt = 20, mb = 30

    const handleMouseMove = (e: MouseEvent) => {
      const rect = canvas.getBoundingClientRect()
      const mx = e.clientX - rect.left
      const my = e.clientY - rect.top

      const pw = container.clientWidth - ml - mr
      const ph = Math.min(container.clientWidth * 0.6, 500) - mt - mb
      const { minX, maxX, minY, maxY } = bounds
      const rangeX = maxX - minX
      const rangeY = maxY - minY

      // Find nearest point
      let bestIdx = -1
      let bestDist = 15 // pixel threshold
      for (let i = 0; i < coords.length; i++) {
        const [px, py] = coords[i]
        const sx = ml + ((px - minX) / rangeX) * pw
        const sy = mt + ph - ((py - minY) / rangeY) * ph
        const dx = sx - mx
        const dy = sy - my
        const dist = Math.sqrt(dx * dx + dy * dy)
        if (dist < bestDist) {
          bestDist = dist
          bestIdx = i
        }
      }

      if (bestIdx >= 0) {
        const doc = docs[bestIdx]
        const clusterLabel = activeLabels[bestIdx]
        // Emit cluster hover for cross-component highlighting
        const macroCluster = viewMode === 'flat' ? clusterLabel : (hierarchical?.microToMacro[clusterLabel] ?? clusterLabel)
        onClusterHover?.(macroCluster)
        const displayLabel = metaLabelMap?.get(clusterLabel)
          ?? (viewMode === 'flat' ? `Cluster ${clusterLabel}` : `${t(language, 'ivHierarchicalMicro')} ${clusterLabel}`)
        const macroInfo = viewMode === 'hierarchy' && hierarchical
          ? (() => {
              const macroId = hierarchical.microToMacro[clusterLabel]
              const macroName = clusterSummariesFromMeta?.[macroId]?.label ?? `${t(language, 'ivHierarchicalMacro')} ${macroId}`
              return `<br/>${escapeHtml(macroName)}`
            })()
          : ''
        tooltip.style.display = 'block'
        tooltip.style.left = `${e.clientX - rect.left + 12}px`
        tooltip.style.top = `${e.clientY - rect.top - 10}px`
        tooltip.innerHTML = `<strong>${escapeHtml(truncate(doc.title, 60))}</strong><br/>` +
          `<span style="color:${colorOf(clusterLabel)}">●</span> ` +
          `${escapeHtml(displayLabel)}${macroInfo}<br/>` +
          `ID: ${escapeHtml(truncate(doc.id, 30))}`
      } else {
        tooltip.style.display = 'none'
        onClusterHover?.(null)
      }
    }

    const handleMouseLeave = () => {
      tooltip.style.display = 'none'
      onClusterHover?.(null)
    }

    canvas.addEventListener('mousemove', handleMouseMove)
    canvas.addEventListener('mouseleave', handleMouseLeave)
    return () => {
      canvas.removeEventListener('mousemove', handleMouseMove)
      canvas.removeEventListener('mouseleave', handleMouseLeave)
    }
  }, [coords, bounds, docs, activeLabels, metaLabelMap, viewMode, hierarchical, language, colorOf, onClusterHover])

  return (
    <div className="section" style={{ marginTop: '16px' }}>
      <div className="section__title" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span>
          <i className="bi bi-scatter-chart icon--mr6" />
          {t(language, 'ivScatterTitle')}
        </span>
        {hasHierarchical && (
          <span style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '0.85em', fontWeight: 400 }}>
            <span>{t(language, 'ivHierarchicalView')}:</span>
            <button
              type="button"
              className={`btn btn--sm ${viewMode === 'flat' ? 'btn--primary' : 'btn--secondary'}`}
              onClick={() => setViewMode('flat')}
              style={{ padding: '2px 8px', fontSize: '12px' }}
            >
              {t(language, 'ivHierarchicalViewFlat')}
            </button>
            <button
              type="button"
              className={`btn btn--sm ${viewMode === 'hierarchy' ? 'btn--primary' : 'btn--secondary'}`}
              onClick={() => setViewMode('hierarchy')}
              style={{ padding: '2px 8px', fontSize: '12px' }}
            >
              {t(language, 'ivHierarchicalViewHierarchy')}
            </button>
          </span>
        )}
      </div>
      <div className="app__hint">
        {t(language, 'ivScatterHint')
          .replace('{docs}', String(docs.length))
          .replace('{k}', String(clusterSummary.length))}
      </div>

      {/* Canvas */}
      <div ref={containerRef} style={{ position: 'relative', width: '100%', marginTop: '8px' }}>
        <canvas ref={canvasRef} style={{ display: 'block', width: '100%' }} />
        <div
          ref={tooltipRef}
          style={{
            display: 'none',
            position: 'absolute',
            background: 'rgba(30, 30, 30, 0.92)',
            color: '#f0f0f0',
            border: '1px solid rgba(255, 255, 255, 0.15)',
            padding: '6px 10px',
            borderRadius: '6px',
            fontSize: '12px',
            lineHeight: '1.4',
            pointerEvents: 'none',
            zIndex: 10,
            maxWidth: '300px',
            boxShadow: '0 2px 8px rgba(0,0,0,0.4)',
            backdropFilter: 'blur(4px)',
          }}
        />
      </div>

      {/* Cluster legend */}
      <div style={{ marginTop: '12px' }}>
        <div className="section__subtitle" style={{ marginBottom: '6px' }}>
          {t(language, 'ivClusterLegend')}
        </div>
        {viewMode === 'hierarchy' && hierarchical ? (
          // Hierarchical legend: group micro clusters by macro
          <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
            {Array.from(new Set(Array.from(hierarchical.microToMacro))).map((macroId) => {
              const macroMembers = clusterSummary.filter((c) => c.macroLabel === macroId)
              if (macroMembers.length === 0) return null
              const macroColor = CLUSTER_COLORS[macroId % CLUSTER_COLORS.length]
              const isMacroHighlighted = highlightedCluster === macroId
              return (
                <div
                  key={macroId}
                  style={{
                    borderLeft: `3px solid ${macroColor}`,
                    paddingLeft: '10px',
                    background: isMacroHighlighted ? 'var(--panel3, var(--panel2))' : undefined,
                    outline: isMacroHighlighted ? `2px solid ${macroColor}` : 'none',
                    borderRadius: '6px',
                    transition: 'outline 0.15s, background 0.15s',
                  }}
                  onMouseEnter={() => onClusterHover?.(macroId)}
                  onMouseLeave={() => onClusterHover?.(null)}
                >
                  <div style={{ fontWeight: 600, marginBottom: '6px' }}>
                    <span style={{ color: macroColor, marginRight: '6px' }}>■</span>
                    {clusterSummariesFromMeta?.[macroId]?.label ?? `${t(language, 'ivHierarchicalMacro')} ${macroId}`}
                  </div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
                    {macroMembers.map((c) => (
                      <div
                        key={c.label}
                        style={{
                          background: 'var(--panel2)',
                          borderRadius: '6px',
                          padding: '6px 10px',
                          borderLeft: `3px solid ${c.color}`,
                          minWidth: '160px',
                          flex: '1 1 180px',
                          maxWidth: '260px',
                          fontSize: '12px',
                        }}
                      >
                        <div style={{ fontWeight: 500, marginBottom: '2px' }}>
                          <span style={{ color: c.color, marginRight: '4px' }}>●</span>
                          {c.displayLabel}
                          <span style={{ fontWeight: 400, marginLeft: '6px', opacity: 0.7 }}>({c.count})</span>
                        </div>
                        <div style={{ opacity: 0.8 }}>
                          {c.sampleTitles.slice(0, 3).map((title, i) => (
                            <div key={i} style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                              {truncate(title, 35)}
                            </div>
                          ))}
                        </div>
                        <button
                          type="button"
                          className="btn btn--secondary"
                          style={{ marginTop: '4px', padding: '2px 6px', fontSize: '10px' }}
                          onClick={(e) => { e.stopPropagation(); onBrowseCluster?.(c.label) }}
                        >
                          <i className="bi bi-list-ul icon--mr6" />
                          {t(language, 'ivClusterDocsBrowse')}
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              )
            })}
          </div>
        ) : (
          // Flat legend (original)
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
            {clusterSummary.map((c) => (
              <div
                key={c.label}
                style={{
                  background: highlightedCluster === c.label ? 'var(--panel3, var(--panel2))' : 'var(--panel2)',
                  borderRadius: '8px',
                  padding: '8px 12px',
                  borderLeft: `3px solid ${c.color}`,
                  minWidth: '200px',
                  flex: '1 1 220px',
                  maxWidth: '320px',
                  outline: highlightedCluster === c.label ? `2px solid ${c.color}` : 'none',
                  transition: 'outline 0.15s, background 0.15s',
                  cursor: 'pointer',
                }}
                onMouseEnter={() => onClusterHover?.(c.label)}
                onMouseLeave={() => onClusterHover?.(null)}
              >
                <div style={{ fontWeight: 600, marginBottom: '4px' }}>
                  <span style={{ color: c.color, marginRight: '6px' }}>●</span>
                  {c.displayLabel}
                  <span style={{ fontWeight: 400, marginLeft: '8px', opacity: 0.7 }}>
                    ({c.count} docs)
                  </span>
                </div>
                <div style={{ fontSize: '12px', opacity: 0.8 }}>
                  {c.sampleTitles.map((title, i) => (
                    <div key={i} style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {truncate(title, 40)}
                    </div>
                  ))}
                  {c.count > 5 && (
                    <div style={{ opacity: 0.5 }}>…{t(language, 'ivMoreDocs').replace('{n}', String(c.count - 5))}</div>
                  )}
                </div>
                <button
                  type="button"
                  className="btn btn--secondary"
                  style={{ marginTop: '6px', padding: '2px 8px', fontSize: '11px' }}
                  onClick={(e) => { e.stopPropagation(); onBrowseCluster?.(c.label) }}
                >
                  <i className="bi bi-list-ul icon--mr6" />
                  {t(language, 'ivClusterDocsBrowse')}
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

// ============================================================================
// Meta Cluster Trace Modal
// ============================================================================

function MetaTraceModal({ trace, language, onClose }: {
  trace: MetaClusterTrace
  language: Language
  onClose: () => void
}) {
  const [expandedSection, setExpandedSection] = useState<'system' | 'user' | 'response' | null>(null)

  const toggle = (section: 'system' | 'user' | 'response') => {
    setExpandedSection((prev) => prev === section ? null : section)
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        className="modal-content"
        style={{ maxWidth: '800px', maxHeight: '85vh', overflow: 'auto' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-header">
          <h2>
            <i className="bi bi-bug" style={{ marginRight: '8px' }} />
            {language === 'ja' ? 'クラスタ LLM トレース' : 'Cluster LLM Trace'} — {trace.label}
          </h2>
          <button type="button" className="btn" onClick={onClose}>✕</button>
        </div>
        <div className="modal-body" style={{ padding: '16px' }}>
          {/* Summary stats */}
          <div style={{ display: 'flex', gap: '16px', flexWrap: 'wrap', marginBottom: '16px' }}>
            <div style={{ background: 'var(--panel-2)', borderRadius: '8px', padding: '10px 14px', flex: '1 1 120px' }}>
              <div style={{ fontSize: '11px', opacity: 0.6 }}>Cluster ID</div>
              <div style={{ fontWeight: 600 }}>{trace.clusterId}</div>
            </div>
            <div style={{ background: 'var(--panel-2)', borderRadius: '8px', padding: '10px 14px', flex: '1 1 120px' }}>
              <div style={{ fontSize: '11px', opacity: 0.6 }}>Input Tokens</div>
              <div style={{ fontWeight: 600 }}>{trace.promptTokens.toLocaleString()}</div>
            </div>
            <div style={{ background: 'var(--panel-2)', borderRadius: '8px', padding: '10px 14px', flex: '1 1 120px' }}>
              <div style={{ fontSize: '11px', opacity: 0.6 }}>Output Tokens</div>
              <div style={{ fontWeight: 600 }}>{trace.completionTokens.toLocaleString()}</div>
            </div>
            <div style={{ background: 'var(--panel-2)', borderRadius: '8px', padding: '10px 14px', flex: '1 1 120px' }}>
              <div style={{ fontSize: '11px', opacity: 0.6 }}>{language === 'ja' ? '合計' : 'Total'}</div>
              <div style={{ fontWeight: 600 }}>{trace.totalTokens.toLocaleString()}</div>
            </div>
            <div style={{ background: 'var(--panel-2)', borderRadius: '8px', padding: '10px 14px', flex: '1 1 120px' }}>
              <div style={{ fontSize: '11px', opacity: 0.6 }}>{language === 'ja' ? '処理時間' : 'Duration'}</div>
              <div style={{ fontWeight: 600 }}>{(trace.durationMs / 1000).toFixed(2)}s</div>
            </div>
          </div>



          {/* Error indicator */}
          {trace.error && (
            <div className="notice notice--error" style={{ marginBottom: '12px' }}>
              <i className="bi bi-exclamation-triangle icon--mr6" />
              {trace.error}
            </div>
          )}

          {/* System Prompt */}
          <div style={{ marginBottom: '8px', border: '1px solid var(--border)', borderRadius: '8px', overflow: 'hidden' }}>
            <button
              type="button"
              onClick={() => toggle('system')}
              style={{
                width: '100%', textAlign: 'left', padding: '10px 14px', background: 'var(--panel-2)',
                border: 'none', cursor: 'pointer', fontWeight: 600, fontSize: '12px', color: 'var(--fg)',
                display: 'flex', alignItems: 'center', gap: '8px',
              }}
            >
              <i className={`bi bi-chevron-${expandedSection === 'system' ? 'down' : 'right'}`} />
              System Prompt
              <span style={{ marginLeft: 'auto', fontWeight: 400, opacity: 0.6, fontSize: '11px' }}>
                {trace.systemPrompt.length.toLocaleString()} chars
              </span>
            </button>
            {expandedSection === 'system' && (
              <pre style={{ margin: 0, padding: '12px 14px', fontSize: '11px', whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxHeight: '200px', overflow: 'auto', background: 'var(--panel)' }}>
                {trace.systemPrompt}
              </pre>
            )}
          </div>

          {/* User Prompt (input documents) */}
          <div style={{ marginBottom: '8px', border: '1px solid var(--border)', borderRadius: '8px', overflow: 'hidden' }}>
            <button
              type="button"
              onClick={() => toggle('user')}
              style={{
                width: '100%', textAlign: 'left', padding: '10px 14px', background: 'var(--panel-2)',
                border: 'none', cursor: 'pointer', fontWeight: 600, fontSize: '12px', color: 'var(--fg)',
                display: 'flex', alignItems: 'center', gap: '8px',
              }}
            >
              <i className={`bi bi-chevron-${expandedSection === 'user' ? 'down' : 'right'}`} />
              User Prompt ({language === 'ja' ? '入力ドキュメント' : 'Input Documents'})
              <span style={{ marginLeft: 'auto', fontWeight: 400, opacity: 0.6, fontSize: '11px' }}>
                {trace.userPrompt.length.toLocaleString()} chars
              </span>
            </button>
            {expandedSection === 'user' && (
              <pre style={{ margin: 0, padding: '12px 14px', fontSize: '11px', whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxHeight: '400px', overflow: 'auto', background: 'var(--panel)' }}>
                {trace.userPrompt}
              </pre>
            )}
          </div>

          {/* LLM Response */}
          <div style={{ marginBottom: '8px', border: '1px solid var(--border)', borderRadius: '8px', overflow: 'hidden' }}>
            <button
              type="button"
              onClick={() => toggle('response')}
              style={{
                width: '100%', textAlign: 'left', padding: '10px 14px', background: 'var(--panel-2)',
                border: 'none', cursor: 'pointer', fontWeight: 600, fontSize: '12px', color: 'var(--fg)',
                display: 'flex', alignItems: 'center', gap: '8px',
              }}
            >
              <i className={`bi bi-chevron-${expandedSection === 'response' ? 'down' : 'right'}`} />
              LLM Response
              <span style={{ marginLeft: 'auto', fontWeight: 400, opacity: 0.6, fontSize: '11px' }}>
                {trace.response ? `${trace.response.length.toLocaleString()} chars` : '—'}
              </span>
            </button>
            {expandedSection === 'response' && (
              <pre style={{ margin: 0, padding: '12px 14px', fontSize: '11px', whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxHeight: '300px', overflow: 'auto', background: 'var(--panel)' }}>
                {trace.response ?? (language === 'ja' ? '(レスポンスなし)' : '(No response)')}
              </pre>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + '…' : s
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

// ============================================================================
// Cluster Graph (Force-directed, interactive) — Phase 4
// ============================================================================

interface ForceGraphNode {
  id: number
  label: string
  count: number
  color: string
}

interface ForceGraphLink {
  source: number
  target: number
  similarity: number
  confidence?: EdgeConfidence
  relationKind?: 'explained' | 'candidate'
  reasons?: EdgeReason[]
  sharedFacets?: string[]
  sharedKeywords?: string[]
  bridgeDocIndices?: number[]
  scoreBreakdown?: ClusterEdge['scoreBreakdown']
}

type EdgeSimilarityBand = 'very-high' | 'high' | 'medium' | 'low'

function graphEdgeKey(source: number, target: number): string {
  return source < target ? `${source}-${target}` : `${target}-${source}`
}

function linkEndpointId(endpoint: unknown): number {
  return typeof endpoint === 'object' && endpoint !== null && 'id' in endpoint
    ? Number((endpoint as { id: unknown }).id)
    : Number(endpoint)
}

function edgeConfidenceLabel(language: Language, confidence?: EdgeConfidence): string {
  if (confidence === 'high') return t(language, 'ivGraphEdgeConfidenceHigh')
  if (confidence === 'medium') return t(language, 'ivGraphEdgeConfidenceMedium')
  return t(language, 'ivGraphEdgeConfidenceLow')
}

function edgeRelationLabel(language: Language, edge: Pick<ClusterEdge, 'relationKind' | 'confidence'>): string {
  return edge.relationKind === 'explained' || edge.confidence === 'high' || edge.confidence === 'medium'
    ? t(language, 'ivGraphRelationExplained')
    : t(language, 'ivGraphRelationCandidate')
}

function edgeReasonText(reason: EdgeReason, language: Language): string {
  if (language === 'ja') {
    if (reason.kind === 'centroid') return `重心類似度 ${reason.detail}`
    if (reason.kind === 'bridge-documents') return `境界文書 ${reason.detail} 件`
    if (reason.kind === 'shared-facet') return `共通ファセット: ${reason.detail}`
    if (reason.kind === 'shared-keyword') return `共通キーワード: ${reason.detail}`
    return `意味署名の重なり ${reason.detail}`
  }
  if (reason.kind === 'centroid') return `Centroid similarity ${reason.detail}`
  if (reason.kind === 'bridge-documents') return `${reason.detail} bridge documents`
  if (reason.kind === 'shared-facet') return `Shared facets: ${reason.detail}`
  if (reason.kind === 'shared-keyword') return `Shared keywords: ${reason.detail}`
  return `Signature overlap ${reason.detail}`
}

function edgeSimilarityBand(similarity: number): EdgeSimilarityBand {
  if (similarity >= 0.9) return 'very-high'
  if (similarity >= 0.78) return 'high'
  if (similarity >= 0.64) return 'medium'
  return 'low'
}

function edgeSimilarityBandLabel(language: Language, similarity: number): string {
  const band = edgeSimilarityBand(similarity)
  if (band === 'very-high') return t(language, 'ivGraphSimilarityVeryHigh')
  if (band === 'high') return t(language, 'ivGraphSimilarityHigh')
  if (band === 'medium') return t(language, 'ivGraphSimilarityMedium')
  return t(language, 'ivGraphSimilarityLow')
}

function edgeWidthForSimilarity(similarity: number): number {
  const normalized = Math.max(0, Math.min(1, similarity))
  return 0.8 + normalized * 3.4
}

function edgeLineDashForSimilarity(similarity: number): number[] | null {
  const band = edgeSimilarityBand(similarity)
  if (band === 'very-high' || band === 'high') return null
  if (band === 'medium') return [9, 5]
  return [3, 6]
}

function edgeOpacityForSimilarity(similarity: number): number {
  const normalized = Math.max(0, Math.min(1, similarity))
  return 0.32 + normalized * 0.58
}

function edgeColorForConfidence(confidence?: EdgeConfidence, isLightBg = false, opacity = 1): string {
  const clampedOpacity = Math.max(0.1, Math.min(1, opacity))
  if (confidence === 'high') return `rgba(53,199,164,${clampedOpacity})`
  if (confidence === 'medium') return `rgba(91,157,255,${clampedOpacity})`
  const alpha = isLightBg ? clampedOpacity * 0.5 : clampedOpacity * 0.42
  return isLightBg ? `rgba(90,90,90,${alpha})` : `rgba(190,190,190,${alpha})`
}

function ClusterGraphView({ graph, data, language, clusterSummariesFromMeta, onBrowseCluster }: {
  graph: ClusterGraphData
  data?: VisualizationData | null
  language: Language
  clusterSummariesFromMeta?: ClusterSummary[] | null
  onBrowseCluster?: (clusterId: number) => void
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const graphContainerRef = useRef<HTMLDivElement>(null)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fgRef = useRef<any>(null)
  const [highlightedNodeId, setHighlightedNodeId] = useState<number | null>(null)
  const [selectedNodeId, setSelectedNodeId] = useState<number | null>(null)
  const [selectedEdgeKey, setSelectedEdgeKey] = useState<string | null>(null)
  const [linkDistance, setLinkDistance] = useState(120)
  const [chargeStrength, setChargeStrength] = useState(-300)
  const [edgeMinThreshold, setEdgeMinThreshold] = useState(0)
  const [showEdgeLabels, setShowEdgeLabels] = useState(false)
  const [enableParticles, setEnableParticles] = useState(true)
  const [colorMode, setColorMode] = useState<'cluster' | 'count' | 'degree'>('cluster')
  const [sizeMode, setSizeMode] = useState<'count' | 'uniform' | 'degree'>('count')
  const [searchTerm, setSearchTerm] = useState('')
  const [layoutMode, setLayoutMode] = useState<'force' | 'radial'>('force')
  const [isFullscreen, setIsFullscreen] = useState(false)
  // Animation pulse for selected node halo
  const [pulse, setPulse] = useState(0)

  const { nodes, edges, bridges } = graph

  // Build label map (and a richer summary lookup for the detail panel)
  const summaryMap = useMemo(() => {
    const map = new Map<number, ClusterSummary>()
    if (clusterSummariesFromMeta) {
      clusterSummariesFromMeta.forEach((cs, i) => map.set(i, cs))
    }
    return map
  }, [clusterSummariesFromMeta])

  const labelMap = useMemo(() => {
    return (id: number) => summaryMap.get(id)?.label ?? `Cluster ${id}`
  }, [summaryMap])

  // Filter edges by user threshold
  const filteredEdges = useMemo(
    () => edges.filter((e) => e.similarity >= edgeMinThreshold),
    [edges, edgeMinThreshold],
  )

  const edgeByKey = useMemo(() => {
    const map = new Map<string, ClusterEdge>()
    for (const edge of filteredEdges) map.set(graphEdgeKey(edge.source, edge.target), edge)
    return map
  }, [filteredEdges])

  // Node degree (based on filtered edges)
  const degreeMap = useMemo(() => {
    const m = new Map<number, number>()
    for (const n of nodes) m.set(n.id, 0)
    for (const e of filteredEdges) {
      m.set(e.source, (m.get(e.source) ?? 0) + 1)
      m.set(e.target, (m.get(e.target) ?? 0) + 1)
    }
    return m
  }, [nodes, filteredEdges])

  const maxDegree = useMemo(() => {
    let m = 1
    degreeMap.forEach((v) => { if (v > m) m = v })
    return m
  }, [degreeMap])

  // Max count for size scaling
  const maxCount = useMemo(() => Math.max(...nodes.map((n) => n.count), 1), [nodes])

  // Search match set (case-insensitive substring)
  const searchMatches = useMemo(() => {
    const s = searchTerm.trim().toLowerCase()
    if (!s) return null
    const set = new Set<number>()
    for (const n of nodes) {
      if (labelMap(n.id).toLowerCase().includes(s)) set.add(n.id)
    }
    return set
  }, [searchTerm, nodes, labelMap])

  // Color by mode
  const colorOf = useCallback((id: number): string => {
    if (colorMode === 'cluster') return CLUSTER_COLORS[id % CLUSTER_COLORS.length]
    if (colorMode === 'count') {
      const node = nodes.find((n) => n.id === id)
      const t = node ? node.count / maxCount : 0
      // Heat: blue → cyan → green → yellow → red
      return heatColor(t)
    }
    // degree
    const t = (degreeMap.get(id) ?? 0) / maxDegree
    return heatColor(t)
  }, [colorMode, nodes, maxCount, degreeMap, maxDegree])

  // Size by mode
  const sizeOf = useCallback((id: number): number => {
    if (sizeMode === 'uniform') return 8
    if (sizeMode === 'degree') {
      const t = (degreeMap.get(id) ?? 0) / maxDegree
      return 4 + Math.sqrt(t) * 20
    }
    const node = nodes.find((n) => n.id === id)
    const t = node ? node.count / maxCount : 0
    return 4 + Math.sqrt(t) * 20
  }, [sizeMode, nodes, maxCount, degreeMap, maxDegree])

  // Build graph data for force-graph (from filtered edges)
  const graphData = useMemo(() => {
    const fgNodes: ForceGraphNode[] = nodes.map((n) => ({
      id: n.id,
      label: labelMap(n.id),
      count: n.count,
      color: colorOf(n.id),
    }))
    const fgLinks: ForceGraphLink[] = filteredEdges.map((e) => ({
      source: e.source,
      target: e.target,
      similarity: e.similarity,
      confidence: e.confidence,
      relationKind: e.relationKind,
      reasons: e.reasons,
      sharedFacets: e.sharedFacets,
      sharedKeywords: e.sharedKeywords,
      bridgeDocIndices: e.bridgeDocIndices,
      scoreBreakdown: e.scoreBreakdown,
    }))
    return { nodes: fgNodes, links: fgLinks }
  }, [nodes, filteredEdges, labelMap, colorOf])

  // Bridge count per edge (using all bridges, not filtered)
  const bridgeCountMap = useMemo(() => {
    const map = new Map<string, number>()
    for (const br of bridges) {
      const key = br.ownCluster < br.nearestCluster
        ? `${br.ownCluster}-${br.nearestCluster}`
        : `${br.nearestCluster}-${br.ownCluster}`
      map.set(key, (map.get(key) ?? 0) + 1)
    }
    return map
  }, [bridges])

  // Highlighted (= hover OR selected)
  const focusNodeId = highlightedNodeId ?? selectedNodeId

  const focusNeighbors = useMemo(() => {
    if (focusNodeId === null) return new Set<number>()
    const set = new Set<number>()
    for (const e of filteredEdges) {
      if (e.source === focusNodeId) set.add(e.target)
      if (e.target === focusNodeId) set.add(e.source)
    }
    return set
  }, [focusNodeId, filteredEdges])

  const focusLinks = useMemo(() => {
    const set = new Set<string>()
    if (selectedEdgeKey) set.add(selectedEdgeKey)
    if (focusNodeId === null) return set
    for (const e of filteredEdges) {
      if (e.source === focusNodeId || e.target === focusNodeId) {
        set.add(graphEdgeKey(e.source, e.target))
      }
    }
    return set
  }, [focusNodeId, filteredEdges, selectedEdgeKey])

  // Graph statistics
  const stats = useMemo(() => {
    const n = nodes.length
    const e = filteredEdges.length
    const maxPossible = n > 1 ? (n * (n - 1)) / 2 : 1
    const density = maxPossible > 0 ? e / maxPossible : 0
    let sumSim = 0, maxSim = 0
    for (const ed of filteredEdges) {
      sumSim += ed.similarity
      if (ed.similarity > maxSim) maxSim = ed.similarity
    }
    const avgSim = e > 0 ? sumSim / e : 0
    let isolated = 0
    degreeMap.forEach((d) => { if (d === 0) isolated++ })
    return { n, e, density, avgSim, maxSim, isolated }
  }, [nodes, filteredEdges, degreeMap])

  // Pulse animation for selected node halo
  useEffect(() => {
    if (selectedNodeId === null) return
    let raf = 0
    const tick = () => {
      setPulse((p) => (p + 0.04) % (Math.PI * 2))
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [selectedNodeId])

  // Initialize and update force-graph
  useEffect(() => {
    const el = graphContainerRef.current
    if (!el) return

    let cancelled = false
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let fgInstance: any = null

    import('force-graph').then((mod) => {
      if (cancelled || !el) return
      const ForceGraph = mod.default

      const computedStyle = getComputedStyle(el)
      const bgHex = computedStyle.getPropertyValue('--bg').trim()
      const isLightBg = (() => {
        if (!bgHex || !bgHex.startsWith('#')) return false
        const [r, g, b] = hexToRgb(bgHex)
        return (r * 299 + g * 587 + b * 114) / 1000 > 160
      })()

      const width = el.clientWidth || 600
      const height = isFullscreen
        ? Math.max(500, window.innerHeight - 160)
        : Math.min(width * 0.65, 520)

      fgInstance = new ForceGraph(el)
        .width(width)
        .height(height)
        .backgroundColor(isLightBg ? '#f0f2f5' : 'transparent')
        .nodeId('id')
        .nodeVal((node: any) => sizeOf(node.id)) // eslint-disable-line @typescript-eslint/no-explicit-any
        .nodeColor((node: any) => { // eslint-disable-line @typescript-eslint/no-explicit-any
          const isFocus = focusNodeId === node.id
          const isNeighbor = focusNeighbors.has(node.id)
          const isMatch = searchMatches?.has(node.id)
          if (focusNodeId === null && searchMatches === null) return node.color
          if (isFocus || isNeighbor || isMatch) return node.color
          return isLightBg ? 'rgba(180,180,180,0.35)' : 'rgba(100,100,100,0.35)'
        })
        .nodeCanvasObjectMode(() => 'after')
        .nodeCanvasObject((node: any, ctx: CanvasRenderingContext2D, globalScale: number) => { // eslint-disable-line @typescript-eslint/no-explicit-any
          if (node.x == null || node.y == null) return
          const r = Math.sqrt(sizeOf(node.id)) * 2.2
          const isSelected = selectedNodeId === node.id
          const isHovered = highlightedNodeId === node.id

          // Halo for selected node (pulse)
          if (isSelected) {
            const pulseR = r + 6 + Math.sin(pulse) * 4
            ctx.beginPath()
            ctx.arc(node.x, node.y, pulseR, 0, Math.PI * 2)
            ctx.strokeStyle = node.color
            ctx.lineWidth = 2 / globalScale
            ctx.globalAlpha = 0.6
            ctx.stroke()
            ctx.globalAlpha = 1
          } else if (isHovered) {
            ctx.beginPath()
            ctx.arc(node.x, node.y, r + 3, 0, Math.PI * 2)
            ctx.strokeStyle = node.color
            ctx.lineWidth = 1.5 / globalScale
            ctx.globalAlpha = 0.5
            ctx.stroke()
            ctx.globalAlpha = 1
          }

          const fontSize = Math.max(10, 14 / globalScale)
          const label = node.label
          ctx.font = `bold ${fontSize}px system-ui, sans-serif`
          ctx.textAlign = 'center'
          ctx.textBaseline = 'top'
          const labelY = node.y + r + 2 / globalScale

          const textWidth = ctx.measureText(label).width
          const bgPadX = 3 / globalScale
          const bgPadY = 1 / globalScale
          ctx.fillStyle = isLightBg ? 'rgba(240,242,245,0.85)' : 'rgba(30,30,30,0.85)'
          ctx.fillRect(node.x - textWidth / 2 - bgPadX, labelY - bgPadY, textWidth + bgPadX * 2, fontSize + bgPadY * 2)

          ctx.fillStyle = isLightBg ? '#222' : '#eee'
          ctx.fillText(label, node.x, labelY)

          // Count inside the node
          const countFontSize = Math.max(9, 12 / globalScale)
          ctx.font = `${countFontSize}px system-ui, sans-serif`
          ctx.textBaseline = 'middle'
          ctx.fillStyle = '#fff'
          ctx.fillText(`${node.count}`, node.x, node.y)
        })
        .linkWidth((link: any) => edgeWidthForSimilarity(link.similarity)) // eslint-disable-line @typescript-eslint/no-explicit-any
        .linkColor((link: any) => { // eslint-disable-line @typescript-eslint/no-explicit-any
          const src = typeof link.source === 'object' ? link.source.id : link.source
          const tgt = typeof link.target === 'object' ? link.target.id : link.target
          const key = graphEdgeKey(src, tgt)
          if ((focusNodeId !== null || selectedEdgeKey !== null) && !focusLinks.has(key)) {
            return isLightBg ? 'rgba(180,180,180,0.12)' : 'rgba(100,100,100,0.12)'
          }
          return edgeColorForConfidence(link.confidence, isLightBg, edgeOpacityForSimilarity(link.similarity))
        })
        .linkLineDash((link: any) => edgeLineDashForSimilarity(link.similarity)) // eslint-disable-line @typescript-eslint/no-explicit-any
        .linkCanvasObjectMode(() => 'after')
        .linkCanvasObject((link: any, ctx: CanvasRenderingContext2D, globalScale: number) => { // eslint-disable-line @typescript-eslint/no-explicit-any
          const start = link.source
          const end = link.target
          if (typeof start !== 'object' || typeof end !== 'object') return
          if (start.x == null || end.x == null) return
          const mx = (start.x + end.x) / 2
          const my = (start.y + end.y) / 2

          // Bridge badge
          const srcId = start.id
          const tgtId = end.id
          const bridgeKey = graphEdgeKey(srcId, tgtId)
          const bridgeCount = bridgeCountMap.get(bridgeKey)
          const isSelectedEdge = selectedEdgeKey === bridgeKey
          if (isSelectedEdge) {
            ctx.save()
            ctx.beginPath()
            ctx.moveTo(start.x, start.y)
            ctx.lineTo(end.x, end.y)
            ctx.strokeStyle = edgeColorForConfidence(link.confidence, isLightBg, 1)
            ctx.lineWidth = (edgeWidthForSimilarity(link.similarity) + 2) / globalScale
            ctx.globalAlpha = 0.55
            ctx.setLineDash(edgeLineDashForSimilarity(link.similarity)?.map((segment) => segment / globalScale) ?? [])
            ctx.stroke()
            ctx.setLineDash([])
            ctx.restore()
          }
          if (bridgeCount && bridgeCount > 0) {
            const r = 6 / globalScale
            ctx.beginPath()
            ctx.arc(mx, my, r, 0, Math.PI * 2)
            ctx.fillStyle = '#f59f00'
            ctx.fill()
            ctx.strokeStyle = isLightBg ? '#fff' : '#1a1a1a'
            ctx.lineWidth = 1 / globalScale
            ctx.stroke()
            ctx.fillStyle = '#1a1a1a'
            ctx.font = `bold ${9 / globalScale}px system-ui`
            ctx.textAlign = 'center'
            ctx.textBaseline = 'middle'
            ctx.fillText(String(bridgeCount), mx, my)
          }

          // Edge label (similarity)
          if (showEdgeLabels) {
            const labelText = link.similarity.toFixed(2)
            const fs = 10 / globalScale
            ctx.font = `${fs}px system-ui`
            const w = ctx.measureText(labelText).width
            const padX = 3 / globalScale
            const padY = 1 / globalScale
            const offset = bridgeCount ? 14 / globalScale : 0
            ctx.fillStyle = isLightBg ? 'rgba(255,255,255,0.85)' : 'rgba(20,20,20,0.85)'
            ctx.fillRect(mx - w / 2 - padX, my - fs / 2 - padY + offset, w + padX * 2, fs + padY * 2)
            ctx.fillStyle = isLightBg ? '#333' : '#ddd'
            ctx.textAlign = 'center'
            ctx.textBaseline = 'middle'
            ctx.fillText(labelText, mx, my + offset)
          }
        })
        .linkLabel((link: any) => { // eslint-disable-line @typescript-eslint/no-explicit-any
          const srcLabel = typeof link.source === 'object' ? link.source.label : `Cluster ${link.source}`
          const tgtLabel = typeof link.target === 'object' ? link.target.label : `Cluster ${link.target}`
          const srcId = typeof link.source === 'object' ? link.source.id : link.source
          const tgtId = typeof link.target === 'object' ? link.target.id : link.target
          const bridgeKey = graphEdgeKey(srcId, tgtId)
          const bridgeCount = bridgeCountMap.get(bridgeKey)
          const reasons = Array.isArray(link.reasons)
            ? link.reasons.slice(0, 4).map((reason: EdgeReason) => escapeHtml(edgeReasonText(reason, language))).join('<br/>')
            : ''
          return `${escapeHtml(srcLabel)} ↔ ${escapeHtml(tgtLabel)}<br/>`
            + `${escapeHtml(t(language, 'ivGraphEdgeRelation'))}: ${escapeHtml(edgeRelationLabel(language, link))}<br/>`
            + `${escapeHtml(t(language, 'ivGraphEdgeConfidence'))}: ${escapeHtml(edgeConfidenceLabel(language, link.confidence))}<br/>`
            + `${t(language, 'ivGraphSimilarity')}: ${link.similarity.toFixed(4)}`
            + `<br/>${escapeHtml(t(language, 'ivGraphEdgeSimilarityBand'))}: ${escapeHtml(edgeSimilarityBandLabel(language, link.similarity))}`
            + (bridgeCount ? `<br/>${escapeHtml(t(language, 'ivGraphEdgeBridgeDocs'))}: ${bridgeCount}` : '')
            + (reasons ? `<br/><br/>${reasons}` : '')
        })
        .linkDirectionalParticles((link: any) => enableParticles && link.confidence !== 'low' ? Math.ceil(link.similarity * 3) : 0) // eslint-disable-line @typescript-eslint/no-explicit-any
        .linkDirectionalParticleSpeed((link: any) => link.similarity * 0.006) // eslint-disable-line @typescript-eslint/no-explicit-any
        .linkDirectionalParticleWidth(2)
        .linkDirectionalParticleColor((link: any) => { // eslint-disable-line @typescript-eslint/no-explicit-any
          const src = typeof link.source === 'object' ? link.source : null
          return src?.color ?? '#aaa'
        })
        .onNodeHover((node: any) => { // eslint-disable-line @typescript-eslint/no-explicit-any
          setHighlightedNodeId(node ? node.id : null)
          el.style.cursor = node ? 'pointer' : 'default'
        })
        .onNodeClick((node: any) => { // eslint-disable-line @typescript-eslint/no-explicit-any
          setSelectedEdgeKey(null)
          setSelectedNodeId((prev) => (prev === node.id ? null : node.id))
        })
        .onLinkClick((link: any) => { // eslint-disable-line @typescript-eslint/no-explicit-any
          const source = linkEndpointId(link.source)
          const target = linkEndpointId(link.target)
          setSelectedNodeId(null)
          setSelectedEdgeKey((prev) => {
            const next = graphEdgeKey(source, target)
            return prev === next ? null : next
          })
        })
        .onBackgroundClick(() => {
          setSelectedNodeId(null)
          setSelectedEdgeKey(null)
        })
        .onNodeDragEnd((node: any) => { // eslint-disable-line @typescript-eslint/no-explicit-any
          node.fx = node.x
          node.fy = node.y
        })
        .cooldownTime(3000)
        .warmupTicks(30)
        .graphData(graphData as any) // eslint-disable-line @typescript-eslint/no-explicit-any

      // Configure d3 forces
      const linkForce = fgInstance.d3Force('link')
      if (linkForce) linkForce.distance(linkDistance)
      const chargeForce = fgInstance.d3Force('charge')
      if (chargeForce) chargeForce.strength(chargeStrength)

      // Apply radial layout if selected
      if (layoutMode === 'radial') {
        // Pin nodes evenly on a circle as initial positions
        const cx = width / 2, cy = height / 2
        const radius = Math.min(width, height) * 0.35
        const fgNodes = fgInstance.graphData().nodes
        fgNodes.forEach((n: any, i: number) => { // eslint-disable-line @typescript-eslint/no-explicit-any
          const a = (i / fgNodes.length) * Math.PI * 2
          n.fx = cx + Math.cos(a) * radius
          n.fy = cy + Math.sin(a) * radius
        })
        fgInstance.d3ReheatSimulation()
      }

      setTimeout(() => {
        fgInstance?.zoomToFit(400, 40)
      }, 500)

      fgRef.current = fgInstance
    })

    return () => {
      cancelled = true
      if (fgInstance) {
        fgInstance._destructor()
      }
      fgRef.current = null
      while (el.firstChild) el.removeChild(el.firstChild)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [graphData, bridgeCountMap, language, linkDistance, chargeStrength, layoutMode, isFullscreen])

  // Live re-render when visual modes / focus change (no full re-init)
  useEffect(() => {
    const fg = fgRef.current
    if (!fg) return
    fg.linkDirectionalParticles((link: any) => enableParticles ? Math.ceil(link.similarity * 3) : 0) // eslint-disable-line @typescript-eslint/no-explicit-any
    // Trigger redraw
    if (typeof fg._renderObjs === 'function') fg._renderObjs()
  }, [enableParticles])

  useEffect(() => {
    // Force-graph caches state — easiest to call a renderer trigger
    const fg = fgRef.current
    if (!fg) return
    if (typeof fg.refresh === 'function') fg.refresh()
  }, [focusNodeId, focusNeighbors, focusLinks, searchMatches, selectedNodeId, selectedEdgeKey, highlightedNodeId, pulse, showEdgeLabels])

  // Related clusters table (graph traversal, uses filteredEdges)
  const relatedClusters = useMemo(() => {
    return nodes.map((node) => {
      const neighbors = filteredEdges
        .filter((e) => e.source === node.id || e.target === node.id)
        .map((e) => ({
          clusterId: e.source === node.id ? e.target : e.source,
          similarity: e.similarity,
          edge: e,
        }))
        .sort((a, b) => b.similarity - a.similarity)
      return { id: node.id, label: labelMap(node.id), count: node.count, neighbors }
    })
  }, [nodes, filteredEdges, labelMap])

  // Selected cluster details
  const selectedDetail = useMemo(() => {
    if (selectedNodeId === null) return null
    const node = nodes.find((n) => n.id === selectedNodeId)
    if (!node) return null
    const summary = summaryMap.get(selectedNodeId) ?? null
    const neighbors = filteredEdges
      .filter((e) => e.source === selectedNodeId || e.target === selectedNodeId)
      .map((e) => ({
        clusterId: e.source === selectedNodeId ? e.target : e.source,
        similarity: e.similarity,
        edge: e,
      }))
      .sort((a, b) => b.similarity - a.similarity)
    const bridgeCount = bridges.filter(
      (b) => b.ownCluster === selectedNodeId || b.nearestCluster === selectedNodeId,
    ).length
    return { node, summary, neighbors, bridgeCount, degree: degreeMap.get(selectedNodeId) ?? 0 }
  }, [selectedNodeId, nodes, summaryMap, filteredEdges, bridges, degreeMap])

  const selectedEdgeDetail = useMemo(() => {
    if (!selectedEdgeKey) return null
    const edge = edgeByKey.get(selectedEdgeKey)
    if (!edge) return null
    const sourceNode = nodes.find((node) => node.id === edge.source)
    const targetNode = nodes.find((node) => node.id === edge.target)
    const bridgeDocs = (edge.bridgeDocIndices ?? [])
      .map((docIndex) => data?.docs?.[docIndex])
      .filter((doc): doc is NonNullable<typeof doc> => Boolean(doc))
      .slice(0, 5)
    return {
      edge,
      sourceLabel: labelMap(edge.source),
      targetLabel: labelMap(edge.target),
      sourceCount: sourceNode?.count ?? 0,
      targetCount: targetNode?.count ?? 0,
      bridgeDocs,
    }
  }, [selectedEdgeKey, edgeByKey, nodes, data, labelMap])

  const exportPng = useCallback(() => {
    const el = graphContainerRef.current
    if (!el) return
    const canvas = el.querySelector('canvas')
    if (!canvas) return
    const link = document.createElement('a')
    link.download = `cluster-graph-${Date.now()}.png`
    link.href = canvas.toDataURL('image/png')
    link.click()
  }, [])

  return (
    <div className="section" style={{ marginTop: '16px' }} ref={containerRef}>
      <div className="section__title">
        <i className="bi bi-diagram-2 icon--mr6" />
        {t(language, 'ivGraphTitle')}
      </div>
      <div className="app__hint">
        {t(language, 'ivGraphDescription')
          .replace('{nodes}', String(nodes.length))
          .replace('{edges}', String(filteredEdges.length))
          .replace('{bridges}', String(bridges.length))}
      </div>

      {/* Toolbar — Row 1: Action buttons */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', alignItems: 'center', marginTop: '8px', fontSize: '12px' }}>
        <button type="button" className="btn btn--sm" onClick={() => fgRef.current?.zoomToFit(400, 40)}
          title={t(language, 'ivGraphZoomFit')}>
          <i className="bi bi-arrows-fullscreen icon--mr4" />{t(language, 'ivGraphZoomFit')}
        </button>
        <button type="button" className="btn btn--sm" onClick={() => {
          const fg = fgRef.current; if (!fg) return
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          fg.graphData().nodes.forEach((n: any) => { n.fx = undefined; n.fy = undefined })
          fg.d3ReheatSimulation()
        }} title={t(language, 'ivGraphReheat')}>
          <i className="bi bi-arrow-clockwise icon--mr4" />{t(language, 'ivGraphReheat')}
        </button>
        <button type="button" className="btn btn--sm" onClick={() => {
          const fg = fgRef.current; if (!fg) return
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          fg.graphData().nodes.forEach((n: any) => { n.fx = n.x; n.fy = n.y })
        }} title={t(language, 'ivGraphPinAll')}>
          <i className="bi bi-pin-angle-fill icon--mr4" />{t(language, 'ivGraphPinAll')}
        </button>
        <button type="button" className="btn btn--sm" onClick={() => {
          const fg = fgRef.current; if (!fg) return
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          fg.graphData().nodes.forEach((n: any) => { n.fx = undefined; n.fy = undefined })
          fg.d3ReheatSimulation()
        }} title={t(language, 'ivGraphUnpinAll')}>
          <i className="bi bi-pin-angle icon--mr4" />{t(language, 'ivGraphUnpinAll')}
        </button>
        <button type="button" className="btn btn--sm" onClick={exportPng} title={t(language, 'ivGraphExportPng')}>
          <i className="bi bi-download icon--mr4" />{t(language, 'ivGraphExportPng')}
        </button>
        <button type="button" className="btn btn--sm" onClick={() => setIsFullscreen((v) => !v)}
          title={isFullscreen ? t(language, 'ivGraphExitFullscreen') : t(language, 'ivGraphFullscreen')}>
          <i className={`bi ${isFullscreen ? 'bi-fullscreen-exit' : 'bi-fullscreen'} icon--mr4`} />
          {isFullscreen ? t(language, 'ivGraphExitFullscreen') : t(language, 'ivGraphFullscreen')}
        </button>

        <span style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: '4px' }}>
          <i className="bi bi-search" />
          <input
            type="text"
            placeholder={t(language, 'ivGraphSearchPlaceholder')}
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            style={{ padding: '2px 6px', fontSize: '12px', width: '150px' }}
          />
        </span>
      </div>

      {/* Toolbar — Row 2: Sliders */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '12px', alignItems: 'center', marginTop: '6px', fontSize: '12px' }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
          {t(language, 'ivGraphLinkDist')}
          <input type="range" min={40} max={400} step={10} value={linkDistance}
            onChange={(e) => setLinkDistance(Number(e.target.value))}
            style={{ width: '80px' }} />
          <span style={{ minWidth: '28px', textAlign: 'right' }}>{linkDistance}</span>
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
          {t(language, 'ivGraphCharge')}
          <input type="range" min={-800} max={-50} step={10} value={chargeStrength}
            onChange={(e) => setChargeStrength(Number(e.target.value))}
            style={{ width: '80px' }} />
          <span style={{ minWidth: '36px', textAlign: 'right' }}>{chargeStrength}</span>
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
          {t(language, 'ivGraphEdgeMin')}
          <input type="range" min={0} max={1} step={0.01} value={edgeMinThreshold}
            onChange={(e) => setEdgeMinThreshold(Number(e.target.value))}
            style={{ width: '80px' }} />
          <span style={{ minWidth: '32px', textAlign: 'right' }}>{edgeMinThreshold.toFixed(2)}</span>
        </label>
      </div>

      {/* Toolbar — Row 3: Modes & toggles */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '12px', alignItems: 'center', marginTop: '6px', fontSize: '12px' }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
          {t(language, 'ivGraphColorMode')}:
          <select value={colorMode} onChange={(e) => setColorMode(e.target.value as 'cluster' | 'count' | 'degree')}
            style={{ padding: '2px 4px', fontSize: '12px' }}>
            <option value="cluster">{t(language, 'ivGraphColorByCluster')}</option>
            <option value="count">{t(language, 'ivGraphColorByCount')}</option>
            <option value="degree">{t(language, 'ivGraphColorByDegree')}</option>
          </select>
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
          {t(language, 'ivGraphSizeMode')}:
          <select value={sizeMode} onChange={(e) => setSizeMode(e.target.value as 'count' | 'uniform' | 'degree')}
            style={{ padding: '2px 4px', fontSize: '12px' }}>
            <option value="count">{t(language, 'ivGraphSizeByCount')}</option>
            <option value="uniform">{t(language, 'ivGraphSizeUniform')}</option>
            <option value="degree">{t(language, 'ivGraphSizeByDegree')}</option>
          </select>
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
          {t(language, 'ivGraphLayoutTitle')}:
          <select value={layoutMode} onChange={(e) => setLayoutMode(e.target.value as 'force' | 'radial')}
            style={{ padding: '2px 4px', fontSize: '12px' }}>
            <option value="force">{t(language, 'ivGraphLayoutForce')}</option>
            <option value="radial">{t(language, 'ivGraphLayoutRadial')}</option>
          </select>
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
          <input type="checkbox" checked={showEdgeLabels} onChange={(e) => setShowEdgeLabels(e.target.checked)} />
          {t(language, 'ivGraphEdgeLabels')}
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
          <input type="checkbox" checked={enableParticles} onChange={(e) => setEnableParticles(e.target.checked)} />
          {t(language, 'ivGraphParticles')}
        </label>
      </div>

      {/* Force-directed graph + overlays */}
      <div style={{ position: 'relative', marginTop: '8px' }}>
        <div
          ref={graphContainerRef}
          style={{
            width: '100%',
            borderRadius: '6px',
            overflow: 'hidden',
            border: '1px solid var(--border, #333)',
            background: 'var(--panel, #1a1a1a)',
          }}
        />

        {/* Stats overlay (top-left) */}
        <div style={{
          position: 'absolute', top: '8px', left: '8px',
          background: 'rgba(20,20,20,0.75)', color: '#eee',
          padding: '6px 10px', borderRadius: '4px', fontSize: '11px',
          fontFamily: 'monospace', lineHeight: 1.5,
          backdropFilter: 'blur(4px)',
          border: '1px solid rgba(255,255,255,0.1)',
          pointerEvents: 'none',
        }}>
          <div>{t(language, 'ivGraphStatsNodes')}: <strong>{stats.n}</strong></div>
          <div>{t(language, 'ivGraphStatsEdges')}: <strong>{stats.e}</strong></div>
          <div>{t(language, 'ivGraphStatsDensity')}: <strong>{(stats.density * 100).toFixed(1)}%</strong></div>
          <div>{t(language, 'ivGraphStatsAvgSim')}: <strong>{stats.avgSim.toFixed(3)}</strong></div>
          <div>{t(language, 'ivGraphStatsMaxSim')}: <strong>{stats.maxSim.toFixed(3)}</strong></div>
          {stats.isolated > 0 && (
            <div style={{ color: '#f59f00' }}>{t(language, 'ivGraphStatsIsolated')}: <strong>{stats.isolated}</strong></div>
          )}
        </div>

        {/* Selected node detail panel (top-right) */}
        {selectedDetail && (
          <div style={{
            position: 'absolute', top: '8px', right: '8px',
            width: 'min(320px, calc(100% - 24px))',
            maxHeight: 'calc(100% - 24px)', overflow: 'auto',
            background: 'rgba(20,20,20,0.92)', color: '#eee',
            padding: '10px 12px', borderRadius: '6px', fontSize: '12px',
            backdropFilter: 'blur(6px)',
            border: `2px solid ${colorOf(selectedDetail.node.id)}`,
            boxShadow: '0 4px 16px rgba(0,0,0,0.4)',
          }}>
            <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '6px' }}>
              <div>
                <div style={{ fontSize: '10px', opacity: 0.6, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                  {t(language, 'ivGraphSelectedTitle')}
                </div>
                <div style={{ fontWeight: 600, fontSize: '14px', marginTop: '2px' }}>
                  <span style={{ color: colorOf(selectedDetail.node.id), marginRight: '6px' }}>●</span>
                  {labelMap(selectedDetail.node.id)}
                </div>
              </div>
              <button type="button" onClick={() => setSelectedNodeId(null)}
                style={{ background: 'none', border: 'none', color: '#aaa', cursor: 'pointer', fontSize: '14px', padding: 0 }}
                title={t(language, 'ivGraphSelectedClose')}>
                <i className="bi bi-x-lg" />
              </button>
            </div>
            <div style={{ display: 'flex', gap: '12px', marginTop: '6px', fontSize: '11px', opacity: 0.85 }}>
              <span>{t(language, 'ivGraphNodeDocs')}: <strong>{selectedDetail.node.count}</strong></span>
              <span>{t(language, 'ivGraphSelectedDegree')}: <strong>{selectedDetail.degree}</strong></span>
              {selectedDetail.bridgeCount > 0 && (
                <span style={{ color: '#f59f00' }}>🔗 <strong>{selectedDetail.bridgeCount}</strong></span>
              )}
            </div>
            {selectedDetail.summary?.summary && (
              <div style={{ marginTop: '8px' }}>
                <div style={{ fontSize: '10px', opacity: 0.6, textTransform: 'uppercase', marginBottom: '2px' }}>
                  {t(language, 'ivGraphSelectedSummary')}
                </div>
                <div style={{ fontSize: '11px', lineHeight: 1.4 }}>{selectedDetail.summary.summary}</div>
              </div>
            )}
            {selectedDetail.summary?.keywords && selectedDetail.summary.keywords.length > 0 && (
              <div style={{ marginTop: '8px' }}>
                <div style={{ fontSize: '10px', opacity: 0.6, textTransform: 'uppercase', marginBottom: '4px' }}>
                  {t(language, 'ivGraphSelectedKeywords')}
                </div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px' }}>
                  {selectedDetail.summary.keywords.slice(0, 8).map((kw, i) => (
                    <span key={i} style={{
                      padding: '1px 6px', borderRadius: '3px', fontSize: '10px',
                      background: 'rgba(255,255,255,0.08)', border: '1px solid rgba(255,255,255,0.12)',
                    }}>{kw}</span>
                  ))}
                </div>
              </div>
            )}
            {selectedDetail.neighbors.length > 0 && (
              <div style={{ marginTop: '8px' }}>
                <div style={{ fontSize: '10px', opacity: 0.6, textTransform: 'uppercase', marginBottom: '4px' }}>
                  {t(language, 'ivGraphSelectedNeighbors')} ({selectedDetail.neighbors.length})
                </div>
                <div style={{ maxHeight: '120px', overflow: 'auto' }}>
                  {selectedDetail.neighbors.slice(0, 10).map((n) => (
                    <div key={n.clusterId}
                      onClick={() => {
                        setSelectedNodeId(null)
                        setSelectedEdgeKey(graphEdgeKey(selectedDetail.node.id, n.clusterId))
                      }}
                      style={{
                        display: 'grid', gridTemplateColumns: '1fr auto', gap: '6px', alignItems: 'center',
                        padding: '3px 4px', borderRadius: '3px', cursor: 'pointer', fontSize: '11px',
                      }}
                      onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(255,255,255,0.08)' }}
                      onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent' }}>
                      <span style={{ minWidth: 0 }}>
                        <span style={{ color: colorOf(n.clusterId), marginRight: '4px' }}>●</span>
                        <span>{labelMap(n.clusterId)}</span>
                        <span style={{ display: 'block', opacity: 0.55, fontSize: '10px', marginLeft: '14px' }}>
                          {edgeRelationLabel(language, n.edge)} / {edgeConfidenceLabel(language, n.edge.confidence)}
                        </span>
                      </span>
                      <span style={{ opacity: 0.7, fontFamily: 'monospace', whiteSpace: 'nowrap' }}>{n.similarity.toFixed(3)}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
            {onBrowseCluster && (
              <button type="button" className="btn btn--sm btn--primary"
                onClick={() => onBrowseCluster(selectedDetail.node.id)}
                style={{ marginTop: '10px', width: '100%', fontSize: '11px' }}>
                <i className="bi bi-list-ul icon--mr4" />
                {t(language, 'ivGraphSelectedBrowseDocs')}
              </button>
            )}
          </div>
        )}

        {/* Selected edge detail panel (top-right) */}
        {selectedEdgeDetail && (
          <div style={{
            position: 'absolute', top: '8px', right: '8px',
            width: 'min(360px, calc(100% - 24px))',
            maxHeight: 'calc(100% - 24px)', overflow: 'auto',
            background: 'rgba(20,20,20,0.94)', color: '#eee',
            padding: '10px 12px', borderRadius: '6px', fontSize: '12px',
            backdropFilter: 'blur(6px)',
            border: `2px solid ${edgeColorForConfidence(selectedEdgeDetail.edge.confidence)}`,
            boxShadow: '0 4px 16px rgba(0,0,0,0.4)',
          }}>
            <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '8px' }}>
              <div>
                <div style={{ fontSize: '10px', opacity: 0.6, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                  {t(language, 'ivGraphSelectedEdgeTitle')}
                </div>
                <div style={{ fontWeight: 650, fontSize: '13px', marginTop: '3px', lineHeight: 1.35 }}>
                  {selectedEdgeDetail.sourceLabel} ↔ {selectedEdgeDetail.targetLabel}
                </div>
              </div>
              <button type="button" onClick={() => setSelectedEdgeKey(null)}
                style={{ background: 'none', border: 'none', color: '#aaa', cursor: 'pointer', fontSize: '14px', padding: 0 }}
                title={t(language, 'ivGraphSelectedClose')}>
                <i className="bi bi-x-lg" />
              </button>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '6px 10px', marginTop: '8px', fontSize: '11px' }}>
              <div>{t(language, 'ivGraphSimilarity')}: <strong>{selectedEdgeDetail.edge.similarity.toFixed(3)}</strong></div>
              <div>{t(language, 'ivGraphEdgeSimilarityBand')}: <strong>{edgeSimilarityBandLabel(language, selectedEdgeDetail.edge.similarity)}</strong></div>
              <div>{t(language, 'ivGraphEdgeConfidence')}: <strong>{edgeConfidenceLabel(language, selectedEdgeDetail.edge.confidence)}</strong></div>
              <div>{t(language, 'ivGraphEdgeRelation')}: <strong>{edgeRelationLabel(language, selectedEdgeDetail.edge)}</strong></div>
              <div>{t(language, 'ivGraphNodeDocs')}: <strong>{selectedEdgeDetail.sourceCount} / {selectedEdgeDetail.targetCount}</strong></div>
            </div>

            {selectedEdgeDetail.edge.relationKind === 'candidate' && (
              <div style={{ marginTop: '8px', padding: '6px 8px', borderRadius: '4px', background: 'rgba(245,159,0,0.12)', border: '1px solid rgba(245,159,0,0.35)', fontSize: '11px', lineHeight: 1.4 }}>
                {t(language, 'ivGraphEdgeCentroidOnly')}
              </div>
            )}

            {selectedEdgeDetail.edge.reasons && selectedEdgeDetail.edge.reasons.length > 0 && (
              <div style={{ marginTop: '8px' }}>
                <div style={{ fontSize: '10px', opacity: 0.6, textTransform: 'uppercase', marginBottom: '4px' }}>
                  {t(language, 'ivGraphEdgeReasons')}
                </div>
                <ul style={{ margin: 0, paddingLeft: '16px', fontSize: '11px', lineHeight: 1.45 }}>
                  {selectedEdgeDetail.edge.reasons.slice(0, 6).map((reason, index) => (
                    <li key={`${reason.kind}-${index}`}>{edgeReasonText(reason, language)}</li>
                  ))}
                </ul>
              </div>
            )}

            {selectedEdgeDetail.edge.sharedFacets && selectedEdgeDetail.edge.sharedFacets.length > 0 && (
              <div style={{ marginTop: '8px' }}>
                <div style={{ fontSize: '10px', opacity: 0.6, textTransform: 'uppercase', marginBottom: '4px' }}>
                  {t(language, 'ivGraphEdgeSharedFacets')}
                </div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px' }}>
                  {selectedEdgeDetail.edge.sharedFacets.slice(0, 6).map((facet) => (
                    <span key={facet} style={{ padding: '1px 6px', borderRadius: '3px', fontSize: '10px', background: 'rgba(53,199,164,0.12)', border: '1px solid rgba(53,199,164,0.28)' }}>{facet}</span>
                  ))}
                </div>
              </div>
            )}

            {selectedEdgeDetail.edge.sharedKeywords && selectedEdgeDetail.edge.sharedKeywords.length > 0 && (
              <div style={{ marginTop: '8px' }}>
                <div style={{ fontSize: '10px', opacity: 0.6, textTransform: 'uppercase', marginBottom: '4px' }}>
                  {t(language, 'ivGraphEdgeSharedKeywords')}
                </div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px' }}>
                  {selectedEdgeDetail.edge.sharedKeywords.slice(0, 8).map((keyword) => (
                    <span key={keyword} style={{ padding: '1px 6px', borderRadius: '3px', fontSize: '10px', background: 'rgba(91,157,255,0.12)', border: '1px solid rgba(91,157,255,0.28)' }}>{keyword}</span>
                  ))}
                </div>
              </div>
            )}

            {selectedEdgeDetail.bridgeDocs.length > 0 && (
              <div style={{ marginTop: '8px' }}>
                <div style={{ fontSize: '10px', opacity: 0.6, textTransform: 'uppercase', marginBottom: '4px' }}>
                  {t(language, 'ivGraphEdgeBridgeDocs')}
                </div>
                <div style={{ display: 'grid', gap: '3px', fontSize: '11px', lineHeight: 1.35 }}>
                  {selectedEdgeDetail.bridgeDocs.map((doc) => (
                    <div key={doc.id} style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={doc.title || doc.id}>
                      {doc.title || doc.id}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {/* Color legend (bottom-left) — only for heat modes */}
        {colorMode !== 'cluster' && (
          <div style={{
            position: 'absolute', bottom: '8px', left: '8px',
            background: 'rgba(20,20,20,0.75)', color: '#eee',
            padding: '4px 8px', borderRadius: '4px', fontSize: '10px',
            fontFamily: 'monospace',
            backdropFilter: 'blur(4px)',
            border: '1px solid rgba(255,255,255,0.1)',
            display: 'flex', alignItems: 'center', gap: '6px',
            pointerEvents: 'none',
          }}>
            <span>0</span>
            <div style={{
              width: '120px', height: '8px', borderRadius: '2px',
              background: 'linear-gradient(to right, #2c5aa0, #00aaff, #00ff88, #ffdd00, #ff4444)',
            }} />
            <span>{colorMode === 'count' ? maxCount : maxDegree}</span>
          </div>
        )}
      </div>

      {/* Related Clusters Table */}
      <div style={{ marginTop: '12px' }}>
        <div className="section__subtitle" style={{ marginBottom: '6px' }}>
          <i className="bi bi-link-45deg icon--mr6" />
          {t(language, 'ivGraphRelatedTitle')}
        </div>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', fontSize: '12px', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ borderBottom: '1px solid var(--color-border, #444)' }}>
                <th style={{ padding: '4px 8px', textAlign: 'left' }}>{t(language, 'ivGraphColCluster')}</th>
                <th style={{ padding: '4px 8px', textAlign: 'right' }}>{t(language, 'ivGraphColDocs')}</th>
                <th style={{ padding: '4px 8px', textAlign: 'left' }}>{t(language, 'ivGraphColRelated')}</th>
              </tr>
            </thead>
            <tbody>
              {relatedClusters.map((rc) => (
                <tr key={rc.id}
                  onClick={() => {
                    setSelectedEdgeKey(null)
                    setSelectedNodeId(rc.id)
                  }}
                  style={{
                    borderBottom: '1px solid var(--color-border, #333)',
                    background: selectedNodeId === rc.id ? 'rgba(120,180,255,0.08)' : undefined,
                    cursor: 'pointer',
                  }}>
                  <td style={{ padding: '4px 8px' }}>
                    <span style={{ color: CLUSTER_COLORS[rc.id % CLUSTER_COLORS.length], marginRight: '6px' }}>●</span>
                    {rc.label}
                  </td>
                  <td style={{ padding: '4px 8px', textAlign: 'right' }}>{rc.count}</td>
                  <td style={{ padding: '4px 8px', fontSize: '11px' }}>
                    {rc.neighbors.length > 0
                      ? rc.neighbors.map((n) => `${labelMap(n.clusterId)} (${n.similarity.toFixed(3)}, ${edgeConfidenceLabel(language, n.edge.confidence)})`).join(', ')
                      : <span style={{ opacity: 0.5 }}>—</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Bridge Nodes */}
      {bridges.length > 0 && (
        <div style={{ marginTop: '12px' }}>
          <div className="section__subtitle" style={{ marginBottom: '6px' }}>
            <i className="bi bi-shuffle icon--mr6" />
            {t(language, 'ivGraphBridgeTitle')}
          </div>
          <div className="app__hint" style={{ marginBottom: '6px' }}>
            {t(language, 'ivGraphBridgeDescription')}
          </div>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', fontSize: '12px', borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ borderBottom: '1px solid var(--color-border, #444)' }}>
                  <th style={{ padding: '4px 8px', textAlign: 'left' }}>ID</th>
                  <th style={{ padding: '4px 8px', textAlign: 'left' }}>{t(language, 'ivGraphBridgeOwn')}</th>
                  <th style={{ padding: '4px 8px', textAlign: 'left' }}>{t(language, 'ivGraphBridgeNearest')}</th>
                  <th style={{ padding: '4px 8px', textAlign: 'right' }}>{t(language, 'ivGraphSimilarity')}</th>
                </tr>
              </thead>
              <tbody>
                {bridges.slice(0, 10).map((br, idx) => (
                  <tr key={idx} style={{ borderBottom: '1px solid var(--color-border, #333)' }}>
                    <td style={{ padding: '4px 8px', fontFamily: 'monospace', fontSize: '11px' }}>
                      {truncate(data?.docs[br.docIndex]?.id ?? String(br.docIndex), 30)}
                    </td>
                    <td style={{ padding: '4px 8px' }}>
                      <span style={{ color: CLUSTER_COLORS[br.ownCluster % CLUSTER_COLORS.length], marginRight: '4px' }}>●</span>
                      {labelMap(br.ownCluster)}
                    </td>
                    <td style={{ padding: '4px 8px' }}>
                      <span style={{ color: CLUSTER_COLORS[br.nearestCluster % CLUSTER_COLORS.length], marginRight: '4px' }}>●</span>
                      {labelMap(br.nearestCluster)}
                    </td>
                    <td style={{ padding: '4px 8px', textAlign: 'right' }}>
                      {br.similarityToNearest.toFixed(4)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {bridges.length > 10 && (
              <div style={{ opacity: 0.5, fontSize: '11px', padding: '4px 8px' }}>
                {t(language, 'ivMoreDocs').replace('{n}', String(bridges.length - 10))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

// ============================================================================
// 2-Stage Search Results
// ============================================================================

function TwoStageSearchResults({ result, language }: {
  result: import('../../lib/metaIndex').TwoStageSearchResult
  language: Language
}) {
  return (
    <div style={{ marginTop: '16px' }}>
      {/* Stats */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))',
        gap: '8px',
        marginBottom: '16px',
      }}>
        <StatCard label={t(language, 'ivSearchSpaceReduction')} value={`${result.stats.searchSpaceReduction}%`} />
        <StatCard label={t(language, 'ivSearchGlobalTime')} value={`${result.stats.globalSearchTimeMs}ms`} />
        <StatCard label={t(language, 'ivSearchLocalTime')} value={`${result.stats.localSearchTimeMs}ms`} />
        <StatCard label={t(language, 'ivSearchTotalTime')} value={`${result.stats.totalTimeMs}ms`} />
      </div>

      {/* Global results - clusters */}
      <div className="section__subtitle" style={{ marginBottom: '6px' }}>
        <i className="bi bi-globe icon--mr6" />
        {t(language, 'ivSearchGlobalTitle')}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', marginBottom: '16px' }}>
        {result.clusters.map((c, idx) => (
          <div
            key={c.clusterId}
            style={{
              background: 'var(--panel2)',
              borderRadius: '8px',
              padding: '8px 12px',
              borderLeft: `3px solid ${CLUSTER_COLORS[idx % CLUSTER_COLORS.length]}`,
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span style={{ fontWeight: 600 }}>{c.label}</span>
              <span style={{ fontSize: '11px', opacity: 0.6 }}>
                score: {c.score.toFixed(4)} | {c.documentCount} docs
              </span>
            </div>
            <div style={{ fontSize: '12px', opacity: 0.8, marginTop: '2px' }}>
              {c.summary}
            </div>
          </div>
        ))}
        {result.clusters.length === 0 && (
          <div style={{ opacity: 0.5, fontStyle: 'italic' }}>No matching clusters found.</div>
        )}
      </div>

      {/* Local results - documents */}
      <div className="section__subtitle" style={{ marginBottom: '6px' }}>
        <i className="bi bi-file-earmark-text icon--mr6" />
        {t(language, 'ivSearchLocalTitle')}
      </div>
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', fontSize: '12px', borderCollapse: 'collapse' }}>
          <thead>
            <tr style={{ borderBottom: '1px solid var(--color-border, #444)' }}>
              <th style={{ padding: '4px 8px', textAlign: 'left' }}>#</th>
              <th style={{ padding: '4px 8px', textAlign: 'left' }}>ID</th>
              <th style={{ padding: '4px 8px', textAlign: 'right' }}>Score</th>
              <th style={{ padding: '4px 8px', textAlign: 'left' }}>Fields</th>
            </tr>
          </thead>
          <tbody>
            {result.documents.map((doc, idx) => (
              <tr key={doc.id || idx} style={{ borderBottom: '1px solid var(--color-border, #333)' }}>
                <td style={{ padding: '4px 8px', opacity: 0.5 }}>{idx + 1}</td>
                <td style={{ padding: '4px 8px', fontFamily: 'monospace', fontSize: '11px' }}>
                  {truncate(doc.id, 30)}
                </td>
                <td style={{ padding: '4px 8px', textAlign: 'right' }}>
                  {doc.score.toFixed(4)}
                </td>
                <td style={{ padding: '4px 8px', fontSize: '11px', maxWidth: '400px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {summarizeFields(doc.fields)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {result.documents.length === 0 && (
          <div style={{ opacity: 0.5, fontStyle: 'italic', padding: '8px' }}>No documents found.</div>
        )}
      </div>
    </div>
  )
}

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <div style={{
      background: 'var(--panel2)',
      borderRadius: '6px',
      padding: '8px 12px',
      textAlign: 'center',
    }}>
      <div style={{ fontSize: '18px', fontWeight: 700 }}>{value}</div>
      <div style={{ fontSize: '11px', opacity: 0.6 }}>{label}</div>
    </div>
  )
}

// ============================================================================
// Cluster Document Browser
// ============================================================================

const DOCS_PER_PAGE = 20

function ClusterDocBrowser({ data, clusterId, page, onPageChange, onClose, language, clusterSummariesFromMeta, titleFieldName }: {
  data: VisualizationData | null
  clusterId: number
  page: number
  onPageChange: (p: number) => void
  onClose: () => void
  language: Language
  clusterSummariesFromMeta?: ClusterSummary[] | null
  titleFieldName?: string
}) {
  // Collect documents from local scan data (if available)
  const localDocs = useMemo(() => {
    if (!data) return []
    const result: Array<{ id: string; title: string; index: number }> = []
    const labels = data.cluster.labels
    for (let i = 0; i < labels.length; i++) {
      if (labels[i] === clusterId) {
        result.push({ id: data.docs[i].id, title: data.docs[i].title, index: i })
      }
    }
    return result
  }, [data, clusterId])

  // Collect ALL member doc IDs from meta-index summaries (comprehensive list)
  const allMemberDocIds = useMemo(() => {
    const summary = clusterSummariesFromMeta?.[clusterId]
    if (!summary?.memberDocIds || summary.memberDocIds.length === 0) return null
    return summary.memberDocIds
  }, [clusterSummariesFromMeta, clusterId])

  // Determine the display list: prefer local scanned docs, fall back to memberDocIds
  const displayDocs = useMemo(() => {
    if (localDocs.length > 0) return localDocs.map((d) => ({ id: d.id, title: d.title }))
    if (allMemberDocIds) return allMemberDocIds.map((id) => ({ id, title: '' }))
    return []
  }, [localDocs, allMemberDocIds])

  const totalPages = Math.max(1, Math.ceil(displayDocs.length / DOCS_PER_PAGE))
  const currentPage = Math.min(page, totalPages - 1)
  const pageStart = currentPage * DOCS_PER_PAGE
  const pageDocs = displayDocs.slice(pageStart, pageStart + DOCS_PER_PAGE)
  const clusterLabel = clusterSummariesFromMeta?.[clusterId]?.label ?? `Cluster ${clusterId}`

  const hasTitle = localDocs.length > 0

  // ─── Resizable column widths (same pattern as EdgResultsTable) ─────────
  const COL_MIN = 60
  const COL_MAX = 1000

  type ColKey = '#' | 'id' | 'title'
  const defaultWidths: Record<ColKey, number> = useMemo(() => ({
    '#': 48,
    id: 100,
    title: 500,
  }), [])

  const [colWidths, setColWidths] = useState<Record<string, number>>({})
  const effectiveWidths = useMemo(() => {
    const out: Record<string, number> = {}
    for (const k of Object.keys(defaultWidths)) out[k] = colWidths[k] ?? defaultWidths[k as ColKey]
    return out
  }, [colWidths, defaultWidths])

  const dragState = useRef<{ key: string; startX: number; startWidth: number } | null>(null)
  const [activeResizer, setActiveResizer] = useState<string | null>(null)
  const tableRef = useRef<HTMLTableElement>(null)

  const onResizerDoubleClick = useCallback(
    (key: string) => () => {
      const table = tableRef.current
      if (!table) return
      const colKeys = hasTitle ? ['#', 'id', 'title'] : ['#', 'id']
      const colIdx = colKeys.indexOf(key)
      if (colIdx < 0) return
      let maxW = COL_MIN
      const cells = table.querySelectorAll<HTMLElement>(
        `thead th:nth-child(${colIdx + 1}), tbody td:nth-child(${colIdx + 1})`,
      )
      cells.forEach((cell) => {
        const prev = cell.style.width
        cell.style.width = 'auto'
        maxW = Math.max(maxW, cell.scrollWidth + 2)
        cell.style.width = prev
      })
      setColWidths((prev) => ({ ...prev, [key]: Math.min(COL_MAX, maxW) }))
    },
    [hasTitle],
  )

  const onResizerPointerDown = useCallback(
    (key: string) => (e: React.PointerEvent<HTMLDivElement>) => {
      e.preventDefault()
      dragState.current = { key, startX: e.clientX, startWidth: effectiveWidths[key] ?? COL_MIN }
      setActiveResizer(key)
      const target = e.currentTarget
      target.setPointerCapture(e.pointerId)

      const onMove = (ev: PointerEvent) => {
        const s = dragState.current
        if (!s) return
        const delta = ev.clientX - s.startX
        const next = Math.max(COL_MIN, Math.min(COL_MAX, s.startWidth + delta))
        setColWidths((prev) => (prev[s.key] === next ? prev : { ...prev, [s.key]: next }))
      }
      const onUp = () => {
        dragState.current = null
        setActiveResizer(null)
        target.removeEventListener('pointermove', onMove)
        target.removeEventListener('pointerup', onUp)
        target.removeEventListener('pointercancel', onUp)
      }
      target.addEventListener('pointermove', onMove)
      target.addEventListener('pointerup', onUp)
      target.addEventListener('pointercancel', onUp)
    },
    [effectiveWidths],
  )

  const colKeys: ColKey[] = hasTitle ? ['#', 'id', 'title'] : ['#', 'id']
  const titleHeader = titleFieldName || 'Title'
  const colTitles: Record<ColKey, string> = { '#': '#', id: 'ID', title: titleHeader }

  return (
    <div className="section" style={{ marginTop: '16px' }}>
      <div className="section__title" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span>
          <i className="bi bi-list-ul icon--mr6" />
          {t(language, 'ivClusterDocsTitle')}
        </span>
        <button type="button" className="btn btn--secondary btn--sm" onClick={onClose}>
          <i className="bi bi-x-lg" />
        </button>
      </div>
      <div className="app__hint">
        {t(language, 'ivClusterDocsDescription')
          .replace('{label}', clusterLabel)
          .replace('{count}', String(displayDocs.length))}
      </div>

      {/* Document table */}
      <div className="edgResults__tableWrap" style={{ marginTop: '8px' }}>
        <table className="spvTable edgResults__table" ref={tableRef}>
          <colgroup>
            {colKeys.map((k) => (
              <col key={k} style={{ width: `${effectiveWidths[k]}px` }} />
            ))}
          </colgroup>
          <thead>
            <tr>
              {colKeys.map((k) => (
                <th key={k} className={k === 'id' ? 'edgMono' : undefined} title={colTitles[k]}>
                  {colTitles[k]}
                  <div
                    className={`edgColResizer${activeResizer === k ? ' edgColResizer--active' : ''}`}
                    onPointerDown={onResizerPointerDown(k)}
                    onDoubleClick={onResizerDoubleClick(k)}
                  />
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {pageDocs.map((doc, idx) => (
              <tr key={doc.id}>
                <td className="edgMono" style={{ opacity: 0.5 }}>{pageStart + idx + 1}</td>
                <td className="edgMono" title={doc.id}>{doc.id}</td>
                {hasTitle && (
                  <td className="edgCell--wrap" title={doc.title}>{truncate(doc.title, 120)}</td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginTop: '8px' }}>
          <button
            type="button"
            className="btn btn--secondary btn--sm"
            disabled={currentPage <= 0}
            onClick={() => onPageChange(currentPage - 1)}
          >
            ←
          </button>
          <span style={{ fontSize: '12px' }}>
            {t(language, 'ivClusterDocsPage')} {currentPage + 1} / {totalPages}
          </span>
          <button
            type="button"
            className="btn btn--secondary btn--sm"
            disabled={currentPage >= totalPages - 1}
            onClick={() => onPageChange(currentPage + 1)}
          >
            →
          </button>
        </div>
      )}
    </div>
  )
}

function summarizeFields(fields: Record<string, JsonValue>): string {
  const entries = Object.entries(fields)
    .filter(([k]) => !k.startsWith('@'))
    .slice(0, 3)
  return entries
    .map(([k, v]) => {
      const val = typeof v === 'string' ? v.slice(0, 60) : JSON.stringify(v)?.slice(0, 40) ?? ''
      return `${k}: ${val}`
    })
    .join(' | ')
}
