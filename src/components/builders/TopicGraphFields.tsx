import type { TopicGraphSettings } from '../../types'
import type { Language, TranslationKey } from '../../lib/translations'
import { InfoTooltip } from '../InfoTooltip'

export function TopicGraphFields({ value, onChange, t, language, stored = false, disabled = false }: {
  value?: TopicGraphSettings
  onChange: (next?: TopicGraphSettings) => void
  t: (key: TranslationKey) => string
  language: Language
  stored?: boolean
  disabled?: boolean
}) {
  return <>
    <label className="field">
      <span className="field__label">
        {t('topicGraphRetrieval')}
        <InfoTooltip tooltipKey={stored ? 'topicGraphDefault' : 'topicGraphOverride'} language={language} />
      </span>
      <select className="field__input" disabled={disabled} value={value?.kind ?? ''} onChange={(event) => {
        const kind = event.target.value
        if (kind === 'balanced' || kind === 'diverse' || kind === 'none') onChange({ kind })
        else onChange(undefined)
      }}>
        <option value="">{t(stored ? 'topicGraphUnconfigured' : 'topicGraphInherit')}</option>
        <option value="none">none</option>
        <option value="balanced">balanced</option>
        <option value="diverse">diverse</option>
      </select>
    </label>
    {value && value.kind !== 'none' && <label className="field">
      <span className="field__label">
        minDiversityPoolSize
        <InfoTooltip tooltipKey="topicGraphMinDiversityPoolSize" language={language} />
      </span>
      <input className="field__input" disabled={disabled} type="number" min={250} max={10000} step={1} value={value.minDiversityPoolSize ?? ''}
        onChange={(event) => onChange({ ...value, minDiversityPoolSize: event.target.value === '' ? undefined : Number(event.target.value) })} />
    </label>}
    {value?.kind === 'diverse' && <label className="field">
      <span className="field__label">
        diversityFactor
        <InfoTooltip tooltipKey="topicGraphDiversityFactor" language={language} />
      </span>
      <input className="field__input" disabled={disabled} type="number" min={0} max={1} step="any" value={value.diversityFactor ?? ''}
        onChange={(event) => onChange({ ...value, diversityFactor: event.target.value === '' ? undefined : Number(event.target.value) })} />
    </label>}
  </>
}
