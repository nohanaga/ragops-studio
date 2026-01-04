import { useCallback } from 'react'
import type { Dispatch, SetStateAction } from 'react'
import type { CenterTab } from '../types'

export function useRunTabActions(params: {
  setSelectedRunIds: Dispatch<SetStateAction<string[]>>
  setCenterTab: Dispatch<SetStateAction<CenterTab>>
}) {
  const { setSelectedRunIds, setCenterTab } = params

  const toggleRunSelection = useCallback(
    (runId: string, checked: boolean) => {
      setSelectedRunIds((prev) => {
        const next = prev.filter((id) => id !== runId)
        if (checked) {
          next.push(runId)
        }
        const limited = next.slice(-10)
        if (checked && limited.includes(runId)) {
          setCenterTab(`run:${runId}`)
        }
        return limited
      })
    },
    [setCenterTab, setSelectedRunIds],
  )

  const closeRunTab = useCallback(
    (runId: string) => {
      setSelectedRunIds((prev) => prev.filter((id) => id !== runId))
    },
    [setSelectedRunIds],
  )

  return { toggleRunSelection, closeRunTab }
}
