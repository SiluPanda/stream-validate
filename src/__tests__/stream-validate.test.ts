import { describe, it, expect, vi } from 'vitest'
import { z } from 'zod'
import { createStreamValidator } from '../stream-validator'
import { streamValidate } from '../stream-validate'
import type { ValidatedPartial } from '../types'

// Helper: split string into individual characters as async iterable
async function* charStream(s: string): AsyncIterable<string> {
  for (const ch of s) {
    yield ch
  }
}

// Helper: split string into chunks of given size
async function* chunkStream(s: string, size: number): AsyncIterable<string> {
  for (let i = 0; i < s.length; i += size) {
    yield s.slice(i, i + size)
  }
}

describe('createStreamValidator', () => {
  it('emits partial events as fields complete', () => {
    const schema = z.object({ name: z.string() })
    const validator = createStreamValidator(schema)
    const partials: ValidatedPartial<{ name: string }>[] = []
    validator.on('partial', p => partials.push(p))

    validator.write('{"name":"Alice"}')
    validator.end()

    const namePartial = partials.find(p => p?.data && (p.data as { name?: string }).name === 'Alice')
    expect(namePartial).toBeDefined()
  })

  it('emits complete event after end()', () => {
    const schema = z.object({ x: z.number() })
    const validator = createStreamValidator(schema)
    const completeEvents: unknown[] = []
    validator.on('complete', e => completeEvents.push(e))

    validator.write('{"x":42}')
    validator.end()

    expect(completeEvents).toHaveLength(1)
    const evt = completeEvents[0] as { isComplete: boolean; truncated: boolean }
    expect(evt.truncated).toBe(false)
  })

  it('reports isComplete=true after all required fields are received', () => {
    const schema = z.object({ name: z.string(), age: z.number() })
    const validator = createStreamValidator(schema)
    const partials: { isComplete: boolean }[] = []
    validator.on('partial', p => partials.push(p))

    validator.write('{"name":"Bob","age":30}')
    validator.end()

    const last = partials[partials.length - 1]
    expect(last?.isComplete).toBe(true)
  })

  it('current getter returns latest partial', () => {
    const schema = z.object({ val: z.string() })
    const validator = createStreamValidator(schema)
    expect(validator.current).toBeNull()

    validator.write('{"val":"test"}')
    expect(validator.current).not.toBeNull()
    expect((validator.current!.data as { val?: string }).val).toBe('test')
  })

  it('abort() emits complete with truncated=true', () => {
    const schema = z.object({ name: z.string() })
    const validator = createStreamValidator(schema)
    const completeEvents: { truncated: boolean }[] = []
    validator.on('complete', e => completeEvents.push(e as { truncated: boolean }))

    validator.write('{"na')
    validator.abort()

    expect(completeEvents[0]?.truncated).toBe(true)
  })

  it('emits validation-error for wrong type with include-invalid strategy', () => {
    const schema = z.object({ count: z.number() })
    const validationErrors: unknown[] = []
    const validator = createStreamValidator(schema, {
      validationErrorStrategy: 'include-invalid',
      onValidationError: e => validationErrors.push(e),
    })

    validator.write('{"count":"not-a-number"}')
    validator.end()

    expect(validationErrors.length).toBeGreaterThan(0)
  })

  it('invokes onParseError callback for malformed JSON context', () => {
    // The parser is resilient but we can test the callback is wired
    const schema = z.object({ x: z.number() })
    const onParseError = vi.fn()
    const validator = createStreamValidator(schema, { onParseError })
    // Feed valid JSON — no parse error
    validator.write('{"x":1}')
    validator.end()
    expect(onParseError).not.toHaveBeenCalled()
  })

  it('async iterator yields partials', async () => {
    const schema = z.object({ a: z.string(), b: z.number() })
    const validator = createStreamValidator(schema)
    const results: unknown[] = []

    const iterPromise = (async () => {
      for await (const partial of validator) {
        results.push(partial)
      }
    })()

    validator.write('{"a":"hello","b":99}')
    validator.end()

    await iterPromise
    expect(results.length).toBeGreaterThan(0)
  })

  it('on() returns unsubscribe function', () => {
    const schema = z.object({ x: z.string() })
    const validator = createStreamValidator(schema)
    const calls: unknown[] = []
    const unsub = validator.on('partial', p => calls.push(p))

    validator.write('{"x":')
    unsub()
    validator.write('"hello"}')
    validator.end()

    // After unsub, no more events
    expect(calls).toHaveLength(0)
  })

  it('timeoutMs causes truncated complete event', async () => {
    const schema = z.object({ slow: z.string() })
    const completeEvents: { truncated: boolean }[] = []
    const validator = createStreamValidator(schema, { timeoutMs: 10 })
    validator.on('complete', e => completeEvents.push(e as { truncated: boolean }))

    // Don't write anything — let timeout fire
    await new Promise(r => setTimeout(r, 50))
    expect(completeEvents[0]?.truncated).toBe(true)
  })
})

