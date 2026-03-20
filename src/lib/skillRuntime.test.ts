// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'

import { checkHealth, executeRemoteSkill, uploadSkillCode } from './skillRuntime'

describe('lib/skillRuntime', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('posts remote execution requests to the configured execute endpoint as-is', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          values: [{ recordId: '1', data: { result: 'ok' }, errors: [], warnings: [] }],
        }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
      ),
    )

    const input = { values: [{ recordId: '1', data: { text: 'hello' } }] }
    const result = await executeRemoteSkill({ runtimeUrl: 'https://example.com/execute' }, input)

    expect(fetchSpy).toHaveBeenCalledWith(
      'https://example.com/execute',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify(input),
      }),
    )
    expect(result.success).toBe(true)
    expect(result.output).toEqual({
      values: [{ recordId: '1', data: { result: 'ok' }, errors: [], warnings: [] }],
    })
  })

  it('appends /execute when given a runtime base URL', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ values: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    )

    await executeRemoteSkill({ runtimeUrl: 'https://example.com' }, { values: [] })

    expect(fetchSpy).toHaveBeenCalledWith(
      'https://example.com/execute',
      expect.objectContaining({ method: 'POST' }),
    )
  })

  it('checks health against the runtime root even when configured with /execute', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ status: 'ok', version: '0.2.0' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    )

    const result = await checkHealth({ runtimeUrl: 'https://example.com/execute' })

    expect(fetchSpy).toHaveBeenCalledWith(
      'https://example.com/health',
      expect.objectContaining({ method: 'GET' }),
    )
    expect(result.status).toBe('ok')
  })

  it('uploads skill code against the runtime root even when configured with /execute', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ success: true, message: 'Published.' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    )

    const result = await uploadSkillCode(
      { runtimeUrl: 'https://example.com/execute' },
      {
        skillName: 'custom-skill',
        skillCode: 'def process(input: dict) -> dict:\n    return {}',
      },
    )

    expect(fetchSpy).toHaveBeenCalledWith(
      'https://example.com/upload',
      expect.objectContaining({ method: 'POST' }),
    )
    expect(result.success).toBe(true)
    expect(result.message).toBe('Published.')
  })
})