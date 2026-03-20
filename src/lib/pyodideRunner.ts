/**
 * Pyodide-based local Python runner.
 *
 * Loads Pyodide (WebAssembly Python) from CDN on first use and executes
 * Custom Skill `process()` functions directly in the browser — no server needed.
 *
 * The runner wraps user code execution with stdout/stderr capture and
 * produces a SimulateResponse compatible with the Cloud Runtime format.
 */

import type { SimulateResponse } from './skillRuntime'
import type { SkillPayload } from './skillValidator'

// ---------------------------------------------------------------------------
// Pyodide types (minimal subset used here)
// ---------------------------------------------------------------------------

interface PyodideInterface {
  runPython(code: string): unknown
  runPythonAsync(code: string): Promise<unknown>
  loadPackagesFromImports(code: string): Promise<void>
  globals: { get(key: string): unknown }
}

type LoadPyodideFn = (opts: { indexURL: string }) => Promise<PyodideInterface>

declare global {
  interface Window {
    loadPyodide?: LoadPyodideFn
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

const PYODIDE_CDN = 'https://cdn.jsdelivr.net/pyodide/v0.27.5/full/'

let pyodideInstance: PyodideInterface | null = null
let loadingPromise: Promise<PyodideInterface> | null = null

/**
 * Load Pyodide lazily. The ~20 MB WASM bundle is fetched once and cached
 * by the browser.
 */
export async function ensurePyodide(): Promise<PyodideInterface> {
  if (pyodideInstance) return pyodideInstance

  if (loadingPromise) return loadingPromise

  loadingPromise = (async () => {
    // Inject the CDN script if not already present
    if (!window.loadPyodide) {
      await new Promise<void>((resolve, reject) => {
        const script = document.createElement('script')
        script.src = `${PYODIDE_CDN}pyodide.js`
        script.onload = () => resolve()
        script.onerror = () => reject(new Error('Failed to load Pyodide script from CDN'))
        document.head.appendChild(script)
      })
    }

    const loadPyodide = window.loadPyodide
    if (!loadPyodide) throw new Error('loadPyodide is not available')

    const py = await loadPyodide({ indexURL: PYODIDE_CDN })
    pyodideInstance = py
    return py
  })()

  try {
    return await loadingPromise
  } catch (err) {
    loadingPromise = null
    throw err
  }
}

/**
 * Check whether Pyodide is already loaded (avoids showing "loading" states
 * when the WASM is already cached).
 */
export function isPyodideReady(): boolean {
  return pyodideInstance !== null
}

// ---------------------------------------------------------------------------
// Local execution
// ---------------------------------------------------------------------------

/**
 * Execute a Python Custom Skill locally using Pyodide.
 *
 * The user code must define `process(input: dict) -> dict`.
 * Each record in the payload is processed individually, mirroring the
 * Cloud Runtime behaviour.
 */
export async function runSkillLocally(
  skillCode: string,
  input: SkillPayload,
): Promise<SimulateResponse> {
  let py: PyodideInterface
  try {
    py = await ensurePyodide()
  } catch (err) {
    return {
      success: false,
      error: `Pyodide load error: ${err instanceof Error ? err.message : String(err)}`,
    }
  }

  // Wrapper that:
  //  1. Captures stdout/stderr
  //  2. Runs the user code to define `process`
  //  3. Calls `process()` for each record
  //  4. Returns JSON-serialised results
  const wrapper = `
import sys, io, json, traceback

_stdout = io.StringIO()
_stderr = io.StringIO()
sys.stdout = _stdout
sys.stderr = _stderr

_records = json.loads(_INPUT_JSON)["values"]
_output_values = []
_has_error = False

try:
    _ns = {"__builtins__": __builtins__}
    exec(_USER_CODE, _ns)
    _process = _ns.get("process")
    if not callable(_process):
        raise RuntimeError("Skill code must define a callable process(input: dict) -> dict function.")

    for _rec in _records:
        _result = {"recordId": _rec["recordId"], "data": {}, "errors": [], "warnings": []}
        try:
            _out = _process(_rec["data"])
            if isinstance(_out, dict):
                _result["data"] = _out
            else:
                _result["errors"].append({"message": f"process() must return a dict, got {type(_out).__name__}"})
        except Exception:
            _result["errors"].append({"message": traceback.format_exc()})
        _output_values.append(_result)
except Exception:
    _has_error = True
    _output_values = [{"error": traceback.format_exc()}]

sys.stdout = sys.__stdout__
sys.stderr = sys.__stderr__

_RESULT_JSON = json.dumps({
    "hasError": _has_error,
    "values": _output_values,
    "logs": _stdout.getvalue() + _stderr.getvalue()
})
`

  const startMs = performance.now()

  try {
    // Auto-detect and load any packages referenced by import statements
    // (e.g. numpy, pandas). Pyodide built-in packages are loaded from CDN WASM.
    await py.loadPackagesFromImports(skillCode)

    // Inject user code and input as Python string literals
    const escapedCode = JSON.stringify(skillCode)
    const escapedInput = JSON.stringify(input)

    py.runPython(`_USER_CODE = ${escapedCode}`)
    py.runPython(`_INPUT_JSON = ${JSON.stringify(escapedInput)}`)
    py.runPython(wrapper)

    const resultRaw = py.globals.get('_RESULT_JSON') as string
    const parsed: {
      hasError: boolean
      values: Array<Record<string, unknown>>
      logs: string
    } = JSON.parse(resultRaw)

    const elapsedMs = Math.round((performance.now() - startMs) * 100) / 100

    if (parsed.hasError) {
      const errMsg =
        (parsed.values[0] as { error?: string })?.error ?? 'Unknown execution error'
      return {
        success: false,
        error: errMsg,
        executionTimeMs: elapsedMs,
        logs: parsed.logs || undefined,
      }
    }

    return {
      success: true,
      output: { values: parsed.values as unknown as SkillPayload['values'] },
      executionTimeMs: elapsedMs,
      logs: parsed.logs || undefined,
    }
  } catch (err) {
    const elapsedMs = Math.round((performance.now() - startMs) * 100) / 100
    return {
      success: false,
      error: `Pyodide execution error: ${err instanceof Error ? err.message : String(err)}`,
      executionTimeMs: elapsedMs,
    }
  }
}
