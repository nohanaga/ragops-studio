import '@testing-library/jest-dom/vitest'
import 'fake-indexeddb/auto'

import { afterAll, afterEach, beforeAll } from 'vitest'
import { server } from './mswServer'

function hasStorageApi(v: unknown): v is Storage {
  const s = v as Storage
  return (
    !!s &&
    typeof (s as any).getItem === 'function' &&
    typeof (s as any).setItem === 'function' &&
    typeof (s as any).removeItem === 'function' &&
    typeof (s as any).clear === 'function'
  )
}

function createMemoryStorage(): Storage {
  const map = new Map<string, string>()
  const storage: Storage = {
    get length() {
      return map.size
    },
    clear() {
      map.clear()
    },
    getItem(key: string) {
      const k = String(key)
      return map.has(k) ? map.get(k)! : null
    },
    key(index: number) {
      const keys = Array.from(map.keys())
      return typeof index === 'number' && index >= 0 && index < keys.length ? keys[index] : null
    },
    removeItem(key: string) {
      map.delete(String(key))
    },
    setItem(key: string, value: string) {
      map.set(String(key), String(value))
    },
  }
  return storage
}

function ensureWebStorage() {
  // Prefer jsdom's window.localStorage when present.
  const w = (globalThis as any).window as Window | undefined
  const winLocal = w ? (w as any).localStorage : undefined
  const winSession = w ? (w as any).sessionStorage : undefined

  if (!hasStorageApi((globalThis as any).localStorage)) {
    ;(globalThis as any).localStorage = hasStorageApi(winLocal) ? winLocal : createMemoryStorage()
  }
  if (!hasStorageApi((globalThis as any).sessionStorage)) {
    ;(globalThis as any).sessionStorage = hasStorageApi(winSession) ? winSession : createMemoryStorage()
  }
}

ensureWebStorage()

// Fail fast on unexpected network calls.
beforeAll(() => {
  server.listen({ onUnhandledRequest: 'error' })
})

afterEach(() => {
  server.resetHandlers()

  // Keep tests isolated.
  try {
    ;(globalThis as any).localStorage?.clear?.()
    ;(globalThis as any).sessionStorage?.clear?.()
  } catch {
    // ignore
  }
})

afterAll(() => {
  server.close()
})
