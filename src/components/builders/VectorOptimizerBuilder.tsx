/**
 * Vector indexing optimizer helper.
 *
 * Estimates storage impact and provides quick comparisons for vector-related
 * options (e.g., quantization and rescoring).
 */

import { useMemo, useState } from 'react'

import { translations } from '../../lib/translations'
import { buildAadCliCommand, buildLlmAuthHeaders, type LlmAuthMode } from '../../lib/llmAuth'

type TranslationKey = keyof typeof translations.ja

type QuantizationKind = 'none' | 'scalarQuantization' | 'binaryQuantization'

type FloatType = 'float32' | 'float16'

type RescoreStorageMethod = 'preserveOriginals' | 'discardOriginals'

type SizeBreakdown = {
  indexBytes: number
  sourceBytes: number
  originalsBytes: number
  totalBytes: number
}

function formatBytes(n: number): string {
  if (!Number.isFinite(n)) return '-'
  const abs = Math.abs(n)
  if (abs < 1024) return `${n.toFixed(0)} B`
  if (abs < 1024 * 1024) return `${(n / 1024).toFixed(2)} KB`
  if (abs < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(2)} MB`
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`
}

function bytesPerFloatType(t: FloatType): number {
  return t === 'float16' ? 2 : 4
}

function clampPositiveInt(v: number | null, max?: number): number | null {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null
  const n = Math.floor(v)
  if (n <= 0) return null
  if (typeof max === 'number' && Number.isFinite(max)) return Math.min(n, max)
  return n
}

function computeBytes(args: {
  dims: number
  floatType: FloatType
  quantization: QuantizationKind
  stored: boolean
  enableRescoring: boolean
  binaryRescoreStorageMethod: RescoreStorageMethod
}): SizeBreakdown {
  const { dims, floatType, quantization, stored, enableRescoring, binaryRescoreStorageMethod } = args

  const baseBytesPerComponent = bytesPerFloatType(floatType)
  const fullPrecisionBytes = dims * baseBytesPerComponent

  // Index representation (ANN graph / eKNN index)
  let indexBytes = fullPrecisionBytes
  if (quantization === 'scalarQuantization') {
    // float32/float16 -> int8 (1 byte/component)
    indexBytes = dims * 1
  } else if (quantization === 'binaryQuantization') {
    // float -> 1 bit/component, packed into bytes
    indexBytes = Math.ceil(dims / 8)
  }

  // Source vector (JSON) storage (controlled by stored)
  const sourceBytes = stored ? fullPrecisionBytes : 0

  // Original full-precision vector for rescoring (optional)
  let originalsBytes = 0
  if (quantization !== 'none' && enableRescoring) {
    if (quantization === 'scalarQuantization') {
      // Scalar rescoring requires preserveOriginals
      originalsBytes = fullPrecisionBytes
    } else if (quantization === 'binaryQuantization') {
      originalsBytes = binaryRescoreStorageMethod === 'preserveOriginals' ? fullPrecisionBytes : 0
    }
  }

  return {
    indexBytes,
    sourceBytes,
    originalsBytes,
    totalBytes: indexBytes + sourceBytes + originalsBytes,
  }
}

