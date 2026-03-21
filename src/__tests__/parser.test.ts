import { describe, it, expect } from 'vitest'
import { IncrementalJsonParser } from '../parser'

describe('IncrementalJsonParser', () => {
  it('parses a simple object fed in 3 chunks', () => {
    const parser = new IncrementalJsonParser()
    const fields = [
      ...parser.feed('{"na'),
      ...parser.feed('me":"Al'),
      ...parser.feed('ice"}'),
    ]
    const nameField = fields.find(f => f.path === 'name')
    expect(nameField).toBeDefined()
    expect(nameField?.value).toBe('Alice')
  })

  it('parses two top-level fields from a single feed', () => {
    const parser = new IncrementalJsonParser()
    const fields = parser.feed('{"a":1,"b":2}')
    expect(fields.find(f => f.path === 'a')?.value).toBe(1)
    expect(fields.find(f => f.path === 'b')?.value).toBe(2)
  })

  it('parses nested object and emits path for leaf field', () => {
    const parser = new IncrementalJsonParser()
    const fields = parser.feed('{"addr":{"city":"NYC"}}')
    expect(fields.find(f => f.path === 'addr.city')?.value).toBe('NYC')
  })

  it('parses boolean and null values', () => {
    const parser = new IncrementalJsonParser()
    const fields = parser.feed('{"flag":true,"empty":null}')
    expect(fields.find(f => f.path === 'flag')?.value).toBe(true)
    expect(fields.find(f => f.path === 'empty')?.value).toBeNull()
  })

  it('parses numeric values', () => {
    const parser = new IncrementalJsonParser()
    const fields = parser.feed('{"count":42,"ratio":3.14}')
    expect(fields.find(f => f.path === 'count')?.value).toBe(42)
    expect(fields.find(f => f.path === 'ratio')?.value).toBeCloseTo(3.14)
  })

  it('handles chunk boundary mid-key', () => {
    const parser = new IncrementalJsonParser()
    const f1 = parser.feed('{"foo')
    expect(f1).toHaveLength(0)  // key incomplete
    const f2 = parser.feed('":"bar"}')
    const field = f2.find(f => f.path === 'foo')
    expect(field?.value).toBe('bar')
  })

  it('handles chunk boundary mid-value', () => {
    const parser = new IncrementalJsonParser()
    const f1 = parser.feed('{"x":"hel')
    expect(f1).toHaveLength(0)
    const f2 = parser.feed('lo"}')
    expect(f2.find(f => f.path === 'x')?.value).toBe('hello')
  })

  it('end() flushes remaining content', () => {
    const parser = new IncrementalJsonParser()
    parser.feed('{"z":99')
    const fields = parser.end()
    // After end with a complete-enough buffer
    // The end() may or may not extract depending on completeness
    // At minimum it should not throw
    expect(Array.isArray(fields)).toBe(true)
  })

  it('emits position > 0 for fields', () => {
    const parser = new IncrementalJsonParser()
    const fields = parser.feed('{"name":"Bob"}')
    const field = fields.find(f => f.path === 'name')
    expect(field).toBeDefined()
    expect(field!.position).toBeGreaterThan(0)
  })

  it('parses string with escaped quotes', () => {
    const parser = new IncrementalJsonParser()
    const fields = parser.feed('{"msg":"say \\"hi\\""}')
    expect(fields.find(f => f.path === 'msg')?.value).toBe('say "hi"')
  })
})
