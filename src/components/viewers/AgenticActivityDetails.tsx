import { useId, type ReactNode } from 'react'
import { activityStatusKeys, isActivityObject, type ActivityGraphNode, type ActivityItem, type ActivityTranslator } from '../../lib/agenticActivityGraph'
import { paramTooltips, type Language } from '../../lib/translations'
import { JSON_VIEWER_MAX_STRING_LENGTH } from '../../app/constants'
import { InfoTooltip } from '../InfoTooltip'
import { JsonViewer } from './JsonViewer'

function isTooltipKey(key: string): key is keyof typeof paramTooltips.en {
  return Object.hasOwn(paramTooltips.en, key)
}

export function AgenticActivityDetails({ nodes, selectedId, onSelect, onClose, t, language, renderActivity, inline = false }: {
  nodes: ActivityGraphNode[]
  selectedId: string
  onSelect: (id: string) => void
  onClose?: () => void
  t: ActivityTranslator
  language: Language
  renderActivity: (item: ActivityItem) => ReactNode
  inline?: boolean
}) {
  const selectId = useId()
  const selected = nodes.find((node) => node.id === selectedId) ?? nodes[0]
  const parameters = isActivityObject(selected?.parameters) ? selected.parameters : null
  return (
    <section className={`actGraph__inspector${inline ? ' actGraph__inspector--inline' : ''}`} aria-label={t('actGraphDetails')}>
      {!inline && (
        <>
          <div className="actGraph__inspectorHeader">
            <label className="actGraph__selectLabel" htmlFor={selectId}>{t('actGraphSelect')}</label>
            {onClose && (
              <button type="button" className="btn btn--icon" onClick={onClose} title={t('actTraceCollapse')} aria-label={t('actTraceCollapse')}>
                <i className="bi bi-x-lg" aria-hidden="true" />
              </button>
            )}
          </div>
          <select id={selectId} className="input actGraph__nodeSelect" value={selected?.id ?? ''} onChange={(event) => onSelect(event.target.value)}>
            {nodes.map((node) => <option key={node.id} value={node.id}>{node.title}{node.item ? ` #${node.item.id}` : ''}{node.item?.knowledgeSourceName ? ` · ${node.item.knowledgeSourceName}` : ''}</option>)}
          </select>
        </>
      )}
      {selected && (
        <>
          {!inline && <h4>{selected.title}</h4>}
          <div className={`actGraph__state actGraph__state--${selected.status}`}>{t(activityStatusKeys[selected.status])}</div>
          {(selected.kind === 'request' || selected.kind === 'result') && (
            <section className="actGraph__textSection" aria-label={t(selected.kind === 'request' ? 'actGraphRequestText' : 'actGraphResultText')}>
              <h5>{t(selected.kind === 'request' ? 'actGraphRequestText' : 'actGraphResultText')}</h5>
              {selected.textBlocks && selected.textBlocks.length > 0 ? selected.textBlocks.map((block, index) => (
                <div className="actGraph__textBlock" key={index}>
                  {block.label && <div className="actGraph__textLabel">{block.label}</div>}
                  <div className="actGraph__textBody">{block.text}</div>
                </div>
              )) : <div className="notice notice--info">{t('actGraphNoText')}</div>}
            </section>
          )}
          {selected.item && renderActivity(selected.item)}
          {isActivityObject(selected.item?.raw.queryHintProcessing) && (
            <div className="actGraph__parameters">
              <h5>{t('actGraphQueryHints')}</h5>
              {Object.entries(selected.item.raw.queryHintProcessing).map(([key, value]) => (
                <div className="actGraph__parameter" key={key}>
                  <span><code>{key}</code>{isTooltipKey(key) && <InfoTooltip tooltipKey={key} language={language} />}</span>
                  <code>{JSON.stringify(value)}</code>
                </div>
              ))}
            </div>
          )}
          {selected.kind === 'config' && <div className="notice notice--info">{t('actGraphSettingsNote')}</div>}
          {selected.kind === 'activity' && <div className="actGraph__hint">{t('actGraphActivityNote')}</div>}
          {parameters && Object.keys(parameters).length > 0 && (
            <div className="actGraph__parameters">
              <h5>{t('actGraphSettings')}</h5>
              {Object.entries(parameters).filter(([key]) => isTooltipKey(key)).map(([key, value]) => (
                <div className="actGraph__parameter" key={key}>
                  <span><code>{key}</code>{isTooltipKey(key) && <InfoTooltip tooltipKey={key} language={language} />}</span>
                  <code>{JSON.stringify(value)}</code>
                </div>
              ))}
              <div className="mono jsonViewer__body rawJsonViewer">
                <JsonViewer key={selected.id} data={parameters} initialOpenDepth={2} maxStringLength={JSON_VIEWER_MAX_STRING_LENGTH} t={t} />
              </div>
            </div>
          )}
          <h5>{t('actGraphRaw')}</h5>
          {selected.raw === null ? <div className="notice notice--info">{t('actGraphUnknown')}</div> : (
            <div className="mono jsonViewer__body rawJsonViewer">
              <JsonViewer
                key={selected.id}
                data={selected.raw}
                initialOpenDepth={2}
                maxStringLength={JSON_VIEWER_MAX_STRING_LENGTH}
                hideRootObjectToggle
                t={t}
              />
            </div>
          )}
        </>
      )}
    </section>
  )
}
