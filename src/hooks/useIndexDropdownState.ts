import { useRef, useState } from 'react'

export function useIndexDropdownState() {
  const indexDropdownToggleRef = useRef<HTMLButtonElement>(null)
  const indexDropdownMenuRef = useRef<HTMLDivElement>(null)
  const indexFilterInputRef = useRef<HTMLInputElement>(null)
  const [indexFilterText, setIndexFilterText] = useState('')

  return {
    indexDropdownToggleRef,
    indexDropdownMenuRef,
    indexFilterInputRef,
    indexFilterText,
    setIndexFilterText,
  }
}
