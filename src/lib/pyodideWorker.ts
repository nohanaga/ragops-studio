/**
 * Web Worker for Pyodide (WebAssembly Python) execution.
 *
 * Loads and runs Pyodide off the main thread so the UI stays responsive
 * during ~20 MB WASM download and Python code execution.
 */

// ---------------------------------------------------------------------------
// Pyodide types (minimal subset)
// ---------------------------------------------------------------------------

interface PyodideInterface {
  runPython(code: string): unknown
  runPythonAsync(code: string): Promise<unknown>
  loadPackagesFromImports(code: string): Promise<void>
  globals: { get(key: string): unknown }
}

declare function importScripts(...urls: string[]): void
declare function loadPyodide(opts: { indexURL: string }): Promise<PyodideInterface>

// ---------------------------------------------------------------------------
// Message protocol
// ---------------------------------------------------------------------------

export interface PyodideWorkerRequest {
  type: 'run'
  id: number
  skillCode: string
  inputJson: string
}

export interface PyodideWorkerResponse {
  type: 'result'
  id: number
  success: boolean
  output?: unknown
  error?: string
  executionTimeMs?: number
  logs?: string
}

export interface PyodideWorkerStatusMessage {
  type: 'status'
  ready: boolean
}

export type PyodideWorkerOutbound = PyodideWorkerResponse | PyodideWorkerStatusMessage

// ---------------------------------------------------------------------------
// Worker state
// ---------------------------------------------------------------------------

const PYODIDE_CDN = 'https://cdn.jsdelivr.net/pyodide/v0.27.5/full/'

let py: PyodideInterface | null = null
let initPromise: Promise<void> | null = null

async function ensureInit(): Promise<void> {
  if (py) return
  if (initPromise) return initPromise

  initPromise = (async () => {
    importScripts(`${PYODIDE_CDN}pyodide.js`)
    py = await loadPyodide({ indexURL: PYODIDE_CDN })
    const msg: PyodideWorkerStatusMessage = { type: 'status', ready: true }
    self.postMessage(msg)
  })()

  return initPromise
}

// ---------------------------------------------------------------------------
// Python wrapper template (same logic as original pyodideRunner.ts)
// ---------------------------------------------------------------------------

const PYTHON_WRAPPER = `
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

// ---------------------------------------------------------------------------
// Message handler
// ---------------------------------------------------------------------------

self.onmessage = async (e: MessageEvent<PyodideWorkerRequest>) => {
  const { type, id, skillCode, inputJson } = e.data
  if (type !== 'run') return

  const startMs = performance.now()

  try {
    await ensureInit()
    if (!py) throw new Error('Pyodide failed to initialise')

    await py.loadPackagesFromImports(skillCode)

    py.runPython(`_USER_CODE = ${JSON.stringify(skillCode)}`)
    py.runPython(`_INPUT_JSON = ${JSON.stringify(inputJson)}`)
    py.runPython(PYTHON_WRAPPER)

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
      const resp: PyodideWorkerResponse = {
        type: 'result',
        id,
        success: false,
        error: errMsg,
        executionTimeMs: elapsedMs,
        logs: parsed.logs || undefined,
      }
      self.postMessage(resp)
      return
    }

    const resp: PyodideWorkerResponse = {
      type: 'result',
      id,
      success: true,
      output: { values: parsed.values },
      executionTimeMs: elapsedMs,
      logs: parsed.logs || undefined,
    }
    self.postMessage(resp)
  } catch (err) {
    const elapsedMs = Math.round((performance.now() - startMs) * 100) / 100
    const resp: PyodideWorkerResponse = {
      type: 'result',
      id,
      success: false,
      error: `Pyodide execution error: ${err instanceof Error ? err.message : String(err)}`,
      executionTimeMs: elapsedMs,
    }
    self.postMessage(resp)
  }
}
