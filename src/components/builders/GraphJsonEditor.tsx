import { useEffect, useState } from 'react'
import { json } from '@codemirror/lang-json'
import { EditorView } from '@codemirror/view'
import { githubDark, githubLight } from '@uiw/codemirror-theme-github'
import { ExpandableCodeMirror } from '../viewers/ExpandableCodeMirror'
import { translations, type Language } from '../../lib/translations'
import type { ThemePreference } from '../../types'

const graphEditorTheme = EditorView.theme({
  '&': { backgroundColor: 'var(--panel)', color: 'var(--fg)', fontSize: '12px' },
  '.cm-content': { caretColor: 'var(--fg)', padding: '12px 0' },
  '.cm-scroller': { fontFamily: 'var(--kg-mono)' },
  '.cm-gutters': { backgroundColor: 'var(--panel-2)', color: 'var(--muted)', borderRight: '1px solid var(--border)' },
  '.cm-activeLine, .cm-activeLineGutter': { backgroundColor: 'color-mix(in srgb, var(--accent) 7%, transparent)' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection': { backgroundColor: 'color-mix(in srgb, var(--accent) 22%, transparent)' },
  '&.cm-focused': { outline: 'none' },
})

export function GraphJsonEditor({ value, onChange, language, theme, readOnly = false, height = '320px' }: {
  value: string
  onChange?: (value: string) => void
  language: Language
  theme: ThemePreference
  readOnly?: boolean
  height?: string
}) {
  const [systemDark, setSystemDark] = useState(() => window.matchMedia('(prefers-color-scheme: dark)').matches)
  useEffect(() => {
    const query = window.matchMedia('(prefers-color-scheme: dark)')
    const change = () => setSystemDark(query.matches)
    query.addEventListener('change', change)
    return () => query.removeEventListener('change', change)
  }, [])
  const light = theme === 'light' || theme === 'solarized' || (theme === 'system' && !systemDark)
  return <div className="kgJsonEditor"><ExpandableCodeMirror
    value={value} onChange={onChange} height={height}
    extensions={[json(), graphEditorTheme]} theme={light ? githubLight : githubDark}
    readOnly={readOnly} editable={!readOnly}
    t={(key) => translations[language][key]}
  /></div>
}
