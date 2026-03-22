import { z } from 'zod'
import type { ValidatedPartial, FieldMeta, FieldStatus, StreamValidationError } from './types'

/**
 * Navigate a Zod schema to a sub-schema by dot/bracket path.
 * e.g. path "address.city" on z.object({address: z.object({city: z.string()})})
 * returns the z.string() schema.
 * Returns null if the path can't be resolved.
 */
function getSubSchema(schema: z.ZodTypeAny, path: string): z.ZodTypeAny | null {
  if (!path) return schema

  // Unwrap optional/nullable/default wrappers
  let s: z.ZodTypeAny = schema
  while (
    s instanceof z.ZodOptional ||
    s instanceof z.ZodNullable ||
    s instanceof z.ZodDefault
  ) {
    s = s._def.innerType as z.ZodTypeAny
  }

  const parts = path.replace(/\[(\d+)\]/g, '.$1').split('.')
  const [head, ...rest] = parts
  const restPath = rest.join('.')

  if (s instanceof z.ZodObject) {
    const shape = s.shape as Record<string, z.ZodTypeAny>
    if (!(head in shape)) return null
    return getSubSchema(shape[head], restPath)
  }

  if (s instanceof z.ZodArray) {
    // head is an array index — recurse into element type
    return getSubSchema(s._def.type as z.ZodTypeAny, restPath)
  }

  return null
}

/**
 * Set a value at a dot/bracket path in a nested object (mutates).
 */
function setAtPath(obj: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.replace(/\[(\d+)\]/g, '.$1').split('.')
  let cur: Record<string, unknown> = obj
  for (let i = 0; i < parts.length - 1; i++) {
    const k = parts[i]
    if (cur[k] === undefined || cur[k] === null || typeof cur[k] !== 'object') {
      cur[k] = {}
    }
    cur = cur[k] as Record<string, unknown>
  }
  cur[parts[parts.length - 1]] = value
}

/**
 * Collect all required field paths from a Zod schema.
 */
function collectRequiredPaths(schema: z.ZodTypeAny, prefix = ''): string[] {
  let s: z.ZodTypeAny = schema
  const isOptional = s instanceof z.ZodOptional
  while (
    s instanceof z.ZodOptional ||
    s instanceof z.ZodNullable ||
    s instanceof z.ZodDefault
  ) {
    s = s._def.innerType as z.ZodTypeAny
  }

  if (s instanceof z.ZodObject) {
    const paths: string[] = []
    const shape = s.shape as Record<string, z.ZodTypeAny>
    for (const [k, v] of Object.entries(shape)) {
      const childPaths = collectRequiredPaths(v, prefix ? `${prefix}.${k}` : k)
      paths.push(...childPaths)
    }
    return paths
  }

  // Leaf node
  if (isOptional) return []
  return prefix ? [prefix] : []
}

export class ProgressiveValidator<T> {
  private data: Record<string, unknown> = {}
  private meta: FieldMeta = {}
  private seq = 0
  private startTime = Date.now()
  private requiredPaths: string[]
  private failedPaths: string[] = []

  constructor(private schema: z.ZodSchema<T>) {
    this.requiredPaths = collectRequiredPaths(schema as z.ZodTypeAny)
  }

  applyField(
    path: string,
    value: unknown,
    options?: { strategy?: 'skip' | 'include-invalid' | 'error' }
  ): { partial: ValidatedPartial<T>; error?: StreamValidationError } {
    const strategy = options?.strategy ?? 'skip'
    const subSchema = getSubSchema(this.schema as z.ZodTypeAny, path)
    let status: FieldStatus = 'complete'
    let validationError: StreamValidationError | undefined

    if (subSchema) {
      const result = subSchema.safeParse(value)
      if (!result.success) {
        const message = result.error.errors.map(e => e.message).join('; ')
        validationError = {
          path,
          value,
          message,
          elapsedMs: Date.now() - this.startTime,
        }
        status = 'error'
        this.failedPaths.push(path)

        if (strategy === 'skip') {
          // Don't set the value, mark as error and return
          this.meta[path] = 'error'
          this.seq++
          return { partial: this.buildPartial(), error: validationError }
        } else if (strategy === 'error') {
          this.meta[path] = 'error'
          this.seq++
          return { partial: this.buildPartial(), error: validationError }
        }
        // include-invalid: fall through and set value anyway
      }
    }

    setAtPath(this.data, path, value)
    this.meta[path] = status
    this.seq++

    return { partial: this.buildPartial(), error: validationError }
  }

  isComplete(): boolean {
    if (this.requiredPaths.length === 0) {
      // No required paths detected — check if we have any data
      return Object.keys(this.meta).length > 0
    }
    return this.requiredPaths.every(p => this.meta[p] === 'complete')
  }

  getFailedPaths(): string[] {
    return this.failedPaths.slice()
  }

  getRequiredPaths(): string[] {
    return this.requiredPaths.slice()
  }

  buildPartial(): ValidatedPartial<T> {
    return {
      data: this.data as import('./types').DeepPartial<T>,
      meta: { ...this.meta },
      isComplete: this.isComplete(),
      seq: this.seq,
      elapsedMs: Date.now() - this.startTime,
    }
  }
}
