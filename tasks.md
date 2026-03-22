# stream-validate — Task Breakdown

Comprehensive task list derived from [SPEC.md](./SPEC.md). Every feature, configuration option, error handling case, and edge case from the spec is mapped to at least one task.

---

## Phase 1: Project Setup and Scaffolding

- [ ] **Install dev dependencies** — Add `typescript`, `vitest`, `eslint`, `@types/node`, and `zod` (as peer dep) to `package.json`. Install them and verify `npm run build`, `npm run test`, and `npm run lint` all execute without error (even if there are no tests yet). | Status: not_done
- [ ] **Configure peer dependency on Zod** — Add `"peerDependencies": { "zod": "^3.22.0" }` to `package.json`. Ensure Zod is also in devDependencies for development/testing. | Status: not_done
- [ ] **Create directory structure** — Create all directories specified in the file structure: `src/parser/`, `src/validation/`, `src/adapters/`, `src/__tests__/parser/`, `src/__tests__/validation/`, `src/__tests__/adapters/`, `src/__tests__/integration/`, `src/__tests__/integration/fixtures/`. | Status: not_done
- [ ] **Create stub files for all modules** — Create empty/placeholder files for every module listed in the file structure (Section 17): `src/index.ts`, `src/stream-validate.ts`, `src/stream-validator.ts`, `src/parser/incremental-parser.ts`, `src/parser/states.ts`, `src/parser/path-tracker.ts`, `src/validation/progressive-validator.ts`, `src/validation/schema-map.ts`, `src/validation/deep-partial.ts`, `src/adapters/openai.ts`, `src/adapters/anthropic.ts`, `src/adapters/gemini.ts`, `src/adapters/fetch.ts`, `src/adapters/sse.ts`, `src/types.ts`, `src/testing.ts`. Verify the project compiles with `npm run build`. | Status: not_done
- [x] **Configure ESLint** — Set up ESLint with a TypeScript-aware configuration. Ensure `npm run lint` runs cleanly on the stub files. | Status: done
- [x] **Configure Vitest** — Ensure `vitest` is configured properly (vitest.config.ts or package.json config) so `npm run test` discovers and runs test files in `src/__tests__/`. | Status: done

---

## Phase 2: Type Definitions (`src/types.ts`)

- [x] **Define `DeepPartial<T>` utility type** — Implement the recursive `DeepPartial<T>` type as specified: object fields become optional recursively, arrays remain arrays (not optional arrays of optional elements) but are optional at the field level. | Status: done
- [x] **Define `ValidatedPartial<T>` interface** — Define with fields: `data: DeepPartial<T>`, `meta: FieldMeta`, `isComplete: boolean`, `seq: number`, `elapsedMs: number`. | Status: done
- [x] **Define `FieldMeta` and `FieldStatus` types** — `FieldMeta` is `Record<string, FieldStatus>`. `FieldStatus` is the union `'complete' | 'active' | 'pending' | 'error'`. | Status: done
- [ ] **Define `StreamValidatorOptions` interface** — Include all options: `onParseError`, `validationErrorStrategy`, `coerce`, `emitStrategy`, `debounceMs`, `emitPaths`, `maxDepth`, `timeoutMs`, `signal`, `onField`, `onValidationError`, `onError`. Each field must have the correct type, default annotation in JSDoc, and be optional. | Status: not_done
- [ ] **Define `StreamValidationError` interface** — Fields: `path: string`, `value: unknown`, `zodError: z.ZodError`, `elapsedMs: number`. | Status: not_done
- [ ] **Define `StreamParseError` interface** — Fields: `message: string`, `position: number`, `path: string`, `char?: string`, `elapsedMs: number`. | Status: not_done
- [ ] **Define `StreamCompletionEvent<T>` interface** — Fields: `data: T | DeepPartial<T>`, `isComplete: boolean`, `truncated: boolean`, `totalMs: number`, `completedFields: number`, `totalFields: number`, `failedPaths: string[]`, `pendingPaths: string[]`. | Status: not_done
- [ ] **Define `FieldCompletionEvent` interface (internal)** — Fields: `path: string`, `value: unknown`, `type: 'string' | 'number' | 'boolean' | 'null' | 'object' | 'array'`, `startPosition: number`, `endPosition: number`. | Status: not_done
- [ ] **Define `FieldStartEvent` interface (internal)** — For parser-emitted field start events. Fields: `path: string`, `type: string (anticipated)`, `position: number`. | Status: not_done
- [ ] **Define `StreamValidator<T>` interface** — Define the push-based API interface with: `write(chunk: string): void`, `end(): void`, `abort(error?: Error): void`, `on(event, listener)` overloads for `'partial'`, `'field'`, `'complete'`, `'validation-error'`, `'parse-error'`, `off(event, listener)`, `get current()`, `[Symbol.asyncIterator]()`. | Status: not_done

---

## Phase 3: Incremental JSON Parser — Core State Machine

### Parser States and Context (`src/parser/states.ts`)

- [ ] **Define parser state enum** — Create an enum (or string union) for all parser states: `VALUE_START`, `OBJECT_START`, `OBJECT_KEY`, `OBJECT_COLON`, `OBJECT_VALUE`, `OBJECT_COMMA`, `ARRAY_START`, `ARRAY_VALUE`, `ARRAY_COMMA`, `STRING`, `STRING_ESCAPE`, `NUMBER`, `LITERAL`, `DONE`. | Status: not_done
- [ ] **Define parse context type** — A stack frame containing: current state, accumulated value buffer (for strings/numbers/literals), expected literal (for `LITERAL` state), current object key (for object contexts), array index (for array contexts), and a reference to value type being accumulated. | Status: not_done

