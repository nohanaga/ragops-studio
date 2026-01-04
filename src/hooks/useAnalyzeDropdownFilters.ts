import { useRef, useState } from 'react'

export function useAnalyzeDropdownFilters() {
  const [analyzerFilterText, setAnalyzerFilterText] = useState('')
  const analyzerFilterInputRef = useRef<HTMLInputElement | null>(null)
  const analyzerDropdownToggleRef = useRef<HTMLButtonElement | null>(null)
  const analyzerDropdownMenuRef = useRef<HTMLDivElement | null>(null)

  const [tokenizerFilterText, setTokenizerFilterText] = useState('')
  const tokenizerFilterInputRef = useRef<HTMLInputElement | null>(null)
  const tokenizerDropdownToggleRef = useRef<HTMLButtonElement | null>(null)
  const tokenizerDropdownMenuRef = useRef<HTMLDivElement | null>(null)

  const [normalizerFilterText, setNormalizerFilterText] = useState('')
  const normalizerFilterInputRef = useRef<HTMLInputElement | null>(null)
  const normalizerDropdownToggleRef = useRef<HTMLButtonElement | null>(null)
  const normalizerDropdownMenuRef = useRef<HTMLDivElement | null>(null)

  const [charFilterText, setCharFilterText] = useState('')
  const charFilterInputRef = useRef<HTMLInputElement | null>(null)
  const charFilterDropdownToggleRef = useRef<HTMLButtonElement | null>(null)
  const charFilterDropdownMenuRef = useRef<HTMLDivElement | null>(null)

  const [tokenFilterText, setTokenFilterText] = useState('')
  const tokenFilterInputRef = useRef<HTMLInputElement | null>(null)
  const tokenFilterDropdownToggleRef = useRef<HTMLButtonElement | null>(null)
  const tokenFilterDropdownMenuRef = useRef<HTMLDivElement | null>(null)

  return {
    analyzerFilterText,
    setAnalyzerFilterText,
    analyzerFilterInputRef,
    analyzerDropdownToggleRef,
    analyzerDropdownMenuRef,

    tokenizerFilterText,
    setTokenizerFilterText,
    tokenizerFilterInputRef,
    tokenizerDropdownToggleRef,
    tokenizerDropdownMenuRef,

    normalizerFilterText,
    setNormalizerFilterText,
    normalizerFilterInputRef,
    normalizerDropdownToggleRef,
    normalizerDropdownMenuRef,

    charFilterText,
    setCharFilterText,
    charFilterInputRef,
    charFilterDropdownToggleRef,
    charFilterDropdownMenuRef,

    tokenFilterText,
    setTokenFilterText,
    tokenFilterInputRef,
    tokenFilterDropdownToggleRef,
    tokenFilterDropdownMenuRef,
  }
}