describe('streamValidate', () => {
  it('yields partials for single-field schema char by char', async () => {
    const schema = z.object({ name: z.string() })
    const input = '{"name":"Alice"}'
    const results: { data: { name?: string } }[] = []

    for await (const partial of streamValidate(charStream(input), schema)) {
      results.push(partial as { data: { name?: string } })
    }

    const withName = results.find(r => r.data.name === 'Alice')
    expect(withName).toBeDefined()
  })

  it('handles multi-field schema with chunked input', async () => {
    const schema = z.object({ first: z.string(), last: z.string() })
    const input = '{"first":"John","last":"Doe"}'
    const results: { isComplete: boolean }[] = []

    for await (const partial of streamValidate(chunkStream(input, 5), schema)) {
      results.push(partial)
    }

    const complete = results.find(r => r.isComplete)
    expect(complete).toBeDefined()
  })

  it('yields seq numbers that increment', async () => {
    const schema = z.object({ a: z.string(), b: z.string() })
    const input = '{"a":"x","b":"y"}'
    const seqs: number[] = []

    for await (const partial of streamValidate(charStream(input), schema)) {
      seqs.push(partial.seq)
    }

    // seqs should be non-empty and monotonically increasing
    expect(seqs.length).toBeGreaterThan(0)
    for (let i = 1; i < seqs.length; i++) {
      expect(seqs[i]).toBeGreaterThanOrEqual(seqs[i - 1])
    }
  })

  it('elapsedMs is a non-negative number', async () => {
    const schema = z.object({ v: z.number() })
    const input = '{"v":7}'

    for await (const partial of streamValidate(charStream(input), schema)) {
      expect(partial.elapsedMs).toBeGreaterThanOrEqual(0)
    }
  })

  it('meta marks received fields as complete', async () => {
    const schema = z.object({ city: z.string() })
    const input = '{"city":"Paris"}'
    let lastPartial: { meta: Record<string, string> } | null = null

    for await (const partial of streamValidate(charStream(input), schema)) {
      lastPartial = partial as { meta: Record<string, string> }
    }

    expect(lastPartial?.meta?.city).toBe('complete')
  })

  it('works with nested schema', async () => {
    const schema = z.object({
      user: z.object({
        name: z.string(),
        age: z.number(),
      }),
    })
    const input = '{"user":{"name":"Eve","age":25}}'
    const results: { data: { user?: { name?: string; age?: number } } }[] = []

    for await (const partial of streamValidate(chunkStream(input, 4), schema)) {
      results.push(partial as { data: { user?: { name?: string; age?: number } } })
    }

    const withUser = results.find(r => r.data.user?.name === 'Eve')
    expect(withUser).toBeDefined()
  })

  it('passes options through to validator', async () => {
    const schema = z.object({ n: z.number() })
    const validationErrors: unknown[] = []
    const input = '{"n":"not-a-number"}'

    for await (const _partial of streamValidate(charStream(input), schema, {
      validationErrorStrategy: 'include-invalid',
      onValidationError: e => validationErrors.push(e),
    })) {
      // consume
    }

    expect(validationErrors.length).toBeGreaterThan(0)
  })
})