### Path Tracker (`src/parser/path-tracker.ts`)

- [ ] **Implement JSON path stack** — Maintain a stack of path segments. Support pushing object keys (dot notation: `$.name`, `$.address.city`) and array indices (bracket notation: `$.items[0]`). Support popping segments when exiting contexts. | Status: not_done
- [ ] **Implement `currentPath()` method** — Return the string representation of the current JSON path by joining all segments (e.g., `$.address.city`, `$.items[2].name`). | Status: not_done
- [ ] **Handle path updates on object key read** — When an object key is fully read, update the path to include the new key (pop old key if present, push new key). | Status: not_done
- [ ] **Handle path updates on array element transitions** — Maintain an index counter per array context. Increment on each new element. The path segment for array elements is `[index]`. | Status: not_done

### Incremental Parser (`src/parser/incremental-parser.ts`)

- [x] **Implement core `feed(chunk: string)` method** — Accept a string chunk, iterate over each character, and call the character-processing state machine. Maintain character position counter for error reporting. | Status: done
- [ ] **Implement `VALUE_START` state transitions** — Detect the start of each value type based on the first character: `{` -> push object context, `[` -> push array context, `"` -> enter `STRING`, digit/`-` -> enter `NUMBER`, `t`/`f`/`n` -> enter `LITERAL`. Skip whitespace. Emit `FieldStartEvent` when entering a value. | Status: not_done
- [ ] **Implement string parsing (`STRING` state)** — Accumulate characters into a string buffer. Handle transition to `STRING_ESCAPE` on `\`. On unescaped closing `"`, emit `FieldCompletionEvent` with the accumulated string value and transition to the parent state. | Status: not_done
- [ ] **Implement escape sequence handling (`STRING_ESCAPE` state)** — Handle all JSON escape sequences: `\"`, `\\`, `\/`, `\b`, `\f`, `\n`, `\r`, `\t`. Resolve each escape to its actual character. Transition back to `STRING` state after processing. | Status: not_done
- [ ] **Implement `\uXXXX` Unicode escape handling** — After `\u`, accumulate exactly 4 hex digits, then convert to character via `String.fromCharCode`. Handle surrogate pairs: detect high surrogate (`\uD800`-`\uDBFF`) followed by `\u` and low surrogate (`\uDC00`-`\uDFFF`), combine with `String.fromCodePoint`. | Status: not_done
- [ ] **Implement number parsing (`NUMBER` state)** — Accumulate characters valid in a JSON number: digits, `.`, `e`, `E`, `+`, `-`. On a non-numeric delimiter (`,`, `}`, `]`, whitespace, EOF), terminate: parse with `Number()`, check for `NaN`/`!isFinite`, emit `FieldCompletionEvent` or `ParseError`. Do not consume the terminating character (re-process it in parent state). | Status: not_done
- [ ] **Implement literal parsing (`LITERAL` state)** — Match characters against the expected literal (`true`, `false`, `null`) one at a time. On successful match of all characters, emit `FieldCompletionEvent` with the parsed value (`true`, `false`, or `null`). On mismatch, emit `ParseError`. | Status: not_done
- [ ] **Implement object parsing (`OBJECT_START`, `OBJECT_KEY`, `OBJECT_COLON`, `OBJECT_VALUE`, `OBJECT_COMMA`)** — `OBJECT_START`: expect `"` (key start) or `}` (empty object). `OBJECT_KEY`: delegate to string parsing for the key. `OBJECT_COLON`: expect `:`. `OBJECT_VALUE`: delegate to `VALUE_START` for the value. `OBJECT_COMMA`: expect `,` (next key-value pair) or `}` (end object). On `}`, pop context, emit object completion event. | Status: not_done
- [ ] **Implement array parsing (`ARRAY_START`, `ARRAY_VALUE`, `ARRAY_COMMA`)** — `ARRAY_START`: expect `]` (empty array) or a value. `ARRAY_VALUE`: delegate to `VALUE_START`. `ARRAY_COMMA`: expect `,` (next element) or `]` (end array). On `]`, pop context, emit array completion event. Maintain element index counter. | Status: not_done
- [ ] **Implement composite value completion events** — When an object `}` or array `]` is reached, emit a `FieldCompletionEvent` for the composite value containing the fully constructed object/array. Inner field completions have already been emitted individually during parsing. | Status: not_done
- [x] **Implement whitespace skipping** — Skip space, tab, newline, and carriage return in all states except `STRING` and `STRING_ESCAPE`, where they are accumulated as part of the string value. | Status: done
- [ ] **Implement maximum nesting depth enforcement** — Track current nesting depth. If it exceeds `maxDepth` (default 64) when pushing a new context, emit a `ParseError` with a descriptive message. | Status: not_done
- [ ] **Implement `DONE` state** — After the root-level value completes, transition to `DONE`. Any non-whitespace characters after `DONE` emit a `ParseError`. | Status: not_done
- [ ] **Implement end-of-stream handling** — When the stream ends (no more chunks), check the state stack. If the stack is not empty (incomplete JSON), handle gracefully: finalize any in-progress number (emit if valid), discard in-progress strings, and report truncation. | Status: not_done

### Error Recovery

