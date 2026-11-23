import { isJsonObject, type JsonObject } from '../../app/json'
import type { JsonValue } from '../../lib/aiSearchRest'
import type { Language, TranslationKey } from '../../lib/translations'
import { InfoTooltip } from '../InfoTooltip'

export function KnowledgeBaseToolFields({ tools, sources, onChange, t, language }: {
  tools: JsonValue[]
  sources: string[]
  onChange: (tools: JsonValue[]) => void
  t: (key: TranslationKey) => string
  language: Language
}) {
  return (
    <div className="field field--full">
      <span className="field__label">
        {t('knowledgeBaseTools')}
        <InfoTooltip tooltipKey="knowledgeBaseTools" language={language} />
      </span>
      {tools.map((item, i) => {
        const tool = isJsonObject(item) ? item : {}
        const refs = Array.isArray(tool.knowledgeSources) ? tool.knowledgeSources : []
        const defaults = isJsonObject(tool.retrieveDefaults) ? tool.retrieveDefaults : {}
        const effort = isJsonObject(tool.retrievalReasoningEffort) ? tool.retrievalReasoningEffort.kind : undefined
        const update = (next: JsonObject) => onChange(tools.map((entry, index) => index === i ? next : entry))
        return (
          <fieldset className="agenticKsItem" key={i}>
            <legend>{t('knowledgeBaseTool')} {i + 1}</legend>
            <div className="form">
              <label className="field">
                <span className="field__label">
                  {t('name')} *
                  <InfoTooltip tooltipKey="knowledgeBaseToolIdentifier" language={language} />
                </span>
                <input className="field__input" maxLength={64} value={typeof tool.name === 'string' ? tool.name : ''}
                  onChange={(event) => update({ ...tool, name: event.target.value })} />
              </label>
              <label className="field">
                <span className="field__label">
                  {t('description')} *
                  <InfoTooltip tooltipKey="knowledgeBaseToolDescription" language={language} />
                </span>
                <textarea className="field__textarea" rows={2} maxLength={1024} value={typeof tool.description === 'string' ? tool.description : ''}
                  onChange={(event) => update({ ...tool, description: event.target.value })} />
              </label>
              <label className="field">
                <span className="field__label">
                  retrievalReasoningEffort.kind
                  <InfoTooltip tooltipKey="retrievalReasoningEffort" language={language} />
                </span>
                <select className="field__input" value={typeof effort === 'string' ? effort : ''} onChange={(event) => {
                  const next = { ...tool }
                  if (event.target.value) next.retrievalReasoningEffort = { kind: event.target.value }
                  else delete next.retrievalReasoningEffort
                  update(next)
                }}>
                  <option value="">{t('inheritDefaults')}</option>
                  {['minimal', 'low', 'medium', 'auto'].map((kind) => <option key={kind}>{kind}</option>)}
                </select>
              </label>
              {(['maxRuntimeInSeconds', 'maxOutputDocuments', 'maxOutputSizeInTokens'] as const).map((key) => (
                <label className="field" key={key}>
                  <span className="field__label">
                    retrieveDefaults.{key}
                    <InfoTooltip tooltipKey={key === 'maxOutputDocuments' ? 'retrieveMaxOutputDocuments' : key} language={language} />
                  </span>
                  <input className="field__input" type="number" min={1} step={1} placeholder={t('inheritDefaults')}
                    value={typeof defaults[key] === 'number' ? defaults[key] : ''}
                    onChange={(event) => {
                      const nextDefaults = { ...defaults }
                      if (event.target.value === '') delete nextDefaults[key]
                      else nextDefaults[key] = Number(event.target.value)
                      const next = { ...tool }
                      if (Object.keys(nextDefaults).length) next.retrieveDefaults = nextDefaults
                      else delete next.retrieveDefaults
                      update(next)
                    }} />
                </label>
              ))}
              <div className="field field--full">
                <span className="field__label">
                  {t('knowledgeSourceBuilderListTitle')} *
                  <InfoTooltip tooltipKey="knowledgeBaseToolSources" language={language} />
                </span>
                {[...new Set([...sources, ...refs.flatMap((ref) => isJsonObject(ref) && typeof ref.name === 'string' ? [ref.name] : [])])].map((name) => {
                  const ref = refs.find((entry): entry is JsonObject => isJsonObject(entry) && entry.name === name)
                  return (
                    <div key={name}>
                      <label className="agenticKsOption">
                        <input type="checkbox" className="agenticKsOption__checkbox" checked={!!ref} onChange={(event) => update({
                          ...tool, knowledgeSources: event.target.checked ? [...refs, { name }] : refs.filter((entry) => entry !== ref),
                        })} />
                        {name}{!sources.includes(name) ? ` (${t('notInKnowledgeBase')})` : ''}
                      </label>
                      {ref && <label className="field">
                        <span className="field__label">
                          filterAddOn ({name})
                          <InfoTooltip tooltipKey="knowledgeSourceFilterAddOn" language={language} />
                        </span>
                        <input className="field__input" value={typeof ref.filterAddOn === 'string' ? ref.filterAddOn : ''}
                          onChange={(event) => {
                            const next = { ...ref }
                            if (event.target.value) next.filterAddOn = event.target.value
                            else delete next.filterAddOn
                            update({ ...tool, knowledgeSources: refs.map((entry) => entry === ref ? next : entry) })
                          }} />
                      </label>}
                    </div>
                  )
                })}
              </div>
              <button type="button" className="btn" onClick={() => onChange(tools.filter((_, index) => index !== i))}>{t('removeKnowledgeBaseTool')}</button>
            </div>
          </fieldset>
        )
      })}
      <div>
        <button type="button" className="btn" onClick={() => onChange([...tools, { name: '', description: '', knowledgeSources: [] }])}>{t('addKnowledgeBaseTool')}</button>
      </div>
    </div>
  )
}
