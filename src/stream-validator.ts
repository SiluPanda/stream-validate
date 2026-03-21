import { z } from 'zod'
import { IncrementalJsonParser } from './parser'
import { ProgressiveValidator } from './validator'
import { TypedEmitter } from './events'
import type {
  StreamValidator,
  StreamValidatorOptions,
  ValidatedPartial,
  StreamCompletionEvent,
  StreamParseError,
  StreamValidationError,
} from './types'

type ValidatorEvents<T> = {
  partial: ValidatedPartial<T>
  complete: StreamCompletionEvent<T>
  'parse-error': StreamParseError
  'validation-error': StreamValidationError
}

export function createStreamValidator<T>(
  schema: z.ZodSchema<T>,
  options: StreamValidatorOptions = {}
): StreamValidator<T> {
  const parser = new IncrementalJsonParser()
  const validator = new ProgressiveValidator<T>(schema)
  const emitter = new TypedEmitter<ValidatorEvents<T>>()
  const startTime = Date.now()
  let currentPartial: ValidatedPartial<T> | null = null
  let done = false

  // Async iterator queue
  type QueueItem = { value: ValidatedPartial<T>; done: false } | { done: true }
  const queue: QueueItem[] = []
  const waiters: Array<(item: QueueItem) => void> = []

  function enqueue(item: QueueItem): void {
    if (waiters.length > 0) {
      const resolve = waiters.shift()!
      resolve(item)
    } else {
      queue.push(item)
    }
  }

  function processFields(fields: ReturnType<IncrementalJsonParser['feed']>): void {
    for (const field of fields) {
      const { partial, error } = validator.applyField(field.path, field.value, {
        strategy: options.validationErrorStrategy ?? 'skip',
      })
      currentPartial = partial

      if (error) {
        emitter.emit('validation-error', error)
        options.onValidationError?.(error)
      }

      emitter.emit('partial', partial)
      enqueue({ value: partial, done: false })

      if (partial.isComplete && !done) {
        done = true
        emitComplete(false)
      }
    }
  }

  function emitComplete(truncated: boolean): void {
    const totalMs = Date.now() - startTime
    const meta = currentPartial?.meta ?? {}
    const requiredPaths = validator.getRequiredPaths()
    const completedFields = Object.values(meta).filter(s => s === 'complete').length
    const totalFields = requiredPaths.length || Object.keys(meta).length

    const event: StreamCompletionEvent<T> = {
      data: (currentPartial?.data ?? {}) as T | import('./types').DeepPartial<T>,
      isComplete: !truncated && validator.isComplete(),
      truncated,
      totalMs,
      completedFields,
      totalFields,
      failedPaths: validator.getFailedPaths(),
    }
    emitter.emit('complete', event)
    enqueue({ done: true })
  }

  // Timeout handling
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined
  if (options.timeoutMs) {
    timeoutHandle = setTimeout(() => {
      if (!done) {
        done = true
        emitComplete(true)
      }
    }, options.timeoutMs)
  }

  // AbortSignal handling
  if (options.signal) {
    options.signal.addEventListener('abort', () => {
      if (!done) {
        done = true
        if (timeoutHandle) clearTimeout(timeoutHandle)
        emitComplete(true)
      }
    })
  }

  const streamValidator: StreamValidator<T> = {
    write(chunk: string): void {
      if (done) return
      try {
        const fields = parser.feed(chunk)
        processFields(fields)
      } catch (err) {
        const parseErr: StreamParseError = {
          message: err instanceof Error ? err.message : String(err),
          position: 0,
          path: '',
          elapsedMs: Date.now() - startTime,
        }
        emitter.emit('parse-error', parseErr)
        options.onParseError?.(parseErr)
      }
    },

    end(): void {
      if (done) return
      try {
        const fields = parser.end()
        processFields(fields)
      } catch (err) {
        const parseErr: StreamParseError = {
          message: err instanceof Error ? err.message : String(err),
          position: 0,
          path: '',
          elapsedMs: Date.now() - startTime,
        }
        emitter.emit('parse-error', parseErr)
        options.onParseError?.(parseErr)
      }
      if (!done) {
        done = true
        if (timeoutHandle) clearTimeout(timeoutHandle)
        emitComplete(false)
      }
    },

    abort(_error?: Error): void {
      if (done) return
      done = true
      if (timeoutHandle) clearTimeout(timeoutHandle)
      emitComplete(true)
    },

    on(event: 'partial' | 'complete' | 'parse-error' | 'validation-error', fn: (p: never) => void): () => void {
      return (emitter as TypedEmitter<Record<string, unknown>>).on(event, fn as (p: unknown) => void)
    },

    get current(): ValidatedPartial<T> | null {
      return currentPartial
    },

    [Symbol.asyncIterator](): AsyncIterator<ValidatedPartial<T>> {
      return {
        next(): Promise<IteratorResult<ValidatedPartial<T>>> {
          if (queue.length > 0) {
            const item = queue.shift()!
            if (item.done) return Promise.resolve({ value: undefined as unknown as ValidatedPartial<T>, done: true })
            return Promise.resolve({ value: item.value, done: false })
          }
          return new Promise<IteratorResult<ValidatedPartial<T>>>(resolve => {
            waiters.push((item: QueueItem) => {
              if (item.done) resolve({ value: undefined as unknown as ValidatedPartial<T>, done: true })
              else resolve({ value: item.value, done: false })
            })
          })
        },
      }
    },
  }

  return streamValidator
}