- [ ] **Implement `abort` error recovery strategy** — On `ParseError`, stop parsing immediately. The pipeline terminates with the current partial. | Status: not_done
- [ ] **Implement `skip-value` error recovery strategy (default)** — On `ParseError`, skip characters until reaching a recovery point (`,`, `}`, `]`). Resume parsing from the recovery point. Exclude the invalid field from the partial. | Status: not_done
- [ ] **Implement `skip-to-next-key` error recovery strategy** — On `ParseError`, skip characters until the next object key is found (next `"` in an object context). Resume key parsing from there. | Status: not_done
- [ ] **Handle unrecoverable errors** — For malformations like unmatched braces where the parser cannot determine context end, enter an error state: stop emitting field completions but continue consuming input to allow the source stream to drain. | Status: not_done

---

## Phase 4: Progressive Validation

### Schema Map (`src/validation/schema-map.ts`)

- [ ] **Implement Zod schema traversal** — Recursively traverse a `z.object()` schema starting from root path `$`. For each key, record `$.key -> zodType`. For nested `z.object()`, recurse with extended path. For `z.array(elementSchema)`, record the array path and, if the element is `z.object()`, recurse with `$.key[*]` wildcard path. | Status: not_done
- [ ] **Handle Zod wrapper types during traversal** — Unwrap `z.optional()`, `z.nullable()`, `z.default()`, `z.transform()`, and `z.pipe()` to find the inner type for map construction. Retain the full wrapper chain for validation. | Status: not_done
- [ ] **Implement path-to-schema lookup** — Given a concrete JSON path like `$.tags[2]`, look up in the schema map. For array element paths, match against wildcard patterns (e.g., `$.tags[2]` matches `$.tags[*]`). For deeply nested array elements, support multi-level wildcard matching (e.g., `$.items[0].mentions[1]` matches `$.items[*].mentions[*]`). | Status: not_done
- [ ] **Count total fields in schema** — Traverse the schema to count all leaf fields (for `StreamCompletionEvent.totalFields`). Handle nested objects, arrays, and optional fields. | Status: not_done

### Deep Partial Type Utility (`src/validation/deep-partial.ts`)

- [x] **Implement `DeepPartial<T>` type export** — Export the `DeepPartial<T>` utility type for consumers. Ensure it handles objects (all keys optional), arrays (remain arrays but optional at field level), and primitives (unchanged). | Status: done

### Progressive Validator (`src/validation/progressive-validator.ts`)

- [x] **Implement per-field validation** — On receiving a `FieldCompletionEvent`, look up the Zod type from the SchemaMap, call `.safeParse(value)`. On success, add the value to the partial object at the correct path. On failure, emit a `StreamValidationError`. | Status: done
- [ ] **Implement partial object construction with immutability** — Each new field completion produces a new partial object via shallow structural cloning. Previous partial references remain unchanged. Leaf values (primitives) are shared; object references at each nesting level are new. | Status: not_done
- [x] **Implement setting values at nested paths** — Support setting values at arbitrary JSON paths (e.g., `$.address.city = "Portland"`) in the partial object. Create intermediate objects as needed. For array paths, ensure the array is extended to include the new element. | Status: done
- [ ] **Implement field metadata tracking** — Maintain a `FieldMeta` map. Initialize all schema fields as `pending`. Transition fields to `active` on `FieldStartEvent`. Transition to `complete` on successful validation. Transition to `error` on failed validation. | Status: not_done
- [x] **Implement `isComplete` detection** — After each field completion, check if all fields in the schema have status `complete`. Set `isComplete: true` on the `ValidatedPartial` when all fields are validated. | Status: done
- [x] **Implement sequence number tracking** — Maintain a monotonically increasing counter (`seq`). Increment on each emitted `ValidatedPartial`. First emission is `seq: 1`. | Status: done
- [x] **Implement elapsed time tracking** — Record the start time when the validator is created. Compute `elapsedMs` for each `ValidatedPartial` and error event as `Date.now() - startTime` (or `performance.now()` equivalent). | Status: done
- [ ] **Implement composite value validation** — When a nested object or array completes, run the full Zod validation on the composite value (the complete object/array). This catches cross-field `.refine()` constraints. Individual leaf validations have already occurred. | Status: not_done
- [x] **Implement `exclude` validation error strategy (default)** — On Zod validation failure, exclude the invalid field from the partial. Continue parsing other fields. Emit `StreamValidationError`. | Status: done
- [x] **Implement `include-raw` validation error strategy** — On Zod validation failure, include the raw (unvalidated) value in the partial with a flag indicating it is unvalidated. Emit `StreamValidationError`. | Status: done
- [ ] **Implement `abort` validation error strategy** — On Zod validation failure, stop the pipeline. Yield the current partial and end the stream. | Status: not_done
- [ ] **Implement type coercion (`coerce` option)** — When `coerce: true`, apply automatic coercion before Zod validation: string-to-number (`Number()`), string-to-boolean, number-to-boolean (1/0), string-to-date. If coercion fails, pass the original value to Zod. | Status: not_done
- [ ] **Handle extra unexpected keys from JSON** — Keys present in JSON but not in the Zod schema should be parsed by the parser but ignored by the validator (no error emitted, not added to partial). Match Zod's default `strip` behavior. | Status: not_done
- [ ] **Handle missing expected keys** — Keys expected by the schema but not in JSON remain `pending` in metadata. They are never marked `complete`. | Status: not_done
- [ ] **Handle `undefined` vs `null` semantics** — Missing/pending fields are `undefined` (property absent on partial). JSON `null` values are explicitly `null` in the partial (validated against `z.nullable()` schema). | Status: not_done

