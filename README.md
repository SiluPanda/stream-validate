# stream-validate

Progressive Zod validation for streaming LLM responses.

[![npm version](https://img.shields.io/npm/v/stream-validate.svg)](https://www.npmjs.com/package/stream-validate)
[![license](https://img.shields.io/npm/l/stream-validate.svg)](https://github.com/SiluPanda/stream-validate/blob/master/LICENSE)
[![node](https://img.shields.io/node/v/stream-validate.svg)](https://www.npmjs.com/package/stream-validate)
[![types](https://img.shields.io/npm/types/stream-validate.svg)](https://www.npmjs.com/package/stream-validate)

---

## Description

`stream-validate` incrementally parses JSON from any `AsyncIterable<string>` source and validates each field against a Zod schema as it completes. Instead of waiting for the entire response to arrive before parsing and validating, it yields typed partial objects progressively -- field by field -- as the stream delivers data.

This is designed for LLM streaming responses, where JSON payloads arrive token by token over several seconds. With `stream-validate`, your application can render each field the moment it is validated, rather than displaying a loading state until the final closing brace arrives.

**Key properties:**

- Provider-agnostic: accepts any `AsyncIterable<string>` -- works with OpenAI, Anthropic, Google Gemini, local models, or plain `fetch`.
- No network I/O: operates entirely in-process on streams the caller has already established.
- Minimal dependencies: only `zod` at runtime.
- Two APIs: a pull-based async generator (`streamValidate`) and a push-based event emitter (`createStreamValidator`).

---

## Installation

```bash
npm install stream-validate zod
```

`zod` is a peer dependency and must be installed alongside `stream-validate`.

**Requirements:** Node.js >= 18.

---

## Quick Start

### Pull-based: `streamValidate` async generator

```typescript
import { z } from 'zod';
import { streamValidate } from 'stream-validate';

const schema = z.object({
  name: z.string(),
  age: z.number(),
  address: z.object({ city: z.string() }),
});

// Any AsyncIterable<string> -- e.g. an LLM streaming response
async function* llmStream(): AsyncIterable<string> {
  yield '{"name":"Al';
  yield 'ice","age":30,"address":{"city":"NYC"}}';
}

for await (const partial of streamValidate(llmStream(), schema)) {
  console.log(partial.data);       // DeepPartial<T> -- fields filled in as they arrive
  console.log(partial.meta);       // { "name": "complete", "age": "complete", ... }
  console.log(partial.isComplete); // true when all required fields are validated
  console.log(partial.seq);        // monotonically increasing sequence number
  console.log(partial.elapsedMs);  // milliseconds since validation started
}
```

### Push-based: `createStreamValidator`

```typescript
import { z } from 'zod';
import { createStreamValidator } from 'stream-validate';

const schema = z.object({ name: z.string(), score: z.number() });

const validator = createStreamValidator(schema, {
  validationErrorStrategy: 'include-invalid',
  timeoutMs: 5000,
  onValidationError: (err) => console.error('Invalid field:', err.path, err.message),
  onParseError: (err) => console.error('Parse error:', err.message),
});

// Subscribe to events
const unsub = validator.on('partial', (partial) => {
  console.log('Got partial:', partial.data);
});

validator.on('complete', (event) => {
  console.log('Done:', event.isComplete, event.truncated, event.totalMs + 'ms');
  console.log('Failed paths:', event.failedPaths);
});

// Push chunks as they arrive
validator.write('{"name":"Bob"');
validator.write(',"score":95}');
validator.end();

// Inspect current state at any time
console.log(validator.current?.data);

// Unsubscribe when done
unsub();
```

---

## Features

- **Progressive field-by-field validation** -- each field is validated against the Zod schema the moment it completes in the stream, not after the entire JSON object is received.
- **Incremental JSON parser** -- a buffering scanner that handles arbitrary chunk boundaries, nested objects, arrays, escape sequences, and all JSON value types (strings, numbers, booleans, null).
- **Per-field status metadata** -- every emitted partial includes a `FieldMeta` map indicating which fields are `complete`, `active`, `pending`, or `error`.
- **Two consumption models** -- pull-based async generator (`streamValidate`) for `for await...of` loops, and push-based event emitter (`createStreamValidator`) for callback-driven architectures.
- **Async iterator on push-based validator** -- `createStreamValidator` also implements `Symbol.asyncIterator`, so it can be consumed with `for await...of`.
- **Configurable validation error strategies** -- choose `skip` (exclude invalid fields), `include-invalid` (include raw values), or `error` (mark as error and continue).
- **Timeout support** -- set `timeoutMs` to automatically abort long-running streams, emitting the best partial result with `truncated: true`.
- **AbortSignal support** -- pass an `AbortSignal` via the `signal` option to cancel validation externally.
- **Graceful stream interruption** -- if the stream ends prematurely (network error, `max_tokens` cutoff), the library emits the best partial available with truncation metadata.
- **Nested object and array support** -- validates deeply nested schemas with correct JSON path tracking (e.g., `address.city`, `items[0].name`).
- **Full TypeScript support** -- all exports are fully typed, with `DeepPartial<T>` inference from the Zod schema.

---

## API Reference

### `streamValidate<T>(stream, schema, options?)`

Async generator that consumes a stream of JSON chunks, progressively validates each field against the schema, and yields `ValidatedPartial<T>` objects as fields complete.

**Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `stream` | `AsyncIterable<string>` | Source of JSON chunks. |
| `schema` | `z.ZodSchema<T>` | Zod schema to validate against. |
| `options` | `StreamValidatorOptions` | Optional configuration (see below). |

**Returns:** `AsyncIterable<ValidatedPartial<T>>`

```typescript
import { z } from 'zod';
import { streamValidate } from 'stream-validate';

const schema = z.object({ city: z.string() });

for await (const partial of streamValidate(source, schema)) {
  if (partial.meta.city === 'complete') {
    console.log('City:', partial.data.city);
  }
}
```

---

### `createStreamValidator<T>(schema, options?)`

Factory function that returns a push-based `StreamValidator<T>` instance. Use this when you receive chunks via callbacks or event handlers rather than an async iterable.

**Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `schema` | `z.ZodSchema<T>` | Zod schema to validate against. |
| `options` | `StreamValidatorOptions` | Optional configuration (see below). |

**Returns:** `StreamValidator<T>`

---

### `StreamValidator<T>`

The push-based validator interface returned by `createStreamValidator`.

#### Methods

**`write(chunk: string): void`**

Push a new string chunk into the parser. Triggers incremental parsing and validation for the characters in the chunk. Calls after `end()` or `abort()` are silently ignored.

**`end(): void`**

Signal end of stream. Flushes any buffered content in the parser, runs final validations, and emits the `complete` event. The validator stops accepting further `write()` calls.

**`abort(error?: Error): void`**

Cancel the stream. Emits a `complete` event with `truncated: true` and the best partial result available at the time of cancellation.

#### Event Subscriptions

**`on(event: 'partial', fn: (p: ValidatedPartial<T>) => void): () => void`**

Subscribe to partial update events. Called each time a field completes and is validated. Returns an unsubscribe function.

**`on(event: 'complete', fn: (e: StreamCompletionEvent<T>) => void): () => void`**

Subscribe to the completion event. Called once when the stream ends (via `end()`, `abort()`, or timeout). Returns an unsubscribe function.

**`on(event: 'parse-error', fn: (e: StreamParseError) => void): () => void`**

Subscribe to JSON parse errors. Returns an unsubscribe function.

**`on(event: 'validation-error', fn: (e: StreamValidationError) => void): () => void`**

Subscribe to Zod validation errors on individual fields. Returns an unsubscribe function.

#### Properties

**`current: ValidatedPartial<T> | null`** (getter)

Returns the most recently emitted `ValidatedPartial<T>`, or `null` if no fields have completed yet.

#### Async Iteration

`StreamValidator<T>` implements `Symbol.asyncIterator`, so it can be consumed with `for await...of`:

```typescript
const validator = createStreamValidator(schema);

(async () => {
  for await (const partial of validator) {
    console.log(partial.data);
  }
})();

validator.write('{"name":"Charlie","score":88}');
validator.end();
```

---

### `StreamValidatorOptions`

Configuration options accepted by both `streamValidate` and `createStreamValidator`.

```typescript
interface StreamValidatorOptions {
  onParseError?: (err: StreamParseError) => void;
  onValidationError?: (err: StreamValidationError) => void;
  validationErrorStrategy?: 'skip' | 'include-invalid' | 'error';
  timeoutMs?: number;
  signal?: AbortSignal;
}
```

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `onParseError` | `(err: StreamParseError) => void` | `undefined` | Callback invoked when the JSON parser encounters invalid input. |
| `onValidationError` | `(err: StreamValidationError) => void` | `undefined` | Callback invoked when a completed field fails Zod validation. |
| `validationErrorStrategy` | `'skip' \| 'include-invalid' \| 'error'` | `'skip'` | How to handle fields that fail validation. `skip` excludes the field from the partial. `include-invalid` includes the raw value despite the validation failure. `error` marks the field as errored and continues. |
| `timeoutMs` | `number` | `undefined` | Maximum time in milliseconds to wait for the stream to complete. If exceeded, the validator emits a `complete` event with `truncated: true`. |
| `signal` | `AbortSignal` | `undefined` | An `AbortSignal` to cancel validation externally. When aborted, the validator emits a `complete` event with `truncated: true`. |

---

### `ValidatedPartial<T>`

Emitted by both APIs as fields complete validation.

```typescript
interface ValidatedPartial<T> {
  data: DeepPartial<T>;   // Partial object with validated fields filled in
  meta: FieldMeta;        // Per-field status map
  isComplete: boolean;    // true when all required fields have been validated
  seq: number;            // Monotonically increasing sequence number
  elapsedMs: number;      // Milliseconds since the validator was created
}
```

- `data` contains only fields that have been fully received and validated. Missing fields are `undefined`.
- `meta` maps field paths (e.g., `"name"`, `"address.city"`) to their current `FieldStatus`.
- `seq` starts at 1 and increments with each emitted partial.
- `isComplete` becomes `true` when every required field in the schema has status `complete`.

---

### `StreamCompletionEvent<T>`

Emitted once when the stream ends.

```typescript
interface StreamCompletionEvent<T> {
  data: T | DeepPartial<T>;  // Final data (full T if complete, partial otherwise)
  isComplete: boolean;        // true if all required fields validated
  truncated: boolean;         // true if stream was aborted or timed out
  totalMs: number;            // Total elapsed time in milliseconds
  completedFields: number;    // Number of fields that passed validation
  totalFields: number;        // Total number of fields in the schema
  failedPaths: string[];      // Paths of fields that failed validation
}
```

---

### `StreamValidationError`

Emitted when a completed field fails Zod validation.

```typescript
interface StreamValidationError {
  path: string;        // JSON path of the field (e.g., "name", "address.city")
  value: unknown;      // The raw value that failed validation
  message: string;     // Human-readable error message from Zod
  elapsedMs: number;   // Milliseconds since the validator was created
}
```

---

### `StreamParseError`

Emitted when the JSON parser encounters invalid input.

```typescript
interface StreamParseError {
  message: string;     // Description of the parse error
  position: number;    // Character position in the stream where the error occurred
  path: string;        // JSON path context at the time of the error
  elapsedMs: number;   // Milliseconds since the validator was created
}
```

---

### `FieldMeta`

A record mapping field paths to their current status.

```typescript
type FieldMeta = Record<string, FieldStatus>;
```

---

### `FieldStatus`

The possible states of a field during progressive validation.

```typescript
type FieldStatus = 'complete' | 'active' | 'pending' | 'error';
```

| Status | Meaning |
|--------|---------|
| `complete` | The field's value has been fully received and passed Zod validation. |
| `active` | The parser is currently receiving characters for this field. |
| `pending` | The parser has not yet reached this field. |
| `error` | The field's value failed Zod validation. |

---

### `DeepPartial<T>`

Utility type that makes all properties of `T` optional recursively.

```typescript
type DeepPartial<T> = T extends object ? { [P in keyof T]?: DeepPartial<T[P]> } : T;
```

---

## Configuration

### Validation Error Strategies

Control how the library handles fields that fail Zod validation:

**`skip` (default)** -- The invalid field is excluded from `data`. The field is marked as `error` in `meta`. Parsing continues with the next field.

```typescript
const validator = createStreamValidator(schema, {
  validationErrorStrategy: 'skip',
});
```

**`include-invalid`** -- The raw (unvalidated) value is included in `data` despite the validation failure. The field is still marked as `error` in `meta`, and a `validation-error` event is emitted.

```typescript
const validator = createStreamValidator(schema, {
  validationErrorStrategy: 'include-invalid',
});
```

**`error`** -- The field is marked as `error` in `meta` and excluded from `data`. Equivalent to `skip` in terms of data handling, but can be used in combination with `onValidationError` to implement custom abort logic.

```typescript
const validator = createStreamValidator(schema, {
  validationErrorStrategy: 'error',
  onValidationError: (err) => {
    if (err.path === 'criticalField') {
      validator.abort();
    }
  },
});
```

### Timeouts

Set a maximum duration for stream processing. If the timeout fires before the stream completes, the validator emits a `complete` event with `truncated: true`.

```typescript
const validator = createStreamValidator(schema, {
  timeoutMs: 10000, // 10 seconds
});

validator.on('complete', (event) => {
  if (event.truncated) {
    console.warn('Stream timed out. Partial result:', event.data);
  }
});
```

### AbortSignal

Use an `AbortController` to cancel validation externally:

```typescript
const controller = new AbortController();

const validator = createStreamValidator(schema, {
  signal: controller.signal,
});

// Cancel after 5 seconds
setTimeout(() => controller.abort(), 5000);
```

---

## Error Handling

### Parse Errors

JSON parse errors occur when the stream contains malformed JSON. Subscribe via the `parse-error` event or the `onParseError` callback:

```typescript
const validator = createStreamValidator(schema, {
  onParseError: (err) => {
    console.error(`Parse error at position ${err.position}: ${err.message}`);
  },
});

// Or via event subscription
validator.on('parse-error', (err) => {
  console.error(err.message);
});
```

### Validation Errors

Validation errors occur when a completed field does not conform to its Zod schema type. Subscribe via the `validation-error` event or the `onValidationError` callback:

```typescript
const validator = createStreamValidator(schema, {
  onValidationError: (err) => {
    console.error(`Validation failed at "${err.path}": ${err.message}`);
    console.error('Raw value:', err.value);
  },
});
```

### Stream Interruptions

When a stream ends prematurely (network failure, `max_tokens` cutoff, timeout, or abort), the `complete` event includes `truncated: true` and the best partial result available:

```typescript
validator.on('complete', (event) => {
  if (event.truncated) {
    console.warn(`Stream truncated after ${event.totalMs}ms.`);
    console.warn(`Completed ${event.completedFields}/${event.totalFields} fields.`);
    // event.data contains whatever was validated before interruption
  }
});
```

---

## Advanced Usage

### Consuming the Push-based Validator as an Async Iterator

The `StreamValidator` returned by `createStreamValidator` implements `Symbol.asyncIterator`. This bridges the push-based and pull-based models:

```typescript
const validator = createStreamValidator(schema);

const iteratorPromise = (async () => {
  for await (const partial of validator) {
    console.log(partial.seq, partial.data);
  }
  console.log('Stream complete');
})();

// Push data from another source (e.g., WebSocket, callback)
socket.on('data', (chunk: string) => validator.write(chunk));
socket.on('end', () => validator.end());

await iteratorPromise;
```

### Nested Schemas

`stream-validate` supports arbitrarily nested Zod object schemas. Fields are emitted with dot-notation paths, and nested objects are validated at each level:

```typescript
const schema = z.object({
  user: z.object({
    name: z.string(),
    profile: z.object({
      bio: z.string(),
      age: z.number(),
    }),
  }),
});

for await (const partial of streamValidate(source, schema)) {
  // Fields arrive progressively:
  // partial.data.user?.name        -- available once "name" completes
  // partial.data.user?.profile?.bio -- available once "bio" completes
  // partial.meta['user.name']      -- 'complete' | 'pending' | ...
}
```

### Inspecting Completion Details

The `complete` event provides a comprehensive summary of the validation run:

```typescript
validator.on('complete', (event) => {
  console.log('All fields validated:', event.isComplete);
  console.log('Stream was interrupted:', event.truncated);
  console.log('Total time:', event.totalMs, 'ms');
  console.log('Fields completed:', event.completedFields, '/', event.totalFields);
  console.log('Failed paths:', event.failedPaths);
});
```

### Combining with Fetch

Use `stream-validate` with any streaming HTTP response:

```typescript
const response = await fetch('https://api.example.com/llm/stream');
const reader = response.body!.getReader();
const decoder = new TextDecoder();

async function* readStream(): AsyncIterable<string> {
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    yield decoder.decode(value, { stream: true });
  }
}

const schema = z.object({ summary: z.string(), score: z.number() });

for await (const partial of streamValidate(readStream(), schema)) {
  updateUI(partial.data);
}
```

### Aborting Mid-Stream

Use `abort()` on the push-based validator to stop processing immediately. The `complete` event is emitted with `truncated: true`:

```typescript
const validator = createStreamValidator(schema);

validator.on('complete', (event) => {
  console.log('Truncated:', event.truncated); // true
  console.log('Best partial:', event.data);
});

validator.write('{"name":"Alice"');
// Decide to stop early
validator.abort();
```

---

## TypeScript

`stream-validate` is written in TypeScript and ships with full type declarations. All exported types are available for import:

```typescript
import { streamValidate, createStreamValidator } from 'stream-validate';
import type {
  DeepPartial,
  FieldStatus,
  FieldMeta,
  ValidatedPartial,
  StreamCompletionEvent,
  StreamValidationError,
  StreamParseError,
  StreamValidatorOptions,
  StreamValidator,
} from 'stream-validate';
```

The generic type parameter `T` is inferred from the Zod schema:

```typescript
const schema = z.object({ name: z.string(), age: z.number() });

// T is inferred as { name: string; age: number }
for await (const partial of streamValidate(source, schema)) {
  // partial.data is DeepPartial<{ name: string; age: number }>
  // partial.data.name is string | undefined
  // partial.data.age is number | undefined
}
```

The `DeepPartial<T>` utility type makes all properties optional recursively, ensuring type-safe access to fields that may not have arrived yet.

---

## License

MIT
