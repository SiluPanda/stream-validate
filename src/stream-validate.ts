import { z } from 'zod'
import { createStreamValidator } from './stream-validator'
import type { StreamValidatorOptions, ValidatedPartial } from './types'

/**
 * Async generator that consumes an AsyncIterable<string> of JSON chunks,
 * progressively validates each field against the schema, and yields
 * ValidatedPartial<T> events as fields complete.
 *
 * Partials are yielded as they are produced — the input stream is pumped
 * concurrently so that callers receive each field the moment it validates,
 * rather than waiting for the entire stream to finish.
 */
export async function* streamValidate<T>(
  stream: AsyncIterable<string>,
  schema: z.ZodSchema<T>,
  options: StreamValidatorOptions = {}
): AsyncIterable<ValidatedPartial<T>> {
  const validator = createStreamValidator<T>(schema, options)

  // Pump the input stream in the background so the async iterator and the
  // input feed run concurrently. This is what enables progressive yielding.
  const inputDonePromise = (async () => {
    for await (const chunk of stream) {
      validator.write(chunk)
    }
    validator.end()
  })()

  // Consume partials from the validator's async iterator as they are produced.
  // The iterator resolves each item as soon as the background pump feeds
  // enough data to complete a field, so callers see progressive updates.
  for await (const partial of validator) {
    yield partial
  }

  // Ensure the input pump has fully completed before the generator returns.
  await inputDonePromise
}