---

## Phase 5: Pipeline Assembly

### `streamValidate` Function (`src/stream-validate.ts`)

- [ ] **Implement `streamValidate` function signature** — Accept `AsyncIterable<string> | ReadableStream<string>`, a `ZodObject` schema, and optional `StreamValidatorOptions`. Return an `AsyncIterable<ValidatedPartial<T>>` with a `completion` promise property. | Status: not_done
- [ ] **Implement `ReadableStream` to `AsyncIterable` adaptation** — Detect if the input is a `ReadableStream` and adapt it to an `AsyncIterable<string>` using `[Symbol.asyncIterator]()` if available, or a manual reader loop for older environments. | Status: not_done
- [x] **Connect Stage 1 (stream ingestion) to Stage 2 (parser)** — Iterate over the input async iterable, feeding each chunk to the incremental parser. | Status: done
- [x] **Connect Stage 2 (parser) to Stage 3 (validator)** — Route `FieldCompletionEvent` and `FieldStartEvent` from the parser to the progressive validator. | Status: done
- [x] **Implement async generator yielding `ValidatedPartial<T>`** — Yield new `ValidatedPartial` objects as the progressive validator produces them. Respect emission strategy. | Status: done
- [ ] **Implement `completion` promise** — Resolve with a `StreamCompletionEvent<T>` when the stream ends. Populate all fields: `data`, `isComplete`, `truncated`, `totalMs`, `completedFields`, `totalFields`, `failedPaths`, `pendingPaths`. | Status: not_done
- [x] **Implement `field` emission strategy (default)** — Emit a `ValidatedPartial` after every scalar field completion, array element completion, and nested object completion. | Status: done
- [ ] **Implement `debounce` emission strategy** — Emit at most once per `debounceMs` milliseconds. Reset the debounce timer on each field completion. Always emit the final partial regardless of timer. | Status: not_done
- [ ] **Implement `paths` emission strategy** — Only emit when one of the specified `emitPaths` completes. Ignore completions for other paths. | Status: not_done
- [x] **Implement timeout support (`timeoutMs`)** — If the stream has not completed within `timeoutMs`, abort the pipeline. Emit the current partial with `truncated: true` in the completion event. | Status: done
- [x] **Implement `AbortSignal` support (`signal`)** — Listen for the abort signal. When triggered, stop consuming the stream, emit the current partial with `truncated: true`. | Status: done
- [ ] **Implement backpressure via async iteration** — Ensure the pipeline respects backpressure: if the consumer is slow to pull partials, the pipeline pauses. No unbounded buffering. The `for await...of` protocol handles this automatically. | Status: not_done
- [ ] **Implement callback invocations** — Call `onField(path, value)` on each field completion. Call `onValidationError(error)` on validation failures. Call `onError(error)` on parse errors. | Status: not_done
- [ ] **Implement Stage 1 error propagation** — Network failures or stream abort errors propagate through the pipeline to the consumer as thrown exceptions in the `for await` loop. | Status: not_done
- [ ] **Implement graceful stream interruption handling** — On stream end with incomplete JSON (e.g., `max_tokens` cutoff): emit the best partial available, set `truncated: true` on completion event. For in-progress strings, discard them. For in-progress numbers, attempt to finalize. | Status: not_done

### `createStreamValidator` Factory (`src/stream-validator.ts`)

- [x] **Implement `createStreamValidator` factory function** — Accept a `ZodObject` schema and optional `StreamValidatorOptions`. Return a `StreamValidator<T>` instance. | Status: done
- [x] **Implement `write(chunk: string)` method** — Push a string chunk into the parser. Triggers the full parsing and validation pipeline for the characters in the chunk. | Status: done
- [x] **Implement `end()` method** — Signal stream end. Finalize parsing (handle in-progress values), run final validations, emit the completion event. | Status: done
- [x] **Implement `abort(error?: Error)` method** — Signal stream error/cancellation. Emit the current partial with `truncated: true`. | Status: done
- [x] **Implement event emitter (`on`/`off` methods)** — Support registering and removing listeners for events: `'partial'`, `'field'`, `'complete'`, `'validation-error'`, `'parse-error'`. | Status: done
- [x] **Implement `get current()` accessor** — Return the most recent `ValidatedPartial<T>`. | Status: done
- [x] **Implement `[Symbol.asyncIterator]()` method** — Allow the `StreamValidator` to be consumed as an `AsyncIterable<ValidatedPartial<T>>`. Bridge the push-based event model to the pull-based async iterator model. | Status: done

---

## Phase 6: Provider Adapters

### OpenAI Adapter (`src/adapters/openai.ts`)

- [ ] **Implement `fromOpenAI` for Chat Completions API** — Extract `chunk.choices[0].delta.content` from each `ChatCompletionChunk` event. Handle `null`/`undefined` content (e.g., function call chunks) by skipping. Handle `[DONE]` sentinel. | Status: not_done
- [ ] **Implement `fromOpenAI` for Responses API** — Extract text from `response.output_text.delta` events. Handle the different event structure of the Responses API. | Status: not_done
- [ ] **Auto-detect OpenAI API format** — Detect whether the stream is Chat Completions or Responses API format and handle both transparently. | Status: not_done

### Anthropic Adapter (`src/adapters/anthropic.ts`)

