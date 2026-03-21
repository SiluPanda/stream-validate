# stream-validate

Progressive Zod validation for streaming LLM responses. Parse and validate JSON incrementally as it arrives chunk-by-chunk, emitting typed partial results as each field completes.

## Install

```bash
npm install stream-validate zod
```

## Quick Start — `streamValidate` async generator

```typescript
import { z } from 'zod'
import { streamValidate } from 'stream-validate'

const schema = z.object({
  name: z.string(),
  age: z.number(),
  address: z.object({ city: z.string() }),
})

// Any AsyncIterable<string> — e.g. an LLM streaming response
async function* llmStream(): AsyncIterable<string> {
  yield '{"name":"Al'
  yield 'ice","age":30,"address":{"city":"NYC"}}'
}

for await (const partial of streamValidate(llmStream(), schema)) {
  console.log(partial.data)       // DeepPartial<T> — fields filled in as they arrive
  console.log(partial.meta)       // { "name": "complete", "age": "pending", ... }
  console.log(partial.isComplete) // true when all required fields are validated
  console.log(partial.seq)        // monotonically increasing sequence number
  console.log(partial.elapsedMs)  // ms since validation started
}
```

## Push-based API — `createStreamValidator`

```typescript
import { z } from 'zod'
import { createStreamValidator } from 'stream-validate'

const schema = z.object({ name: z.string(), score: z.number() })

const validator = createStreamValidator(schema, {
  validationErrorStrategy: 'skip', // 'skip' | 'include-invalid' | 'error'
  timeoutMs: 5000,
  onValidationError: (err) => console.error('Invalid field', err.path, err.message),
  onParseError: (err) => console.error('Parse error', err.message),
})

// Subscribe to events
const unsub = validator.on('partial', (partial) => {
  console.log('Got partial:', partial.data)
})

validator.on('complete', (event) => {
  console.log('Done:', event.isComplete, event.truncated, event.totalMs + 'ms')
  console.log('Failed paths:', event.failedPaths)
})

// Push chunks as they arrive
validator.write('{"name":"Bob"')
validator.write(',"score":95}')
validator.end() // flush and emit final complete event

// Inspect current state at any time
console.log(validator.current?.data)

// Unsubscribe
unsub()

// Abort mid-stream (emits complete with truncated=true)
validator.abort()
```

### Async iterator on validator

```typescript
const validator = createStreamValidator(schema)

;(async () => {
  for await (const partial of validator) {
    console.log(partial.data)
  }
})()

validator.write('{"name":"Charlie","score":88}')
validator.end()
```

## API

### `streamValidate<T>(stream, schema, options?)`

| Parameter | Type | Description |
|---|---|---|
| `stream` | `AsyncIterable<string>` | Source of JSON chunks |
| `schema` | `z.ZodSchema<T>` | Zod schema to validate against |
| `options` | `StreamValidatorOptions` | Optional configuration |

Returns `AsyncIterable<ValidatedPartial<T>>`.

### `createStreamValidator<T>(schema, options?)`

Returns a `StreamValidator<T>` with:

- `write(chunk: string)` — push a new chunk
- `end()` — signal end of stream
- `abort(error?)` — cancel with truncated=true
- `on('partial', fn)` — subscribe to partial updates; returns unsubscribe function
- `on('complete', fn)` — subscribe to final completion event
- `on('parse-error', fn)` — subscribe to JSON parse errors
- `on('validation-error', fn)` — subscribe to Zod validation errors
- `current` — getter for the latest `ValidatedPartial<T>` or `null`
- `[Symbol.asyncIterator]()` — async iterate over partials

### `StreamValidatorOptions`

```typescript
interface StreamValidatorOptions {
  onParseError?: (err: StreamParseError) => void
  onValidationError?: (err: StreamValidationError) => void
  validationErrorStrategy?: 'skip' | 'include-invalid' | 'error'
  timeoutMs?: number
  signal?: AbortSignal
}
```

### `ValidatedPartial<T>`

```typescript
interface ValidatedPartial<T> {
  data: DeepPartial<T>    // partial object filled in so far
  meta: FieldMeta         // per-field status: 'complete' | 'active' | 'pending' | 'error'
  isComplete: boolean     // true when all required fields validated
  seq: number             // monotonically increasing
  elapsedMs: number       // ms since validator created
}
```

## License

MIT
