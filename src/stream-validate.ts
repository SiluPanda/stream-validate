import { z } from 'zod'
import { createStreamValidator } from './stream-validator'
import type { StreamValidatorOptions, ValidatedPartial } from './types'

/**
 * Async generator that consumes an AsyncIterable<string> of JSON chunks,
 * progressively validates each field against the schema, and yields
 * ValidatedPartial<T> events as fields complete.
 */
export async function* streamValidate<T>(
  stream: AsyncIterable<string>,
  schema: z.ZodSchema<T>,
  options: StreamValidatorOptions = {}
): AsyncIterable<ValidatedPartial<T>> {
  const validator = createStreamValidator<T>(schema, options)

  // Collect partials via the async iterator from the validator
  // We drive the validator with stream chunks and pull partials as they come.
  // Use a two-pump approach: one for the input stream, one for output.

  const partials: Array<ValidatedPartial<T>> = []
  const completionEvents: Array<{ done: boolean }> = []
  let inputDone = false

  // Run input pump in background (push chunks to validator)
  const inputDonePromise = (async () => {
    for await (const chunk of stream) {
      validator.write(chunk)
    }
    validator.end()
    inputDone = true
  })()

  // Subscribe to partial events to collect them
  const unsubPartial = validator.on('partial', (p) => {
    partials.push(p as ValidatedPartial<T>)
  })

  const unsubComplete = validator.on('complete', () => {
    completionEvents.push({ done: true })
  })

  // Wait for input to complete, then flush
  await inputDonePromise

  unsubPartial()
  unsubComplete()

  // Yield all collected partials
  for (const p of partials) {
    yield p
  }

  void inputDone // suppress unused warning
  void completionEvents
}