- [ ] **Implement `fromAnthropic` adapter** — Filter for `content_block_delta` events where `delta.type === 'text_delta'`. Extract `delta.text`. Ignore non-text content blocks (e.g., `tool_use` blocks). Handle `message_start`, `content_block_start`, `content_block_stop`, `message_delta`, `message_stop` events appropriately. | Status: not_done

### Google Gemini Adapter (`src/adapters/gemini.ts`)

- [ ] **Implement `fromGemini` adapter** — Extract `response.candidates[0].content.parts[0].text` from each `GenerateContentResponse`. Handle empty candidates arrays. Handle responses with multiple text parts. | Status: not_done

### Fetch Adapter (`src/adapters/fetch.ts`)

- [ ] **Implement `fromFetch` adapter** — Read from `response.body` as a `ReadableStream`, decode chunks as text using `TextDecoder`. Handle non-200 responses (throw or yield nothing). Handle empty body. | Status: not_done

### SSE Adapter (`src/adapters/sse.ts`)

- [ ] **Implement `fromSSE` adapter** — Parse SSE text format: extract `data:` fields from each event. Handle multi-line data fields (consecutive `data:` lines are concatenated with newlines). Ignore comments (lines starting with `:`). Stop on done signal (default `[DONE]`). Support configurable `dataField` and `doneSignal` options. | Status: not_done

---

## Phase 7: Testing Utilities (`src/testing.ts`)

- [ ] **Implement `mockStream` from string with options** — Create a mock `AsyncIterable<string>` that splits a JSON string into chunks of `chunkSize` characters with `delayMs` between chunks. | Status: not_done
- [ ] **Implement `mockStream` from explicit chunk array** — Create a mock `AsyncIterable<string>` from an explicit array of string chunks, yielded in order. Support optional delay between chunks. | Status: not_done

---

## Phase 8: Public API Exports (`src/index.ts`)

- [x] **Export `streamValidate` function** — Re-export from `src/stream-validate.ts`. | Status: done
- [x] **Export `createStreamValidator` factory** — Re-export from `src/stream-validator.ts`. | Status: done
- [ ] **Export all provider adapters** — Re-export `fromOpenAI`, `fromAnthropic`, `fromGemini`, `fromFetch`, `fromSSE` from their respective adapter modules. | Status: not_done
- [x] **Export all public types** — Re-export `ValidatedPartial`, `FieldMeta`, `FieldStatus`, `StreamValidatorOptions`, `StreamValidationError`, `StreamParseError`, `StreamCompletionEvent`, `DeepPartial`, `StreamValidator` from `src/types.ts`. | Status: done
- [ ] **Export test utilities from subpath** — Ensure `stream-validate/testing` exports `mockStream`. Configure `package.json` exports map if needed. | Status: not_done

---

## Phase 9: Unit Tests — Incremental Parser