export function VectorOptimizerBuilder(props: {
  t: (key: TranslationKey) => string
  format: (key: TranslationKey, params: Record<string, string | number>) => string

  // Keep Vector Optimizer's Text-to-Vector independent from the Tools modal.
  // These are only used as initial values (not synchronized).
  defaultTextToVectorEndpoint?: string
  defaultTextToVectorApiKey?: string
  defaultTextToVectorAuthMode?: LlmAuthMode
  defaultTextToVectorBearerToken?: string
}) {
  const {
    t,
    format,
    defaultTextToVectorEndpoint,
    defaultTextToVectorApiKey,
    defaultTextToVectorAuthMode,
    defaultTextToVectorBearerToken,
  } = props

  // Local Text to Vector state (NOT shared with the Tools modal)
  const [textToVectorInput, setTextToVectorInput] = useState<string>('')
  const [textToVectorModel, setTextToVectorModel] = useState<string>('text-embedding-3-large')
  const [textToVectorEndpoint, setTextToVectorEndpoint] = useState<string>(() => defaultTextToVectorEndpoint ?? '')
  const [textToVectorApiKey, setTextToVectorApiKey] = useState<string>(() => defaultTextToVectorApiKey ?? '')
  const [textToVectorAuthMode, setTextToVectorAuthMode] = useState<LlmAuthMode>(() => defaultTextToVectorAuthMode ?? 'apiKey')
  const [textToVectorBearerToken, setTextToVectorBearerToken] = useState<string>(() => defaultTextToVectorBearerToken ?? '')
  const [cliCopied, setCliCopied] = useState<boolean>(false)
  const [textToVectorDimensions, setTextToVectorDimensions] = useState<number | null>(null)
  const [textToVectorResult, setTextToVectorResult] = useState<number[] | null>(null)
  const [textToVectorLoading, setTextToVectorLoading] = useState<boolean>(false)

  async function onCopyCliCommand() {
    try {
      await navigator.clipboard.writeText(buildAadCliCommand())
      setCliCopied(true)
      window.setTimeout(() => setCliCopied(false), 1500)
    } catch {
      // ignore
    }
  }

  async function onGenerateVector() {
    if (!textToVectorInput.trim()) {
      alert(String(t('textToVectorAlertEnterText')))
      return
    }
    if (!textToVectorEndpoint.trim()) {
      alert(String(t('textToVectorAlertEnterEndpoint')))
      return
    }
    if (textToVectorAuthMode === 'apiKey' && !textToVectorApiKey.trim()) {
      alert(String(t('textToVectorAlertEnterApiKey')))
      return
    }
    if (textToVectorAuthMode === 'bearer' && !textToVectorBearerToken.trim()) {
      alert(String(t('textToVectorAlertEnterBearerToken')))
      return
    }

    setTextToVectorLoading(true)
    setTextToVectorResult(null)

    try {
      const endpoint = textToVectorEndpoint.replace(/\/+$/, '')
      const url = `${endpoint}/openai/v1/embeddings`

      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        ...buildLlmAuthHeaders(
          textToVectorAuthMode === 'bearer'
            ? { mode: 'bearer', bearerToken: textToVectorBearerToken }
            : { mode: 'apiKey', apiKey: textToVectorApiKey },
        ),
      }

      const response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          input: textToVectorInput,
          model: textToVectorModel,
          ...(typeof textToVectorDimensions === 'number' &&
          Number.isFinite(textToVectorDimensions) &&
          textToVectorDimensions > 0
            ? { dimensions: Math.floor(textToVectorDimensions) }
            : {}),
        }),
      })

      if (!response.ok) {
        const errorText = await response.text()
        throw new Error(format('voEmbeddingError', { status: response.status, errorText }))
      }

      const data = await response.json()
      const embedding = data?.data?.[0]?.embedding

      if (!Array.isArray(embedding)) {
        throw new Error(String(t('voInvalidResponseFormat')))
      }

      setTextToVectorResult(embedding)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      alert(String(t('error')) + ': ' + msg)
    } finally {
      setTextToVectorLoading(false)
    }
  }

  const [floatType, setFloatType] = useState<FloatType>('float32')
  const [quantization, setQuantization] = useState<QuantizationKind>('scalarQuantization')
  const [stored, setStored] = useState<boolean>(true)
  const [enableRescoring, setEnableRescoring] = useState<boolean>(true)
  const [binaryRescoreStorageMethod, setBinaryRescoreStorageMethod] = useState<RescoreStorageMethod>('discardOriginals')
  const [truncationDimensionRaw, setTruncationDimensionRaw] = useState<string>('')

  const inputDimensions = textToVectorResult?.length ?? null

  const truncationDimension = useMemo(() => {
    const max = inputDimensions ?? undefined
    const parsed = truncationDimensionRaw.trim() ? Number(truncationDimensionRaw) : null
    return clampPositiveInt(parsed, max)
  }, [truncationDimensionRaw, inputDimensions])

  const dimsUsed = useMemo(() => {
    if (!inputDimensions) return null
    return truncationDimension ?? inputDimensions
  }, [inputDimensions, truncationDimension])

  const comparison = useMemo(() => {
    if (!inputDimensions) return null

    const baseDims = inputDimensions
    const maybeTruncatedDims = truncationDimension ?? baseDims

    const baseline = computeBytes({
      dims: baseDims,
      floatType,
      quantization: 'none',
      stored: true,
      enableRescoring: false,
      binaryRescoreStorageMethod: 'discardOriginals',
    })

    const scenarios: Array<{ id: string; label: string; bytes: SizeBreakdown }> = []

    // Represent typical patterns from the doc page (kept minimal)
    scenarios.push({
      id: 'baseline',
      label: String(t('voScenarioBaseline')),
      bytes: baseline,
    })

    scenarios.push({
      id: 'scalar',
      label: String(t('voScenarioScalar')),
      bytes: computeBytes({
        dims: baseDims,
        floatType,
        quantization: 'scalarQuantization',
        stored: true,
        enableRescoring: true,
        binaryRescoreStorageMethod: 'discardOriginals',
      }),
    })

    scenarios.push({
      id: 'scalar-nostore',
      label: String(t('voScenarioScalarNoStore')),
      bytes: computeBytes({
        dims: baseDims,
        floatType,
        quantization: 'scalarQuantization',
        stored: false,
        enableRescoring: true,
        binaryRescoreStorageMethod: 'discardOriginals',
      }),
    })

    scenarios.push({
      id: 'binary-discard',
      label: String(t('voScenarioBinaryDiscard')),
      bytes: computeBytes({
        dims: baseDims,
        floatType,
        quantization: 'binaryQuantization',
        stored: true,
        enableRescoring: true,
        binaryRescoreStorageMethod: 'discardOriginals',
      }),
    })

    scenarios.push({
      id: 'binary-discard-nostore',
      label: String(t('voScenarioBinaryDiscardNoStore')),
      bytes: computeBytes({
        dims: baseDims,
        floatType,
        quantization: 'binaryQuantization',
        stored: false,
        enableRescoring: true,
        binaryRescoreStorageMethod: 'discardOriginals',
      }),
    })

    if (maybeTruncatedDims !== baseDims) {
      scenarios.push({
        id: 'binary-mrl',
        label: format('voScenarioBinaryMrl', { n: maybeTruncatedDims }),
        bytes: computeBytes({
          dims: maybeTruncatedDims,
          floatType,
          quantization: 'binaryQuantization',
          stored: true,
          enableRescoring: true,
          binaryRescoreStorageMethod: 'discardOriginals',
        }),
      })

      scenarios.push({
        id: 'binary-mrl-nostore',
        label: format('voScenarioBinaryMrlNoStore', { n: maybeTruncatedDims }),
        bytes: computeBytes({
          dims: maybeTruncatedDims,
          floatType,
          quantization: 'binaryQuantization',
          stored: false,
          enableRescoring: true,
          binaryRescoreStorageMethod: 'discardOriginals',
        }),
      })
    }

    // Current manual config (what the user set)
    scenarios.push({
      id: 'current',
      label: String(t('voScenarioCurrent')),
      bytes: computeBytes({
        dims: dimsUsed ?? baseDims,
        floatType,
        quantization,
        stored,
        enableRescoring,
        binaryRescoreStorageMethod,
      }),
    })

    return { baseDims, baseline, scenarios }
  }, [
    inputDimensions,
    truncationDimension,
    dimsUsed,
    floatType,
    quantization,
    stored,
    enableRescoring,
    binaryRescoreStorageMethod,
    t,
    format,
  ])

  const canUseTruncation = quantization !== 'none'
  const canUseRescoring = quantization !== 'none'
  const isBinary = quantization === 'binaryQuantization'

  return (
    <div className="section">
      <div className="section__title">{t('vectorOptimizer')}</div>
      <div className="section__hint">{t('voIntro')}</div>

      <div className="section">
        <div className="section__title">{t('voSizingBasisTitle')}</div>
        <div className="section__hint">{t('voSizingBasisHint')}</div>

        <pre className="mono" style={{ fontSize: 12, lineHeight: 1.6, whiteSpace: 'pre-wrap' }}>{t('voFormulaText')}</pre>

        <div className="notice notice--warning" role="status" aria-live="polite" style={{ marginTop: 12 }}>
          <div className="notice__title">{t('voOverheadTitle')}</div>
          <div className="notice__meta">{t('voOverheadHint')}</div>
        </div>
      </div>

      <div className="section" data-guide-target="vo-dimensions">
        <div className="section__title">{t('textToVector')}</div>

        <label className="field field--mb16">
          <span className="field__label">{t('textToVectorEndpointLabel')}</span>
          <input
            className="field__input"
            value={textToVectorEndpoint}
            onChange={(e) => setTextToVectorEndpoint(e.target.value)}
            placeholder={String(t('textToVectorEndpointPlaceholder'))}
            disabled={textToVectorLoading}
          />
        </label>

        <label className="field field--mb16">
          <span className="field__label">{t('llmAuthModeLabel')}</span>
          <select
            className="field__input"
            value={textToVectorAuthMode}
            onChange={(e) => setTextToVectorAuthMode(e.target.value === 'bearer' ? 'bearer' : 'apiKey')}
            disabled={textToVectorLoading}
          >
            <option value="apiKey">apiKey</option>
            <option value="bearer">bearer (Entra ID)</option>
          </select>
        </label>

        {textToVectorAuthMode === 'apiKey' ? (
          <label className="field field--mb16">
            <span className="field__label">
              {t('textToVectorApiKeyLabel')}
              <span className="infoTooltip infoTooltip--danger" title={String(t('textToVectorSecurityNoticeBody'))}>
                ⚠️
              </span>
            </span>
            <input
              className="field__input"
              type="password"
              value={textToVectorApiKey}
              onChange={(e) => setTextToVectorApiKey(e.target.value)}
              placeholder={String(t('textToVectorApiKeyPlaceholder'))}
              disabled={textToVectorLoading}
            />
          </label>
        ) : (
          <label className="field field--mb16">
            <span className="field__label">
              {t('llmBearerTokenLabel')}
              <span className="infoTooltip infoTooltip--danger" title={String(t('textToVectorSecurityNoticeBody'))}>
                ⚠️
              </span>
            </span>
            <input
              className="field__input"
              type="password"
              value={textToVectorBearerToken}
              onChange={(e) => setTextToVectorBearerToken(e.target.value)}
              placeholder={String(t('llmBearerTokenPlaceholder'))}
              disabled={textToVectorLoading}
            />
            <div className="field__hint" style={{ marginTop: 6 }}>
              <div>{t('aadCliHelperDesc')}</div>
              <div className="aadCliHelper">
                <code className="aadCliHelper__code">{buildAadCliCommand()}</code>
                <button
                  type="button"
                  className="btn btn--icon"
                  onClick={() => void onCopyCliCommand()}
                  disabled={textToVectorLoading}
                  title={String(t('aadCliCopy'))}
                >
                  <i className={cliCopied ? 'bi bi-check2' : 'bi bi-clipboard'}></i>
                </button>
              </div>
            </div>
          </label>
        )}

        <label className="field field--mb16">
          <span className="field__label">{t('textToVectorModelLabel')}</span>
          <select
            className="field__input"
            value={textToVectorModel}
            onChange={(e) => setTextToVectorModel(e.target.value)}
            disabled={textToVectorLoading}
          >
            <option value="text-embedding-ada-002">text-embedding-ada-002</option>
            <option value="text-embedding-3-small">text-embedding-3-small</option>
            <option value="text-embedding-3-large">text-embedding-3-large</option>
          </select>
        </label>

        <label className="field field--mb16">
          <span className="field__label">{t('textToVectorDimensionsLabel')}</span>
          <input
            className="field__input"
            type="number"
            min={1}
            value={textToVectorDimensions ?? ''}
            onChange={(e) => {
              const raw = e.target.value
              if (!raw.trim()) return setTextToVectorDimensions(null)
              const n = Number(raw)
              setTextToVectorDimensions(Number.isFinite(n) ? n : null)
            }}
            placeholder={String(t('textToVectorDimensionsPlaceholder'))}
            disabled={textToVectorLoading}
          />
        </label>

        <label className="field field--mb16">
          <span className="field__label">{t('textToVectorInputLabel')}</span>
          <textarea
            className="field__textarea"
            rows={4}
            value={textToVectorInput}
            onChange={(e) => setTextToVectorInput(e.target.value)}
            placeholder={String(t('textToVectorInputPlaceholder'))}
            disabled={textToVectorLoading}
          />
        </label>

        <div className="actions actions--mb16">
          <button
            type="button"
            className="btn"
            onClick={onGenerateVector}
            disabled={textToVectorLoading || !textToVectorInput.trim()}
          >
            {textToVectorLoading ? t('textToVectorGenerating') : t('textToVectorGenerate')}
          </button>
        </div>

        <div className="mono">
          input dims: {inputDimensions ?? '-'}
        </div>
      </div>

      <div className="section vectorOptimizerSettings" data-guide-target="vo-settings">
        <div className="section__title">{t('voOptimizationSettingsTitle')}</div>
        <div className="section__hint">{t('voOptimizationSettingsIntro')}</div>

        <label className="field field--mb16">
          <span className="field__label">{t('voInputVectorTypeLabel')}</span>
          <select className="field__input" value={floatType} onChange={(e) => setFloatType(e.target.value as FloatType)}>
            <option value="float32">float32 (Edm.Single)</option>
            <option value="float16">float16 (Edm.Half)</option>
          </select>
          <div className="field__hint">{t('voInputVectorTypeHint')}</div>
        </label>

        <label className="field field--mb16">
          <span className="field__label">{t('voQuantizationLabel')}</span>
          <select
            className="field__input"
            value={quantization}
            onChange={(e) => {
              const next = e.target.value as QuantizationKind
              setQuantization(next)
              if (next === 'none') {
                setEnableRescoring(false)
                setTruncationDimensionRaw('')
              } else {
                setEnableRescoring(true)
              }
            }}
          >
            <option value="none">{t('voQuantizationNone')}</option>
            <option value="scalarQuantization">scalarQuantization (int8)</option>
            <option value="binaryQuantization">binaryQuantization (1 bit/dim)</option>
          </select>
          <div className="field__hint">{t('voQuantizationHint')}</div>
        </label>

        <label className="field field--mb16">
          <span className="field__label">{t('voTruncationLabel')}</span>
          <input
            className="field__input"
            type="number"
            min={1}
            value={truncationDimensionRaw}
            onChange={(e) => setTruncationDimensionRaw(e.target.value)}
            placeholder={canUseTruncation ? String(t('voTruncationPlaceholderUnset')) : String(t('voTruncationPlaceholderNeedsQuantization'))}
            disabled={!canUseTruncation}
          />
          <div className="field__hint">{t('voTruncationHint')}</div>
        </label>

        <div className="field field--mb16">
          <div className="field__label">{t('voStoredLabel')}</div>
          <label className="agenticKsOption">
            <input
              className="agenticKsOption__checkbox"
              type="checkbox"
              checked={stored}
              onChange={(e) => setStored(e.target.checked)}
            />
            <span>
              {format('voToggleEnableWithCurrent', { value: stored ? 'stored=true' : 'stored=false' })}
            </span>
          </label>
          <div className="field__hint">
            <div>
              {t('voStoredHintTrue')}
            </div>
            <div>
              {t('voStoredHintFalse')}
            </div>
          </div>
        </div>

        <div className="field field--mb16">
          <div className="field__label">{t('voEnableRescoringLabel')}</div>
          <label className="agenticKsOption">
            <input
              className="agenticKsOption__checkbox"
              type="checkbox"
              checked={enableRescoring}
              onChange={(e) => setEnableRescoring(e.target.checked)}
              disabled={!canUseRescoring}
            />
            <span>
              {format('voToggleEnableWithCurrent', { value: enableRescoring ? 'true' : 'false' })}
            </span>
          </label>
          <div className="field__hint">
            <div>
              {t('voEnableRescoringHintTrue')}
            </div>
            <div>
              {t('voEnableRescoringHintFalse')}
            </div>
          </div>
          {!canUseRescoring && <div className="field__hint">{t('voEnableRescoringDisabled')}</div>}
        </div>

        {isBinary && (
          <label className="field field--mb16">
            <span className="field__label">{t('voRescoreStorageMethodLabel')}</span>
            <select
              className="field__input"
              value={binaryRescoreStorageMethod}
              onChange={(e) => setBinaryRescoreStorageMethod(e.target.value as RescoreStorageMethod)}
              disabled={!enableRescoring}
            >
              <option value="discardOriginals">{t('voRescoreStorageMethodDiscard')}</option>
              <option value="preserveOriginals">{t('voRescoreStorageMethodPreserve')}</option>
            </select>
            <div className="field__hint">{t('voRescoreStorageMethodHint')}</div>
          </label>
        )}

        {quantization === 'scalarQuantization' && enableRescoring && (
          <div className="notice notice--warning" role="status" aria-live="polite">
            <div className="notice__title">{t('voScalarRescoreNoticeTitle')}</div>
            <div className="notice__meta">{t('voScalarRescoreNoticeBody')}</div>
          </div>
        )}
      </div>

      <div className="section" data-guide-target="vo-estimate">
        <div className="section__title">{t('voEstimateTitle')}</div>

        {!comparison && (
          <div className="notice notice--warning" role="status" aria-live="polite">
            <div className="notice__title">{t('voNoVectorTitle')}</div>
            <div className="notice__meta">{t('voNoVectorBody')}</div>
          </div>
        )}

        {comparison && (
          <>
            <div className="mono" style={{ marginBottom: 10 }}>
              {t('voInputDimsLabel')}: {comparison.baseDims}
              {typeof truncationDimension === 'number' && Number.isFinite(truncationDimension) && (
                <>
                  {'  '}| truncationDimension: {truncationDimension}
                </>
              )}
            </div>

            <div className="section__hint">
              {t('voColumnMeaningLabel')}
              <span className="mono">vector index</span>
              {t('voColumnMeaningVectorIndex')}
              <span className="mono">source(stored)</span>
              {t('voColumnMeaningSource')}
              <span className="mono">originals</span>
              {t('voColumnMeaningOriginals')}
            </div>

            <table className="spvTable">
              <thead>
                <tr>
                  <th>{t('voTablePattern')}</th>
                  <th
                    className="mono"
                    title={String(t('voTooltipVectorIndex'))}
                  >
                    {t('voTableVectorIndex')}
                  </th>
                  <th
                    className="mono"
                    title={String(t('voTooltipSourceStored'))}
                  >
                    {t('voTableSourceStored')}
                  </th>
                  <th
                    className="mono"
                    title={String(t('voTooltipOriginals'))}
                  >
                    {t('voTableOriginals')}
                  </th>
                  <th className="mono">{t('voTableTotal')}</th>
                  <th className="mono">{t('voTableSaved')}</th>
                </tr>
              </thead>
              <tbody>
                {comparison.scenarios.map((s) => {
                  const savedBytes = comparison.baseline.totalBytes - s.bytes.totalBytes
                  const savedPct = comparison.baseline.totalBytes > 0 ? (savedBytes / comparison.baseline.totalBytes) * 100 : 0
                  const isCurrent = s.id === 'current'
                  return (
                    <tr key={s.id} className={isCurrent ? 'spvRow--selected' : undefined}>
                      <td>{s.label}</td>
                      <td className="mono">{formatBytes(s.bytes.indexBytes)}</td>
                      <td className="mono">{formatBytes(s.bytes.sourceBytes)}</td>
                      <td className="mono">{formatBytes(s.bytes.originalsBytes)}</td>
                      <td className="mono"><b>{formatBytes(s.bytes.totalBytes)}</b></td>
                      <td className="mono">
                        {formatBytes(savedBytes)} ({savedPct.toFixed(1)}%)
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </>
        )}
      </div>
    </div>
  )
}
