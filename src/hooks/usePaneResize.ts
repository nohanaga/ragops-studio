import type { Dispatch, SetStateAction } from 'react'
import { useEffect } from 'react'
import type { PaneSizes } from '../types'
import { clamp } from '../utils'

export type DragState = null | { side: 'left' | 'right' | 'vertical'; x0: number; y0: number; s0: PaneSizes }

export function usePaneResize(params: {
  paneSizes: PaneSizes
  setPaneSizes: Dispatch<SetStateAction<PaneSizes>>
  dragging: DragState
  setDragging: Dispatch<SetStateAction<DragState>>
}) {
  const { paneSizes, setPaneSizes, dragging, setDragging } = params

  // Persist pane sizes.
  useEffect(() => {
    try {
      localStorage.setItem('paneSizes', JSON.stringify(paneSizes))
    } catch {
      // ignore
    }
  }, [paneSizes])

  // Handle dragging for pane resizing.
  useEffect(() => {
    if (!dragging) return

    const onMove = (e: PointerEvent) => {
      const dx = e.clientX - dragging.x0
      const splitterPx = 10
      const minCenter = 360
      const minLeft = 240
      const minRight = 320
      const vw = window.innerWidth

      if (dragging.side === 'left') {
        const maxLeft = Math.max(minLeft, vw - minCenter - dragging.s0.rightPx - splitterPx * 2)
        const leftPx = clamp(dragging.s0.leftPx + dx, minLeft, maxLeft)
        setPaneSizes((prev) => ({ ...prev, leftPx }))
      } else if (dragging.side === 'right') {
        const maxRight = Math.max(minRight, vw - minCenter - dragging.s0.leftPx - splitterPx * 2)
        const rightPx = clamp(dragging.s0.rightPx - dx, minRight, maxRight)
        setPaneSizes((prev) => ({ ...prev, rightPx }))
      } else if (dragging.side === 'vertical') {
        const dy = e.clientY - dragging.y0
        const minHeight = 100
        const maxHeight = 600
        const experimentsHeightPx = clamp(dragging.s0.experimentsHeightPx + dy, minHeight, maxHeight)
        setPaneSizes((prev) => ({ ...prev, experimentsHeightPx }))
      }
    }

    const onUp = () => {
      setDragging(null)
      document.body.style.userSelect = ''
    }

    document.body.style.userSelect = 'none'
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp, { once: true })
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      document.body.style.userSelect = ''
    }
  }, [dragging, setDragging, setPaneSizes])
}
