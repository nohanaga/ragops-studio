import ReactEChartsCore from 'echarts-for-react/lib/core'
import { SunburstChart, TreeChart } from 'echarts/charts'
import { AriaComponent, TitleComponent, TooltipComponent } from 'echarts/components'
import * as echarts from 'echarts/core'
import type { EChartsCoreOption } from 'echarts/core'
import { CanvasRenderer } from 'echarts/renderers'
import type { CSSProperties } from 'react'

echarts.use([SunburstChart, TreeChart, AriaComponent, TitleComponent, TooltipComponent, CanvasRenderer])

/**
 * The only module that imports ECharts. It is loaded lazily, so the library (and the chart types it registers) stays out
 * of the main bundle until a topic chart is opened.
 */
export default function TopicEChart({ option, style, onEvents }: {
  option: EChartsCoreOption
  style: CSSProperties
  onEvents: Record<string, (params: unknown) => void>
}) {
  return <ReactEChartsCore echarts={echarts} option={option} style={style} onEvents={onEvents} opts={{ renderer: 'canvas' }} lazyUpdate />
}