- [ ] **Test scalar string parsing** — Feed simple strings like `"Alice"`, `""`, `"hello world"` through the parser as single chunks and verify correct `FieldCompletionEvent` emission with type `'string'` and correct values. | Status: not_done
- [ ] **Test scalar number parsing** — Feed numbers `0`, `42`, `-17`, `3.14`, `2.998e8`, `-1.5E-3`, `6.022e+23` and verify correct `FieldCompletionEvent` with type `'number'` and correct numeric values. | Status: not_done
- [ ] **Test number edge cases** — Test `-0`, very large numbers, very small decimals (`0.001`), scientific notation with `+`/`-` signs, and invalid numbers (verify `ParseError` for `NaN` results). | Status: not_done
- [ ] **Test boolean and null literal parsing** — Feed `true`, `false`, `null` and verify correct completion events. Test partial literals across chunk boundaries (e.g., `tr` then `ue`). | Status: not_done
- [ ] **Test escape sequences in strings** — Test all JSON escapes: `\"`, `\\`, `\/`, `\b`, `\f`, `\n`, `\r`, `\t`. Verify each resolves to the correct character in the emitted value. | Status: not_done
- [ ] **Test `\uXXXX` Unicode escapes** — Test basic Unicode escapes (e.g., `\u0041` -> `A`). Test BMP characters. Test that invalid hex digits emit `ParseError`. | Status: not_done
- [ ] **Test surrogate pair handling** — Test high surrogate + low surrogate combination (e.g., `\uD83D\uDE00` -> emoji). Verify `String.fromCodePoint` is used for correct decoding. Test lone surrogates emit errors. | Status: not_done
- [ ] **Test simple flat object parsing** — Feed `{"name":"Alice","age":30}` and verify `FieldCompletionEvent` emissions for `$.name` (string `"Alice"`) and `$.age` (number `30`), plus object completion for `$`. | Status: not_done
- [ ] **Test nested object parsing** — Feed `{"address":{"city":"Portland","zip":"97201"}}` and verify events for `$.address.city`, `$.address.zip`, and `$.address`. | Status: not_done
- [ ] **Test deeply nested objects (5+ levels)** — Verify correct path tracking and completion events for deeply nested structures. | Status: not_done
- [ ] **Test maximum nesting depth enforcement** — Feed JSON exceeding `maxDepth` (default 64) and verify `ParseError` is emitted. Test with custom `maxDepth` values. | Status: not_done
- [ ] **Test empty object parsing** — Feed `{}` and verify a single object completion event with an empty object. | Status: not_done
- [ ] **Test empty array parsing** — Feed `[]` and verify a single array completion event with an empty array. | Status: not_done
- [ ] **Test array of scalars** — Feed `[1, 2, 3]` and verify element completion events for `$[0]`, `$[1]`, `$[2]`, plus array completion for `$`. | Status: not_done
- [ ] **Test array of objects** — Feed `[{"name":"Alice"},{"name":"Bob"}]` and verify element-level and field-level completion events with correct paths (e.g., `$[0].name`, `$[1].name`). | Status: not_done
- [ ] **Test nested arrays** — Feed arrays within arrays and verify correct path tracking with multi-level indices (e.g., `$[0][1]`). | Status: not_done
- [ ] **Test mixed types in arrays** — Feed `[1, "two", true, null, {"a":1}]` and verify correct completion events for each element type. | Status: not_done
- [ ] **Test chunk boundary exhaustive splitting** — For several representative JSON strings, generate every possible 2-way split and verify the parser produces identical output regardless of split position. This is the "chunk boundary test" described in Section 14. | Status: not_done
- [ ] **Test multi-character chunks** — Feed JSON in chunks of varying sizes (1, 2, 5, 10 characters) and verify identical results. | Status: not_done
- [ ] **Test single-chunk delivery** — Feed entire JSON strings as single chunks and verify correct output. | Status: not_done
- [ ] **Test trailing comma error** — Feed `{"a": 1, }` and verify `ParseError` is emitted at the `}` after `,`. | Status: not_done
- [ ] **Test single-quoted string error** — Feed `{'name': 'Alice'}` and verify `ParseError` at the `'` character. | Status: not_done
- [ ] **Test unquoted key error** — Feed `{name: "Alice"}` and verify `ParseError` at the `n` character. | Status: not_done
- [ ] **Test comment error** — Feed `{"a": 1 // comment}` and verify `ParseError` at the `/` character. | Status: not_done
- [ ] **Test JavaScript literal error** — Feed `{"a": undefined}` and verify `ParseError` at the `u` character. | Status: not_done
- [ ] **Test truncated string (end of stream)** — Feed `{"name": "Ali` and then signal end of stream. Verify appropriate handling (discarded partial string, truncation reported). | Status: not_done
- [ ] **Test truncated number (end of stream)** — Feed `{"age": 3` and then signal end of stream. Verify the number is finalized if valid. | Status: not_done
- [ ] **Test `skip-value` recovery** — After a parse error, verify the parser skips to the next `,`, `}`, or `]` and resumes. Verify previously parsed fields are preserved. | Status: not_done
- [ ] **Test `skip-to-next-key` recovery** — After a parse error, verify the parser skips to the next `"` in an object context and resumes key parsing. | Status: not_done
- [ ] **Test `abort` recovery** — After a parse error with `abort` strategy, verify parsing stops immediately. | Status: not_done
- [ ] **Test `FieldStartEvent` emissions** — Verify that the parser emits `FieldStartEvent` when it begins parsing a new value, with the correct path. | Status: not_done
- [ ] **Test root-level mismatch** — Feed `[` when root schema expects an object. Verify `ParseError`. | Status: not_done

---

## Phase 10: Unit Tests — Progressive Validation

- [ ] **Test schema map construction for flat object** — Given a flat `z.object({ name: z.string(), age: z.number() })`, verify the schema map contains `$.name -> z.string()` and `$.age -> z.number()`. | Status: not_done
- [ ] **Test schema map construction for nested object** — Verify nested paths like `$.address.city` map to the correct Zod type. | Status: not_done
- [ ] **Test schema map construction for arrays** — Verify `$.tags -> z.array(z.string())` and `$.tags[*] -> z.string()`. For arrays of objects, verify `$.items[*].name -> z.string()`. | Status: not_done
- [ ] **Test schema map unwrapping of Zod wrappers** — Verify `z.optional()`, `z.nullable()`, `z.default()`, `z.transform()`, `z.pipe()` are unwrapped for map construction but retained for validation. | Status: not_done
- [ ] **Test per-field validation success** — Send a mock `FieldCompletionEvent` for `$.name` with value `"Alice"` against `z.string()`. Verify the value is added to the partial. | Status: not_done
- [ ] **Test per-field validation failure** — Send a mock `FieldCompletionEvent` with a value that fails Zod validation (e.g., `"not-an-email"` against `z.string().email()`). Verify the field is excluded and `StreamValidationError` is emitted. | Status: not_done
- [ ] **Test validation with Zod refinements** — Verify that `.refine()`, `.email()`, `.regex()`, `.min()`, `.max()` constraints are enforced during progressive validation. | Status: not_done
- [ ] **Test validation with Zod transforms** — Verify that `.transform()` is applied during progressive validation and the transformed value is stored in the partial. | Status: not_done
- [ ] **Test partial object accumulation** — Send multiple field completions sequentially and verify the partial grows: `{}` -> `{name: "Alice"}` -> `{name: "Alice", age: 30}`. | Status: not_done
- [ ] **Test immutability of emitted partials** — Verify that each emitted partial is a new object. Modifying one partial does not affect subsequent partials or previous partials. | Status: not_done
- [ ] **Test field metadata transitions** — Verify fields transition correctly: `pending` -> `active` -> `complete` (or `error`). All fields start as `pending`. | Status: not_done
- [ ] **Test composite object validation** — When `$.address` completes with the full object, verify the entire address is validated against `z.object({ ... })` including any cross-field refinements. | Status: not_done
- [ ] **Test array element validation** — Verify each array element is individually validated against the element schema. | Status: not_done
- [ ] **Test `include-raw` error strategy** — Verify that on validation failure with `include-raw`, the raw value is present in the partial with an unvalidated flag. | Status: not_done
- [ ] **Test `abort` error strategy** — Verify that on validation failure with `abort`, the pipeline stops and the consumer receives the current partial. | Status: not_done
- [ ] **Test type coercion** — With `coerce: true`, verify string `"42"` is coerced to number `42` before validation. Verify string `"true"` coerces to boolean. Verify number `1`/`0` coerces to boolean. Verify date string coerces to `Date`. | Status: not_done
- [ ] **Test coercion failure fallback** — Verify that failed coercion (e.g., `"not a number"`) passes the original value to Zod, which then rejects it. | Status: not_done
- [ ] **Test extra keys ignored** — Verify that JSON keys not in the Zod schema are parsed but not included in the partial. No error emitted. | Status: not_done
- [ ] **Test `undefined` vs `null` handling** — Verify pending/missing fields are `undefined` (absent). Verify JSON `null` becomes `null` in the partial when schema allows `z.nullable()`. | Status: not_done
- [ ] **Test `seq` and `elapsedMs` on partials** — Verify `seq` increments with each emission and `elapsedMs` is non-negative and increasing. | Status: not_done
- [ ] **Test `isComplete` flag** — Verify `isComplete` is `false` while fields are still pending and `true` only when all fields pass validation. | Status: not_done

