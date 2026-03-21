import type { z } from 'zod'

export type DeepPartial<T> = T extends object ? { [P in keyof T]?: DeepPartial<T[P]> } : T

export type FieldStatus = 'complete' | 'active' | 'pending' | 'error'
export type FieldMeta = Record<string, FieldStatus>

export interface ValidatedPartial<T> {
  data: DeepPartial<T>
  meta: FieldMeta
  isComplete: boolean
  seq: number
  elapsedMs: number
}

export interface StreamCompletionEvent<T> {
  data: T | DeepPartial<T>
  isComplete: boolean
  truncated: boolean
  totalMs: number
  completedFields: number
  totalFields: number
  failedPaths: string[]
}

export interface StreamValidationError {
  path: string
  value: unknown
  message: string
  elapsedMs: number
}

export interface StreamParseError {
  message: string
  position: number
  path: string
  elapsedMs: number
}

export interface StreamValidatorOptions {
  onParseError?: (err: StreamParseError) => void
  onValidationError?: (err: StreamValidationError) => void
  validationErrorStrategy?: 'skip' | 'include-invalid' | 'error'
  timeoutMs?: number
  signal?: AbortSignal
}

export interface StreamValidator<T> {
  write(chunk: string): void
  end(): void
  abort(error?: Error): void
  on(event: 'partial', fn: (p: ValidatedPartial<T>) => void): () => void
  on(event: 'complete', fn: (e: StreamCompletionEvent<T>) => void): () => void
  on(event: 'parse-error', fn: (e: StreamParseError) => void): () => void
  on(event: 'validation-error', fn: (e: StreamValidationError) => void): () => void
  get current(): ValidatedPartial<T> | null
  [Symbol.asyncIterator](): AsyncIterator<ValidatedPartial<T>>
}

export type _ZodSchemaRef = z.ZodSchema<unknown>
