import { useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { translations, type Language } from '../../lib/translations'
import { clamp } from '../../utils'

export function GraphWorkspace({ children, language, showInspector = true }: { children: [ReactNode, ReactNode]; language: Language; showInspector?: boolean }) {
  const containerRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<{ pointerId: number; x: number; width: number; percent: number } | null>(null)
  const [percent, setPercent] = useState(70)
  const [dragging, setDragging] = useState(false)
  const label = translations[language].kgResizeInspector
  const style: CSSProperties & { '--kg-visualization-width': string; '--kg-inspector-width': string } = {
    '--kg-visualization-width': `${percent}fr`,
    '--kg-inspector-width': `${100 - percent}fr`,
  }
  const stopDrag = () => { dragRef.current = null; setDragging(false) }
  return <div ref={containerRef} className={`kgWorkspace${showInspector ? '' : ' kgWorkspace--full'}${dragging ? ' kgWorkspace--dragging' : ''}`} style={style}>
    {children[0]}
    {showInspector && <div className={`splitter kgWorkspace__splitter${dragging ? ' splitter--active' : ''}`}
      role="separator" aria-orientation="vertical" aria-label={label} title={label}
      aria-valuemin={35} aria-valuemax={75} aria-valuenow={Math.round(percent)} tabIndex={0}
      onPointerDown={(event) => {
        if (event.button !== 0 || !containerRef.current) return
        const width = containerRef.current.clientWidth - event.currentTarget.clientWidth - 16
        if (width <= 0) return
        event.preventDefault()
        event.currentTarget.setPointerCapture(event.pointerId)
        dragRef.current = { pointerId: event.pointerId, x: event.clientX, width, percent }
        setDragging(true)
      }}
      onPointerMove={(event) => {
        const drag = dragRef.current
        if (!drag || drag.pointerId !== event.pointerId) return
        setPercent(clamp(drag.percent + (event.clientX - drag.x) / drag.width * 100, 35, 75))
      }}
      onPointerUp={stopDrag} onPointerCancel={stopDrag} onLostPointerCapture={stopDrag}
      onKeyDown={(event) => {
        if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight' && event.key !== 'Home' && event.key !== 'End') return
        event.preventDefault()
        setPercent((current) => event.key === 'Home' ? 35 : event.key === 'End' ? 75 : clamp(current + (event.key === 'ArrowLeft' ? -2 : 2), 35, 75))
      }} />}
    {children[1]}
  </div>
}