---

## Phase 11: Integration Tests — Full Pipeline

- [ ] **Test end-to-end simple object streaming** — Stream a simple flat JSON object through `streamValidate`, collect all emitted partials, verify progressive accumulation and final completion. | Status: not_done
- [ ] **Test end-to-end nested object streaming** — Stream a nested JSON object and verify inner fields are emitted as they complete, then composite validation runs at close. | Status: not_done
- [ ] **Test end-to-end array element streaming** — Stream a JSON object with an array field. Verify each array element triggers a new partial emission with the growing array. | Status: not_done
- [ ] **Test end-to-end with character-by-character chunks** — Feed each character as a separate chunk (simulating OpenAI's token-by-token streaming) and verify identical output to single-chunk delivery. | Status: not_done
- [ ] **Test end-to-end with validation errors on some fields** — Stream JSON where some fields have wrong types. Verify valid fields are included, invalid fields are excluded, and validation errors are reported. | Status: not_done
- [ ] **Test end-to-end truncated response** — Stream a partial JSON (simulate `max_tokens` cutoff). Verify the pipeline emits the best partial available and the completion event has `truncated: true`. | Status: not_done
- [ ] **Test end-to-end timeout** — Use `timeoutMs` and a slow stream. Verify the pipeline aborts after the timeout and the completion event has `truncated: true`. | Status: not_done
- [ ] **Test end-to-end AbortSignal cancellation** — Pass an `AbortSignal` and trigger it mid-stream. Verify the pipeline stops and the completion event has `truncated: true`. | Status: not_done
- [ ] **Test end-to-end network error propagation** — Simulate a stream that throws an error mid-delivery. Verify the error propagates to the consumer's `for await` loop. | Status: not_done
- [ ] **Test `debounce` emission strategy end-to-end** — Use `emitStrategy: 'debounce'` with `debounceMs: 50`. Verify fewer partials are emitted than with `field` strategy. Verify the final partial is always emitted. | Status: not_done
- [ ] **Test `paths` emission strategy end-to-end** — Use `emitStrategy: 'paths'` with specific paths. Verify partials are only emitted when those paths complete. | Status: not_done
- [ ] **Test `completion` promise resolution** — Verify `result.completion` resolves with a correct `StreamCompletionEvent` after the stream ends. Verify all fields: `isComplete`, `truncated`, `totalMs`, `completedFields`, `totalFields`, `failedPaths`, `pendingPaths`. | Status: not_done
- [ ] **Test backpressure behavior** — Simulate a slow consumer with delays between iterations. Verify the pipeline does not buffer unboundedly and pauses the source stream. | Status: not_done
- [ ] **Test `createStreamValidator` push-based API end-to-end** — Create a `StreamValidator`, push chunks via `write()`, call `end()`, and verify events are emitted correctly via `on('partial', ...)` and `on('complete', ...)`. | Status: not_done
- [ ] **Test `StreamValidator` abort** — Call `abort()` mid-stream and verify the completion event has `truncated: true`. | Status: not_done
- [ ] **Test `StreamValidator` as async iterable** — Consume the `StreamValidator` via `for await...of` using its `[Symbol.asyncIterator]()` method and verify correct partial emissions. | Status: not_done
- [ ] **Test callbacks (`onField`, `onValidationError`, `onError`)** — Verify each callback is invoked at the correct time with the correct arguments. | Status: not_done
- [ ] **Test schema mismatch: root-level** — Root schema expects object but stream starts with `[`. Verify error behavior. | Status: not_done
- [ ] **Test schema mismatch: missing keys** — Expected keys absent from JSON. Verify they remain `pending` in metadata and are listed in `pendingPaths` in completion event. | Status: not_done
- [ ] **Test large response (many fields)** — Stream a JSON object with 100+ fields and verify all are correctly parsed and validated. | Status: not_done

---

## Phase 12: Provider Adapter Tests

- [ ] **Test `fromOpenAI` with Chat Completions format** — Provide mock `ChatCompletionChunk` events. Verify text extraction from `choices[0].delta.content`. Verify `null`/`undefined` content chunks are skipped. | Status: not_done
- [ ] **Test `fromOpenAI` with Responses API format** — Provide mock Responses API events. Verify text extraction from `output_text.delta`. | Status: not_done
- [ ] **Test `fromOpenAI` with `[DONE]` sentinel** — Verify the stream terminates cleanly on `[DONE]`. | Status: not_done
- [ ] **Test `fromAnthropic` adapter** — Provide mock `MessageStreamEvent` objects. Verify only `content_block_delta` events with `text_delta` type are extracted. Verify non-text blocks are filtered. | Status: not_done
- [ ] **Test `fromGemini` adapter** — Provide mock `GenerateContentResponse` objects. Verify text extraction from `candidates[0].content.parts[0].text`. Verify empty candidates are handled. | Status: not_done
- [ ] **Test `fromFetch` adapter** — Provide a mock `Response` object with a readable body. Verify text chunks are decoded and yielded. Test non-200 response handling. Test empty body. | Status: not_done
- [ ] **Test `fromSSE` adapter** — Provide raw SSE text. Verify `data:` fields are extracted. Verify multi-line data concatenation. Verify comments are ignored. Verify `[DONE]` stops the stream. Test custom `doneSignal`. | Status: not_done

---

## Phase 13: Test Utilities Tests

- [ ] **Test `mockStream` from string** — Verify `mockStream("...", { chunkSize: 5, delayMs: 10 })` yields chunks of the correct size with delays. Consume all chunks and verify the concatenated result equals the input. | Status: not_done
- [ ] **Test `mockStream` from chunk array** — Verify `mockStream(["chunk1", "chunk2"])` yields chunks in order. | Status: not_done

---

## Phase 14: Integration Test Fixtures

- [ ] **Create OpenAI user profile fixture** — Record/create a fixture JSON file (`src/__tests__/integration/fixtures/openai-user-profile.json`) with an array of string chunks simulating an OpenAI character-by-character response. | Status: not_done
- [ ] **Create Anthropic analysis fixture** — Record/create a fixture simulating Anthropic `text_delta` word-by-word delivery. | Status: not_done
- [ ] **Create truncated response fixture** — Create a fixture simulating a `max_tokens` cutoff (mid-string or mid-object). | Status: not_done
- [ ] **Create large response fixture** — Create a fixture with 100+ fields for performance testing. | Status: not_done
- [ ] **Create response with validation errors fixture** — Create a fixture where some fields have wrong types (e.g., number where string expected). | Status: not_done
- [ ] **Write fixture replay tests** — For each fixture, replay through the full pipeline and verify expected partial emissions and completion events. | Status: not_done

---

## Phase 15: Performance

- [ ] **Implement parser throughput benchmark** — Measure characters/second for the incremental parser on a large JSON string. Target: >10 million chars/sec. | Status: not_done
- [ ] **Implement per-field validation overhead benchmark** — Measure time per `safeParse` call for common types. Target: <100 microseconds. | Status: not_done
- [ ] **Implement memory overhead benchmark** — Measure memory usage relative to raw JSON size. Target: <2x overhead. | Status: not_done
- [ ] **Implement time-to-first-partial benchmark** — Measure time from first chunk to first partial emission. Target: <5ms. | Status: not_done
- [ ] **Optimize hot paths if benchmarks miss targets** — Profile and optimize character processing loop, schema map lookups, and partial object cloning if needed. | Status: not_done

---

## Phase 16: Documentation

- [ ] **Write README.md** — Comprehensive README covering: overview, installation, quick start example, `streamValidate` API, `createStreamValidator` API, provider adapters (with code examples for OpenAI, Anthropic, Gemini, fetch), configuration options reference, emission strategies, error handling, type safety / `DeepPartial<T>`, testing utilities, React / Vue integration patterns, performance characteristics. | Status: not_done
- [ ] **Add JSDoc comments to all public APIs** — Ensure every exported function, type, and interface has JSDoc documentation matching the spec descriptions. | Status: not_done
- [ ] **Add inline code comments for parser state machine** — Comment the state transitions in the incremental parser for maintainability, as specified in Section 6. | Status: not_done

---

## Phase 17: Final Polish and Publish Prep

- [ ] **Verify all tests pass** — Run `npm run test` and ensure 100% pass rate. | Status: not_done
- [ ] **Verify lint passes** — Run `npm run lint` with zero errors and zero warnings. | Status: not_done
- [ ] **Verify build succeeds** — Run `npm run build` and verify clean compilation with no errors. Verify `dist/` output contains `.js`, `.d.ts`, and `.js.map` files. | Status: not_done
- [ ] **Verify `package.json` exports are correct** — Ensure `main`, `types`, `files`, and any `exports` map entries point to the correct dist files. Verify `stream-validate/testing` subpath works. | Status: not_done
- [ ] **Bump version in `package.json`** — Set the version appropriately for the initial release (likely `1.0.0` or `0.1.0` depending on confidence). | Status: not_done
- [ ] **Verify peer dependency declaration** — Confirm `"zod": "^3.22.0"` is in `peerDependencies`. | Status: not_done
- [ ] **Verify zero runtime dependencies** — Confirm `dependencies` in `package.json` is empty. Only `peerDependencies` (zod) and `devDependencies`. | Status: not_done
- [ ] **Dry-run npm publish** — Run `npm publish --dry-run` and verify the package contents look correct (only `dist/` files are included). | Status: not_done
