/**
 * Pyodide-based local Python runner.
 *
 * Loads Pyodide (WebAssembly Python) in a **Web Worker** so the main thread
 * stays responsive during the ~20 MB WASM download and Python execution.
 *
 * The public API (`runSkillLocally`, `isPyodideReady`) is unchanged from the
 * previous main-thread version; only the execution location has moved.
 */

import type { SimulateResponse } from './skillRuntime'
import type { SkillPayload } from './skillValidator'
import type { PyodideWorkerRequest, PyodideWorkerOutbound } from './pyodideWorker'

// ---------------------------------------------------------------------------
// Worker singleton
// ---------------------------------------------------------------------------

let worker: Worker | null = null
let workerReady = false
let requestId = 0

function getWorker(): Worker {
  if (worker) return worker

  worker = new Worker(new URL('./pyodideWorker.ts', import.meta.url), { type: 'module' })

  // Listen for the one-time "ready" status broadcast
  worker.addEventListener('message', (e: MessageEvent<PyodideWorkerOutbound>) => {
    if (e.data.type === 'status' && e.data.ready) {
      workerReady = true
    }
  })

  return worker
}

// ---------------------------------------------------------------------------
// Public API (unchanged signatures)
// ---------------------------------------------------------------------------

/**
 * Check whether Pyodide is already loaded (avoids showing "loading" states
 * when the WASM is already cached).
 */
export function isPyodideReady(): boolean {
  return workerReady
}

/**
 * Execute a Python Custom Skill locally using Pyodide.
 *
 * The user code must define `process(input: dict) -> dict`.
 * Each record in the payload is processed individually, mirroring the
 * Cloud Runtime behaviour.
 */
export function runSkillLocally(
  skillCode: string,
  input: SkillPayload,
): Promise<SimulateResponse> {
  return new Promise<SimulateResponse>((resolve) => {
    const w = getWorker()
    const id = ++requestId

    const handler = (e: MessageEvent<PyodideWorkerOutbound>) => {
      if (e.data.type !== 'result') return
      if (e.data.id !== id) return

      w.removeEventListener('message', handler)

      const d = e.data
      if (d.success) {
        resolve({
          success: true,
          output: d.output as SkillPayload,
          executionTimeMs: d.executionTimeMs,
          logs: d.logs,
        })
      } else {
        resolve({
          success: false,
          error: d.error,
          executionTimeMs: d.executionTimeMs,
          logs: d.logs,
        })
      }
    }

    w.addEventListener('message', handler)

    const req: PyodideWorkerRequest = {
      type: 'run',
      id,
      skillCode,
      inputJson: JSON.stringify(input),
    }
    w.postMessage(req)
  })
}
