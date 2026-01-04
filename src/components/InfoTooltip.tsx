/**
 * Small inline tooltip helper.
 *
 * Renders an ⓘ icon using the HTML title attribute, with the text sourced from
 * the translation catalog.
 */

import { paramTooltips, type Language } from '../lib/translations'

type InfoTooltipProps = {
  tooltipKey: keyof typeof paramTooltips.ja
  language: Language
}

export function InfoTooltip({ tooltipKey, language }: InfoTooltipProps) {
  const text = paramTooltips[language][tooltipKey]
  return (
    <span
      className="infoTooltip"
      title={text}
    >
      ⓘ
    </span>
  )
}
