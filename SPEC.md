# stream-validate -- Specification

## 1. Overview

`stream-validate` is a provider-agnostic streaming validation library that accepts any `AsyncIterable<string>` or `ReadableStream<string>` of partial JSON content from an LLM response, incrementally parses it character by character, validates completed fields against a Zod schema, and emits typed partial objects as fields complete. The result is an `AsyncIterable<ValidatedPartial<T>>` that yields progressively more-complete objects: first `{ name: "Alice" }`, then `{ name: "Alice", age: 30 }`, then `{ name: "Alice", age: 30, address: { city: "Portland" } }`, and finally the fully validated `T`. Each yielded partial includes metadata indicating which fields are complete, which are in-progress (receiving characters but not yet validated), and which are pending (not yet started). The library performs no network I/O, requires no API keys, and runs entirely in-process.

The gap this package fills is specific and well-validated. When an LLM streams a JSON response token by token, the consumer cannot parse the response until the final closing brace arrives. For responses that take 5-15 seconds to stream, this means the UI shows nothing until the very end, then renders the entire object at once. Progressive rendering -- showing each field as it completes -- is dramatically better UX, but implementing it requires solving three hard problems simultaneously: incremental JSON parsing (handling partial strings, nested objects, escape sequences, and numbers character by character), field completion detection (knowing when `"name": "Alice"` is done versus `"name": "Ali` still receiving characters), and per-field validation (checking each completed value against the expected Zod type before including it in the partial object). No existing package solves all three problems for arbitrary stream sources.

`zod-stream` is the closest existing tool. It provides streaming Zod validation for LLM responses and is built on `schema-stream` for incremental JSON parsing. However, `zod-stream` is tightly coupled to OpenAI's API surface. Its `withResponseModel` function configures OpenAI-specific parameters (response modes `TOOLS`, `FUNCTIONS`, `JSON`, `JSON_SCHEMA`, `MD_JSON`), its stream ingestion expects the shape of OpenAI's streaming response, and its documentation and examples assume the OpenAI SDK. Developers using Anthropic's API (which streams `content_block_delta` events with `text_delta` payloads), Google Gemini (which streams `GenerateContentResponse` chunks), a local model behind Ollama, or a custom inference server must write adapter code to translate their stream into the shape `zod-stream` expects. The Vercel AI SDK's `streamObject()` function provides progressive object building with Zod schemas, but it is part of a large framework with opinions about routing, middleware, and UI integration -- it is not a standalone library. `instructor-js` provides structured extraction with validation but is similarly coupled to the OpenAI SDK and its function-calling modes. `partial-json-parser` and `@streamparser/json` handle incremental parsing but provide no validation layer. `schema-stream` provides schema-aware stub objects during parsing but intentionally does not perform Zod validation during streaming -- it defers validation to the consumer.

`stream-validate` provides a single, focused package that decouples the three concerns. Stage 1 (stream ingestion) accepts any `AsyncIterable<string>` -- the universal abstraction for asynchronous character streams in JavaScript. Provider-specific adapters (`fromOpenAI`, `fromAnthropic`, `fromGemini`, `fromFetch`) are convenience functions that extract text content from provider-specific stream formats and yield plain strings. Stage 2 (incremental JSON parser) is a character-by-character state machine that tracks the current JSON path, detects field completions, and handles the full JSON grammar including nested objects, arrays, escape sequences, and numeric types. Stage 3 (progressive Zod validation) validates each completed field against the corresponding path in the Zod schema, builds a typed partial object, and emits it. The three stages are connected as a pipeline: Stage 1 yields string chunks to Stage 2, Stage 2 yields field completion events to Stage 3, Stage 3 yields `ValidatedPartial<T>` objects to the consumer.

---

## 2. Goals and Non-Goals

### Goals

- Provide a `streamValidate<T>(stream, schema, options?)` function that accepts any `AsyncIterable<string>` or `ReadableStream<string>` and a Zod schema, and returns an `AsyncIterable<ValidatedPartial<T>>` that yields typed partial objects as fields complete.
- Provide a `createStreamValidator<T>(schema, options?)` factory that returns a `StreamValidator<T>` instance with a push-based write/end API and an event emitter interface, for environments where the pull-based async iterator model is not suitable.
- Implement a character-by-character incremental JSON parser as an internal state machine that tracks JSON paths, detects field completions, handles the full JSON grammar (strings with escape sequences, numbers including integers/floats/negative/scientific notation, booleans, null, nested objects, arrays), and recovers gracefully from malformed input.
- Validate each completed field value against the Zod schema at the corresponding JSON path before including it in the emitted partial object. Validation failures on individual fields do not abort the stream -- the field is excluded from the partial and an error event is emitted.
- Provide provider adapters (`fromOpenAI`, `fromAnthropic`, `fromGemini`, `fromFetch`) as convenience functions that normalize provider-specific stream formats into plain `AsyncIterable<string>`.
- Generate correct TypeScript types: `ValidatedPartial<T>` is `DeepPartial<T>` with all fields optional, inferred from the Zod schema. The consumer gets full autocomplete and type checking on partial objects.
- Emit metadata with each partial object: which fields are `complete` (validated), `active` (receiving characters), and `pending` (not yet started).
- Support configurable emission strategies: emit on every field completion, emit on a debounced interval, or emit only on specific field paths.
- Handle stream interruptions (network errors, `max_tokens` cutoff) gracefully: emit the best partial object available at the time of interruption, with a `truncated` flag in the completion event.
- Keep runtime dependencies minimal: depend on `zod` as a peer dependency. No other runtime dependencies. The incremental JSON parser is implemented from scratch.

### Non-Goals

- **Not an LLM API client.** This package does not make HTTP requests, manage API keys, or handle authentication. It operates on streams that the caller has already established. Use the OpenAI SDK, Anthropic SDK, Google AI SDK, or `fetch` to create the stream, then pass it to `stream-validate`.
- **Not a JSON repair library.** This package parses JSON incrementally as it arrives character by character. It does not repair malformed JSON after the fact (trailing commas, single-quoted strings, unquoted keys). If the LLM produces invalid JSON, the parser detects the error at the point of invalidity and emits an error event. For post-hoc JSON repair, use `llm-output-normalizer` or `jsonrepair` before or instead of streaming validation.
- **Not a structured output enforcer.** This package does not constrain LLM generation at the token level. OpenAI's structured output mode and Anthropic's tool use constrain generation to produce valid JSON. `stream-validate` validates the output after generation -- it is the consumer-side complement to generation-side constraints.
- **Not a full application framework.** This package provides the streaming validation primitive. It does not provide React hooks, Vue composables, or Svelte stores. Integration patterns for UI frameworks are documented in this specification but are implemented by the consumer, not by this package.
- **Not a general-purpose streaming JSON parser.** While this package includes an incremental JSON parser, the parser is optimized for the specific use case of LLM JSON output validation. It parses a single top-level JSON object or array (matching the Zod schema), not arbitrary sequences of JSON values, NDJSON, or JSON streams with multiple documents. For general-purpose streaming JSON parsing, use `@streamparser/json` or `stream-json`.
- **Not a schema-to-prompt converter.** This package does not generate prompts from Zod schemas. It does not instruct the LLM to produce JSON in a specific format. Use `zod-to-json-schema` to include schema definitions in prompts.

---

## 3. Target Users and Use Cases

### AI Application Developers Building Streaming UIs

Developers building chat interfaces, dashboards, or data exploration tools where an LLM generates structured JSON (user profiles, product listings, analysis reports) and the UI needs to render fields progressively as they arrive. The user sees the name appear, then the email, then the address, rather than staring at a loading spinner for 10 seconds. A typical integration is: `for await (const partial of streamValidate(llmStream, UserSchema)) { updateUI(partial.data); }`.

### Agent Framework Authors

Teams building agent pipelines where one LLM generates structured tool arguments or intermediate data that another component consumes. The downstream component can begin processing as soon as its required fields are available, without waiting for the full response. For example, an agent that generates a search query and filters in a single JSON object -- the search can start as soon as the query field completes, while the filters are still streaming.

### Data Extraction Pipeline Builders

Developers running LLMs over documents to extract structured data (entities, relationships, metadata). When extracting from long documents, the LLM response may be large and slow. Progressive validation allows the pipeline to process each extracted entity as it completes rather than waiting for the entire extraction to finish.

### Real-Time Collaboration and Streaming Dashboards

Applications that forward LLM-generated structured data to multiple connected clients via WebSockets or Server-Sent Events. Each validated partial can be forwarded immediately, giving all connected clients progressive updates.

### Backend Services with Timeout Constraints

Server-side applications that call LLMs but have strict response time budgets. If the LLM response is interrupted by a timeout or `max_tokens` limit, `stream-validate` provides the best partial result available at the point of interruption, with metadata indicating which fields completed. The service can return a partial response to its caller rather than failing entirely.

### Developers Migrating Away from Provider-Specific Tools

Teams currently using `zod-stream` with OpenAI who need to support Anthropic, Google, or local models. `stream-validate` provides the same progressive validation capability with a provider-agnostic input contract (`AsyncIterable<string>`), allowing a single validation pipeline to work with any LLM provider.

---

## 4. Core Concepts

### Stream Source

A stream source is any asynchronous sequence of string chunks containing partial JSON. The canonical type is `AsyncIterable<string>`, which covers async generators, Node.js Readable streams (via `Readable.from` or async iteration), WHATWG `ReadableStream` (via the async iterator protocol), and custom implementations. Each chunk may contain zero or more complete JSON tokens, or may split a token across chunk boundaries. The incremental parser handles arbitrary chunk boundaries -- a string value like `"Alice"` may arrive as `"Al`, then `ice"`, or as seven single-character chunks, or as a single chunk. The parser's behavior is identical regardless of chunking.

### Incremental JSON Parser

The incremental JSON parser is a deterministic finite state machine that processes JSON input one character at a time. It maintains a state stack representing the current position in the JSON grammar (e.g., "inside an object, reading a string value for key `name`, at character position 3"). As characters arrive, the parser transitions between states, building values incrementally. When a value is complete (a string's closing quote is reached, a number is terminated by a delimiter, a boolean or null literal is fully read), the parser emits a field completion event containing the JSON path (e.g., `$.name`, `$.address.city`, `$.tags[2]`) and the completed value.

### JSON Path

A JSON path is a string representation of the location of a value within a JSON document. The root is `$`. Object keys are appended with dot notation (`$.name`, `$.address.city`). Array indices are appended with bracket notation (`$.items[0]`, `$.items[1].name`). The parser tracks the current path at all times, updating it as it enters and exits objects and arrays. Paths are used to map completed values to their corresponding Zod schema fields for validation.

### Field Completion

A field is "complete" when its entire value has been received and parsed. For string values, this is when the closing double-quote is reached (accounting for escape sequences). For number values, this is when a non-numeric character (`,`, `}`, `]`, whitespace) terminates the number. For boolean and null literals, this is when all characters of the literal have been read. For nested objects and arrays, completion means all inner fields have completed and the closing `}` or `]` has been reached. Field completion is the trigger for validation and partial object emission.

### Progressive Validation

Progressive validation is the process of validating individual fields against a Zod schema as they complete, rather than validating the entire object at the end. When the parser reports that `$.name` has completed with value `"Alice"`, the progressive validator looks up the `name` field in the Zod schema, finds it expects `z.string()`, validates `"Alice"` against `z.string()`, and if validation passes, adds `name: "Alice"` to the partial object. If validation fails (e.g., the schema expects `z.number()` but received a string), the field is excluded from the partial and a validation error event is emitted. The partial object grows field by field, with each field individually validated.

### Validated Partial Object

A validated partial object is a `DeepPartial<T>` where `T` is the type inferred from the Zod schema. Only fields that have completed and passed validation are present. Fields that are still streaming or have not started are `undefined`. The TypeScript type system enforces that every property access on the partial is potentially `undefined`, preventing runtime errors from accessing incomplete fields. Each partial is a new object (not a mutation of the previous one), enabling React-style immutable state updates.

### Field Status Metadata

Each emitted partial includes a `FieldMeta` map that tracks the status of every field in the schema. A field has one of three statuses:

- **`complete`**: The field's value has been fully received and validated. It is present in the partial object.
- **`active`**: The parser is currently receiving characters for this field's value. The value is not yet in the partial object.
- **`pending`**: The parser has not yet reached this field. It is not in the partial object.

This metadata enables UI patterns like showing a loading indicator on active fields, graying out pending fields, and highlighting completed fields.

---

## 5. Architecture

### Three-Stage Pipeline

`stream-validate` is structured as a three-stage pipeline. Each stage has a single responsibility and communicates with the next stage through a well-defined interface.

```
┌─────────────────┐     ┌──────────────────────┐     ┌───────────────────────┐
│  Stage 1:       │     │  Stage 2:            │     │  Stage 3:             │
│  Stream         │────>│  Incremental JSON    │────>│  Progressive Zod      │
│  Ingestion      │     │  Parser              │     │  Validation           │
│                 │     │                      │     │                       │
│  Input:         │     │  Input:              │     │  Input:               │
│  AsyncIterable  │     │  string chunks       │     │  FieldCompletion      │
│  <string>       │     │                      │     │  events               │
│                 │     │  Output:             │     │                       │
│  Output:        │     │  FieldCompletion     │     │  Output:              │
│  string chunks  │     │  events              │     │  ValidatedPartial<T>  │
└─────────────────┘     └──────────────────────┘     └───────────────────────┘
```

### Stage 1: Stream Ingestion

The stream ingestion stage normalizes the input into a uniform `AsyncIterable<string>`. If the input is already an `AsyncIterable<string>`, it is passed through unchanged. If the input is a `ReadableStream<string>`, it is adapted to an async iterable using the stream's built-in `[Symbol.asyncIterator]()` method (supported in modern runtimes) or a manual reader loop. If a provider adapter (`fromOpenAI`, `fromAnthropic`, etc.) is used, the adapter extracts text content from the provider-specific event format and yields plain strings.

The stage performs no buffering and no transformation beyond format normalization. Chunks are forwarded to Stage 2 exactly as received from the source. This means Stage 2 must handle arbitrary chunk boundaries.

### Stage 2: Incremental JSON Parser

The incremental JSON parser receives string chunks from Stage 1 and processes them character by character. It maintains a state machine with a stack of parse contexts (representing nesting depth), the current JSON path, and accumulators for in-progress values (string buffers, number buffers). As each character is consumed, the parser transitions between states. When a value completes, the parser emits a `FieldCompletion` event containing the path, the parsed value, and the value's type.

The parser also emits `FieldStart` events when it begins parsing a new value (useful for UI status indicators) and `ParseError` events when it encounters invalid JSON.

The parser does not allocate a full in-memory representation of the JSON document. It streams field completions to Stage 3 without retaining previously completed values. Memory usage is proportional to the nesting depth (the state stack) plus the size of the largest in-progress value (typically a string), not the size of the entire JSON document.

### Stage 3: Progressive Zod Validation

The progressive validation stage receives `FieldCompletion` events from Stage 2 and validates each against the Zod schema. It maintains a `SchemaMap` -- a precomputed mapping from JSON paths to Zod type definitions, derived from the schema at construction time. When a field completion arrives for path `$.address.city` with value `"Portland"`, Stage 3 looks up `$.address.city` in the `SchemaMap`, finds `z.string()`, calls `.safeParse("Portland")`, and if successful, adds the value to the accumulating partial object.

The partial object is maintained as an immutable structure. Each new field completion produces a new partial object (a shallow copy of the previous one with the new field added). The new partial, along with updated field metadata, is yielded to the consumer.

### Backpressure

The pipeline respects async iteration backpressure. If the consumer is slow to process partial objects (e.g., a React component re-rendering), the pipeline pauses naturally: Stage 3 stops pulling from Stage 2, Stage 2 stops pulling from Stage 1, and Stage 1 stops pulling from the source stream. This prevents unbounded buffering. No explicit flow control mechanism is needed because the `for await...of` protocol handles backpressure automatically.

### Error Propagation

Errors at any stage propagate to the consumer:

- **Stage 1 errors** (network failure, stream abort): The async iterable throws, which propagates through Stages 2 and 3 to the consumer's `for await` loop as a thrown exception.
- **Stage 2 errors** (malformed JSON): A `ParseError` event is emitted. Depending on the `onParseError` configuration, the pipeline may continue (attempting to recover), skip to the next field, or abort.
- **Stage 3 errors** (Zod validation failure): A `ValidationError` event is emitted. The invalid field is excluded from the partial. The pipeline continues with the next field.

---

## 6. Incremental JSON Parser

### State Machine Design

The parser is a pushdown automaton with a stack of parse contexts. Each context represents a level of nesting in the JSON structure. The parser processes one character at a time via its `feed(char)` method.

**Parser states** (each context on the stack has one of these states):

| State | Description |
|-------|-------------|
| `VALUE_START` | Expecting the start of a JSON value: `{`, `[`, `"`, digit, `-`, `t`, `f`, `n` |
| `OBJECT_START` | Just entered an object with `{`. Expecting `"` (key) or `}` (empty object) |
| `OBJECT_KEY` | Reading an object key string |
| `OBJECT_COLON` | Expecting `:` after object key |
| `OBJECT_VALUE` | Expecting the start of an object value (delegates to `VALUE_START`) |
| `OBJECT_COMMA` | After a value in an object. Expecting `,` (next pair) or `}` (end object) |
| `ARRAY_START` | Just entered an array with `[`. Expecting a value or `]` (empty array) |
| `ARRAY_VALUE` | Expecting the start of an array element (delegates to `VALUE_START`) |
| `ARRAY_COMMA` | After an element in an array. Expecting `,` (next element) or `]` (end array) |
| `STRING` | Reading a string value. Accumulating characters until unescaped `"` |
| `STRING_ESCAPE` | Previous character was `\` inside a string. Next character is the escaped character |
| `NUMBER` | Reading a number. Accumulating digits, `.`, `e`, `E`, `+`, `-` |
| `LITERAL` | Reading a literal (`true`, `false`, `null`). Matching against expected characters |
| `DONE` | The top-level value has been fully parsed |

### Character Processing

Each character fed to the parser triggers a state transition. The transitions form a complete implementation of the JSON grammar (RFC 8259). Whitespace characters (space, tab, newline, carriage return) are skipped in all states except `STRING` and `STRING_ESCAPE`, where they are accumulated as part of the string value.

**String parsing**: When a `"` is encountered in `VALUE_START`, the parser enters `STRING` state and begins accumulating characters into a string buffer. Standard JSON escape sequences are handled: `\"`, `\\`, `\/`, `\b`, `\f`, `\n`, `\r`, `\t`, and `\uXXXX` (4-digit Unicode escapes). When the parser encounters `\` in `STRING` state, it transitions to `STRING_ESCAPE`, processes the next character as an escape, and returns to `STRING`. When an unescaped `"` is encountered, the string is complete. The parser emits the accumulated string (with escape sequences resolved) and transitions to the appropriate parent state.

**Number parsing**: When a digit or `-` is encountered in `VALUE_START`, the parser enters `NUMBER` state. The number buffer accumulates characters that are valid in a JSON number: digits, `.` (decimal point), `e` or `E` (exponent), `+` or `-` (exponent sign). The parser does not validate number grammar during accumulation -- it collects the full numeric string and validates it upon completion. A number terminates when a character is encountered that cannot be part of a number (`,`, `}`, `]`, whitespace, or end of input). At termination, the accumulated string is parsed with `Number()` and the result is validated: if `isNaN` or `!isFinite`, a parse error is emitted. The terminating character is not consumed -- it is reprocessed in the parent state.

**Boolean and null parsing**: When `t`, `f`, or `n` is encountered in `VALUE_START`, the parser enters `LITERAL` state with an expected literal string (`true`, `false`, or `null`). Each subsequent character is compared against the expected literal. If all characters match, the literal value is emitted. If a character does not match, a parse error is emitted.

**Object parsing**: When `{` is encountered in `VALUE_START`, the parser pushes a new context onto the stack with state `OBJECT_START`. In `OBJECT_START`, a `"` begins reading an object key; `}` ends the object (empty object). After a key is read, the parser expects `:` (`OBJECT_COLON`), then a value (`OBJECT_VALUE`). After the value completes, the parser enters `OBJECT_COMMA`, expecting `,` (another key-value pair) or `}` (end object). When `}` is encountered, the context is popped from the stack, and an object completion event is emitted.

**Array parsing**: When `[` is encountered in `VALUE_START`, the parser pushes a new context onto the stack with state `ARRAY_START`. In `ARRAY_START`, `]` ends the array (empty array); otherwise, an element value is expected. After each element completes, the parser enters `ARRAY_COMMA`, expecting `,` (another element) or `]` (end array). When `]` is encountered, the context is popped and an array completion event is emitted.

### Path Tracking

The parser maintains a path stack that mirrors the context stack. When the parser enters an object and reads a key `"name"`, it pushes `"name"` onto the path stack, making the current path `$.name`. When the value for that key completes and the parser moves to the next key `"age"`, it pops `"name"` and pushes `"age"`, making the path `$.age`. When the parser enters a nested object (e.g., key `"address"` with value `{...}`), the path becomes `$.address`, and inner keys extend it further: `$.address.city`, `$.address.zip`.

For arrays, the parser maintains an index counter per array context. The first element is `[0]`, the second is `[1]`, and so on. A path like `$.items[2].name` means "the `name` field of the third element of the `items` array."

The path is included in every `FieldStart`, `FieldCompletion`, and `ParseError` event, enabling Stage 3 to map events to schema fields.

### Field Completion Detection

Field completion detection varies by value type:

| Value Type | Completion Signal | Example |
|------------|-------------------|---------|
| String | Unescaped closing `"` | `"Alice"` -- complete when second `"` is read |
| Number | Non-numeric delimiter character | `30,` -- complete when `,` is read (value is `30`) |
| Boolean | All literal characters matched | `true` -- complete when `e` is read |
| Null | All literal characters matched | `null` -- complete when second `l` is read |
| Object | Closing `}` | `{"a":1}` -- complete when `}` is read |
| Array | Closing `]` | `[1,2,3]` -- complete when `]` is read |

For composite types (objects and arrays), the field completion event includes the fully constructed value. This means that when `$.address` completes (the closing `}` of the address object is read), the completion event for `$.address` contains the entire address object `{ city: "Portland", zip: "97201" }`. Inner field completions (for `$.address.city` and `$.address.zip`) have already been emitted individually during parsing.

### Nested Object and Array Handling

The parser's stack-based design handles arbitrary nesting depth. Each nested object or array pushes a new context onto the stack. The maximum nesting depth is configurable (default: 64) to prevent stack overflow from deeply nested or malicious input. If the depth limit is exceeded, a `ParseError` is emitted with a descriptive message.

Array element streaming is a key use case. When the schema defines an array of objects (e.g., `z.array(z.object({...}))`), the parser emits a field completion for each array element as it completes. The consumer receives progressive updates like:

1. `{ items: [{ name: "Alice" }] }` -- first element complete
2. `{ items: [{ name: "Alice" }, { name: "Bob" }] }` -- second element complete
3. `{ items: [{ name: "Alice" }, { name: "Bob" }, { name: "Charlie" }] }` -- third element complete

This enables rendering a growing list of items as they stream in, rather than waiting for the entire array.

### Escape Character Handling

The parser correctly handles all JSON escape sequences within strings:

| Escape | Character | Unicode |
|--------|-----------|---------|
| `\"` | Double quote | U+0022 |
| `\\` | Backslash | U+005C |
| `\/` | Forward slash | U+002F |
| `\b` | Backspace | U+0008 |
| `\f` | Form feed | U+000C |
| `\n` | Newline | U+000A |
| `\r` | Carriage return | U+000D |
| `\t` | Tab | U+0009 |
| `\uXXXX` | Unicode code point | U+XXXX |

For `\uXXXX` sequences, the parser accumulates four hex digits after `\u` and converts them to the corresponding character using `String.fromCharCode`. Surrogate pairs (for characters outside the Basic Multilingual Plane) are handled by detecting a high surrogate (`\uD800`-`\uDBFF`) followed by a low surrogate (`\uDC00`-`\uDFFF`) and combining them with `String.fromCodePoint`.

### Number Parsing

The parser accumulates the full number string and then parses it with `Number()`. JSON numbers must conform to RFC 8259:

- Optional leading minus sign: `-`
- Integer part: `0` or a non-zero digit followed by zero or more digits
- Optional fractional part: `.` followed by one or more digits
- Optional exponent part: `e` or `E`, optional `+` or `-`, one or more digits

Examples of valid JSON numbers: `0`, `42`, `-17`, `3.14`, `2.998e8`, `-1.5E-3`, `6.022e+23`.

The parser does not reject invalid number syntax during accumulation (e.g., `01`, `1.`, `.5`, `1e`). Instead, it collects all characters that could plausibly be part of a number and validates the result of `Number()` at completion. If `Number()` returns `NaN`, the accumulated string is not a valid number and a parse error is emitted. This approach simplifies the state machine while still catching all invalid numbers.

### Error Recovery

When the parser encounters invalid JSON, it emits a `ParseError` event and attempts to recover. Recovery strategies, configurable via `onParseError`:

| Strategy | Behavior | Use Case |
|----------|----------|----------|
| `abort` | Stop parsing immediately. The pipeline terminates with the current partial. | Strict environments where invalid JSON is unacceptable. |
| `skip-value` (default) | Skip characters until the parser reaches a state where it can resume (the next `,`, `}`, or `]`). The invalid field is excluded from the partial. | Tolerant environments where partial results are better than no results. |
| `skip-to-next-key` | Skip characters until the next object key is found (the next `"` in an object context). | When the LLM produces an invalid value for one field but the rest of the object is valid. |

Recovery is best-effort. Some malformations (like an unmatched `{` with no corresponding `}`) cannot be recovered from because the parser cannot determine where the current context ends. In these cases, the parser enters an error state and stops emitting field completions, but still consumes remaining input to allow the source stream to drain.

---

## 7. Progressive Validation

### Schema Map Construction

When a `StreamValidator` is created, the Zod schema is traversed to build a `SchemaMap` -- a flat map from JSON paths to Zod type definitions. This traversal happens once at construction time, not during streaming.

**Traversal algorithm**:

1. Start with the root schema (which must be a `z.object()`) and the root path `$`.
2. For each key in the object schema, record the mapping `$.key -> z.typeForKey`.
3. If the type for a key is `z.object()`, recurse into it with path `$.key`.
4. If the type for a key is `z.array(elementSchema)`, record `$.key -> z.array(elementSchema)` and, if the element schema is `z.object()`, recurse into it with path `$.key[*]` (where `*` is a wildcard matching any index).
5. Handle Zod wrappers: `z.optional(inner)`, `z.nullable(inner)`, `z.default(inner, val)`, `z.transform(inner, fn)`, and `z.pipe(a, b)` are unwrapped to find the inner type for map construction, while the full wrapper chain is retained for validation.

**Example**: Given the schema:

```typescript
const UserSchema = z.object({
  name: z.string(),
  age: z.number(),
  email: z.string().email(),
  address: z.object({
    street: z.string(),
    city: z.string(),
    zip: z.string().regex(/^\d{5}$/),
  }),
  tags: z.array(z.string()),
});
```

The `SchemaMap` contains:

| Path | Zod Type |
|------|----------|
| `$.name` | `z.string()` |
| `$.age` | `z.number()` |
| `$.email` | `z.string().email()` |
| `$.address` | `z.object({ street, city, zip })` |
| `$.address.street` | `z.string()` |
| `$.address.city` | `z.string()` |
| `$.address.zip` | `z.string().regex(/^\d{5}$/)` |
| `$.tags` | `z.array(z.string())` |
| `$.tags[*]` | `z.string()` |

### Per-Field Validation

When a `FieldCompletion` event arrives, Stage 3 performs these steps:

1. **Look up the schema**: Find the Zod type for the event's path in the `SchemaMap`. For array elements, the path `$.tags[2]` is matched against the pattern `$.tags[*]`.
2. **Run validation**: Call `zodType.safeParse(value)` on the completed value.
3. **Handle result**:
   - **Success**: Add the value to the partial object at the correct path. Mark the field as `complete` in the metadata. Emit the new partial.
   - **Failure**: Do not add the value to the partial. Mark the field as `error` in the metadata. Emit a `ValidationError` event with the Zod error details and the field path. Emit the partial unchanged (without the invalid field).

Validation runs the full Zod pipeline, including refinements (`.refine()`), transforms (`.transform()`), and pipes (`.pipe()`). This means that `z.string().email()` validates that the string is a valid email, not just that it is a string. This is intentional -- the consumer gets the same validation guarantees from progressive validation that they would get from validating the complete object at the end.

### Composite Value Validation

For nested objects and arrays, validation occurs at two levels:

1. **Leaf fields**: Individual scalar values (`$.address.city = "Portland"`) are validated against their schema type (`z.string()`) as they complete.
2. **Composite fields**: When a nested object or array completes (`$.address` closes with `}`), the entire composite value is validated against its schema type (`z.object({ street, city, zip })`). This catches cross-field constraints (e.g., a `.refine()` on the address object that requires either both street and city, or neither).

Leaf validation provides early feedback (the city is valid as soon as it completes). Composite validation provides complete validation (the address as a whole meets its constraints). Both are performed.

### Type Coercion

By default, no type coercion is performed. The raw JSON value is passed to Zod's `.safeParse()`, which applies the schema's own coercion rules (if the schema uses `z.coerce.number()`, for example). The `coerce` option in `StreamValidatorOptions` enables automatic coercion for common cases:

| JSON Type | Schema Type | Coercion |
|-----------|-------------|----------|
| string `"42"` | `z.number()` | `Number("42")` -> `42` |
| string `"true"` | `z.boolean()` | `"true"` -> `true` |
| number `1` | `z.boolean()` | `1` -> `true`, `0` -> `false` |
| string `"2024-01-15"` | `z.date()` | `new Date("2024-01-15")` |

Coercion is applied before Zod validation, so the coerced value is what Zod sees. If coercion fails (e.g., `Number("not a number")` -> `NaN`), the original value is passed to Zod, which will likely reject it.

### DeepPartial Type Generation

`stream-validate` generates a `DeepPartial<T>` type from the Zod schema's inferred type. This type makes every field at every nesting level optional:

```typescript
// Given:
type User = z.infer<typeof UserSchema>;
// { name: string; age: number; email: string; address: { street: string; city: string; zip: string }; tags: string[] }

// DeepPartial<User> is:
// { name?: string; age?: number; email?: string; address?: { street?: string; city?: string; zip?: string }; tags?: string[] }
```

The `DeepPartial` utility type is defined recursively:

```typescript
type DeepPartial<T> = T extends object
  ? T extends Array<infer U>
    ? Array<DeepPartial<U>> | undefined
    : { [K in keyof T]?: DeepPartial<T[K]> }
  : T;
```

Array fields remain arrays (not optional arrays of optional elements) because array elements are validated individually. An array field is either absent (pending) or contains its validated elements. Partially received arrays contain only the elements that have completed.

### Validation Error Handling

Validation errors on individual fields do not abort the stream. The error is reported via a `ValidationError` event (or the `onValidationError` callback), the field is excluded from the partial object, and parsing continues. This design is intentional: one invalid field should not prevent the consumer from receiving the other valid fields.

The `validationErrorStrategy` option controls additional behavior:

| Strategy | Behavior |
|----------|----------|
| `exclude` (default) | Exclude the invalid field from the partial. Continue parsing. |
| `include-raw` | Include the raw (unvalidated) value in the partial, with a flag indicating it is unvalidated. Useful for debugging or when the consumer wants to display the raw value with an error indicator. |
| `abort` | Stop the pipeline. The consumer receives the current partial and the stream ends. |

---

## 8. API Surface

### Installation

```bash
npm install stream-validate
```

### Peer Dependency

```json
{
  "peerDependencies": {
    "zod": "^3.22.0"
  }
}
```

### Primary Function: `streamValidate`

```typescript
import { streamValidate } from 'stream-validate';
import { z } from 'zod';

const UserSchema = z.object({
  name: z.string(),
  age: z.number(),
  email: z.string().email(),
});

type User = z.infer<typeof UserSchema>;

const stream: AsyncIterable<string> = getStreamFromLLM();

for await (const partial of streamValidate(stream, UserSchema)) {
  console.log(partial.data);       // DeepPartial<User>
  console.log(partial.meta);       // FieldMeta map
  console.log(partial.isComplete); // boolean
}
```

### Type Definitions

```typescript
import { z, type ZodObject, type ZodRawShape, type ZodTypeAny } from 'zod';

// ── Deep Partial Utility ─────────────────────────────────────────────

/**
 * Recursively makes all properties optional.
 * Arrays remain arrays but are optional at the field level.
 */
type DeepPartial<T> = T extends object
  ? T extends Array<infer U>
    ? Array<DeepPartial<U>> | undefined
    : { [K in keyof T]?: DeepPartial<T[K]> }
  : T;

// ── Validated Partial ────────────────────────────────────────────────

/**
 * A progressively validated partial object emitted during streaming.
 */
interface ValidatedPartial<T> {
  /** The partial object containing only validated, complete fields. */
  data: DeepPartial<T>;

  /** Metadata about each field's status. */
  meta: FieldMeta;

  /**
   * True when all fields in the schema have been validated.
   * The data property contains the full T (not DeepPartial) when true.
   */
  isComplete: boolean;

  /**
   * Monotonically increasing sequence number.
   * First emission is 1.
   */
  seq: number;

  /**
   * Milliseconds elapsed since the stream started.
   */
  elapsedMs: number;
}

// ── Field Metadata ───────────────────────────────────────────────────

/**
 * Map from JSON path strings to field status.
 * Example: { "$.name": "complete", "$.age": "active", "$.email": "pending" }
 */
type FieldMeta = Record<string, FieldStatus>;

type FieldStatus = 'complete' | 'active' | 'pending' | 'error';

// ── Stream Validator Options ─────────────────────────────────────────

interface StreamValidatorOptions {
  /**
   * How to handle JSON parse errors.
   * - 'abort': Stop parsing immediately.
   * - 'skip-value': Skip the invalid value, continue parsing. (default)
   * - 'skip-to-next-key': Skip to the next object key.
   */
  onParseError?: 'abort' | 'skip-value' | 'skip-to-next-key';

  /**
   * How to handle Zod validation errors on individual fields.
   * - 'exclude': Exclude the invalid field from the partial. (default)
   * - 'include-raw': Include the raw value with an unvalidated flag.
   * - 'abort': Stop the pipeline.
   */
  validationErrorStrategy?: 'exclude' | 'include-raw' | 'abort';

  /**
   * Enable automatic type coercion before Zod validation.
   * Default: false.
   */
  coerce?: boolean;

  /**
   * Emission strategy: when to yield partial objects.
   * - 'field': Emit after every field completion. (default)
   * - 'debounce': Emit at most once per `debounceMs` interval.
   * - 'paths': Emit only when one of the specified paths completes.
   */
  emitStrategy?: 'field' | 'debounce' | 'paths';

  /**
   * Debounce interval in milliseconds.
   * Only used when emitStrategy is 'debounce'.
   * Default: 50.
   */
  debounceMs?: number;

  /**
   * JSON paths to watch for emission.
   * Only used when emitStrategy is 'paths'.
   * Example: ['$.name', '$.address.city']
   */
  emitPaths?: string[];

  /**
   * Maximum nesting depth for JSON parsing.
   * Default: 64.
   */
  maxDepth?: number;

  /**
   * Timeout in milliseconds. If the stream has not completed within
   * this duration, the pipeline aborts and yields the current partial
   * with a truncated flag.
   * Default: undefined (no timeout).
   */
  timeoutMs?: number;

  /**
   * AbortSignal for external cancellation.
   */
  signal?: AbortSignal;

  /**
   * Callback invoked when a field completes validation.
   */
  onField?: (path: string, value: unknown) => void;

  /**
   * Callback invoked when a validation error occurs on a field.
   */
  onValidationError?: (error: StreamValidationError) => void;

  /**
   * Callback invoked when a JSON parse error occurs.
   */
  onError?: (error: StreamParseError) => void;
}

// ── Error Types ──────────────────────────────────────────────────────

interface StreamValidationError {
  /** The JSON path of the field that failed validation. */
  path: string;

  /** The raw value that failed validation. */
  value: unknown;

  /** The Zod error containing validation failure details. */
  zodError: z.ZodError;

  /** Milliseconds elapsed since the stream started. */
  elapsedMs: number;
}

interface StreamParseError {
  /** Description of the parse error. */
  message: string;

  /** The character position in the stream where the error occurred. */
  position: number;

  /** The current JSON path when the error occurred. */
  path: string;

  /** The character that caused the error, if applicable. */
  char?: string;

  /** Milliseconds elapsed since the stream started. */
  elapsedMs: number;
}

// ── Completion Event ─────────────────────────────────────────────────

interface StreamCompletionEvent<T> {
  /**
   * The final object. If the stream completed normally and all fields
   * passed validation, this is the full T. If the stream was truncated
   * or some fields failed validation, this is a DeepPartial<T>.
   */
  data: T | DeepPartial<T>;

  /** Whether all fields in the schema are present and validated. */
  isComplete: boolean;

  /** Whether the stream was truncated (network error, max_tokens, timeout). */
  truncated: boolean;

  /** Total duration from stream start to completion. */
  totalMs: number;

  /** Number of fields that completed validation. */
  completedFields: number;

  /** Total number of fields in the schema. */
  totalFields: number;

  /** List of field paths that failed validation. */
  failedPaths: string[];

  /** List of field paths that were not received (still pending). */
  pendingPaths: string[];
}

// ── Field Completion Event (internal, emitted by parser) ─────────────

interface FieldCompletionEvent {
  /** JSON path of the completed field. */
  path: string;

  /** The parsed value. */
  value: unknown;

  /** The JSON type of the value. */
  type: 'string' | 'number' | 'boolean' | 'null' | 'object' | 'array';

  /** Character position in the stream where the value started. */
  startPosition: number;

  /** Character position in the stream where the value ended. */
  endPosition: number;
}
```

### `streamValidate` Function

```typescript
/**
 * Stream-validate a JSON response against a Zod schema.
 * Yields ValidatedPartial<T> objects as fields complete.
 *
 * @param stream - Any async iterable of string chunks, or a ReadableStream<string>.
 * @param schema - A Zod object schema defining the expected structure.
 * @param options - Optional configuration.
 * @returns An async iterable of validated partial objects.
 */
function streamValidate<T extends ZodRawShape>(
  stream: AsyncIterable<string> | ReadableStream<string>,
  schema: ZodObject<T>,
  options?: StreamValidatorOptions,
): AsyncIterable<ValidatedPartial<z.infer<ZodObject<T>>>> & {
  /** Promise that resolves with the completion event when the stream ends. */
  completion: Promise<StreamCompletionEvent<z.infer<ZodObject<T>>>>;
};
```

### `createStreamValidator` Factory

```typescript
/**
 * Create a push-based stream validator.
 * Use this when you need to write chunks manually rather than
 * consuming an async iterable.
 *
 * @param schema - A Zod object schema.
 * @param options - Optional configuration.
 * @returns A StreamValidator instance.
 */
function createStreamValidator<T extends ZodRawShape>(
  schema: ZodObject<T>,
  options?: StreamValidatorOptions,
): StreamValidator<z.infer<ZodObject<T>>>;

interface StreamValidator<T> {
  /** Push a string chunk into the parser. */
  write(chunk: string): void;

  /**
   * Signal that the stream has ended.
   * Finalizes parsing and emits the completion event.
   */
  end(): void;

  /**
   * Signal that the stream has ended with an error.
   * Emits the current partial with a truncated flag.
   */
  abort(error?: Error): void;

  /** Register a listener for partial object emissions. */
  on(event: 'partial', listener: (partial: ValidatedPartial<T>) => void): this;

  /** Register a listener for individual field completions. */
  on(event: 'field', listener: (path: string, value: unknown) => void): this;

  /** Register a listener for the final completion event. */
  on(event: 'complete', listener: (event: StreamCompletionEvent<T>) => void): this;

  /** Register a listener for validation errors. */
  on(event: 'validation-error', listener: (error: StreamValidationError) => void): this;

  /** Register a listener for parse errors. */
  on(event: 'parse-error', listener: (error: StreamParseError) => void): this;

  /** Remove a listener. */
  off(event: string, listener: (...args: any[]) => void): this;

  /** Get the current partial object. */
  get current(): ValidatedPartial<T>;

  /** Get the async iterable of partial objects (for consuming as a stream). */
  [Symbol.asyncIterator](): AsyncIterator<ValidatedPartial<T>>;
}
```

### Provider Adapter Functions

```typescript
/**
 * Adapt an OpenAI streaming response to AsyncIterable<string>.
 * Extracts delta.content from Chat Completions SSE events,
 * or output_text.delta from Responses API events.
 */
function fromOpenAI(
  stream: AsyncIterable<OpenAIChatCompletionChunk> | ReadableStream,
): AsyncIterable<string>;

/**
 * Adapt an Anthropic streaming response to AsyncIterable<string>.
 * Extracts text from content_block_delta events with text_delta type.
 */
function fromAnthropic(
  stream: AsyncIterable<AnthropicMessageStreamEvent> | ReadableStream,
): AsyncIterable<string>;

/**
 * Adapt a Google Gemini streaming response to AsyncIterable<string>.
 * Extracts text from GenerateContentResponse candidates.
 */
function fromGemini(
  stream: AsyncIterable<GeminiGenerateContentResponse>,
): AsyncIterable<string>;

/**
 * Adapt a fetch Response to AsyncIterable<string>.
 * Reads from response.body as a text ReadableStream.
 * Useful for custom LLM endpoints that return plain text streams.
 */
function fromFetch(response: Response): AsyncIterable<string>;

/**
 * Adapt Server-Sent Events to AsyncIterable<string>.
 * Parses SSE format and extracts the data field from each event.
 * Handles [DONE] sentinel, comments, and multi-line data fields.
 */
function fromSSE(
  stream: AsyncIterable<string> | ReadableStream<string>,
  options?: { dataField?: string; doneSignal?: string },
): AsyncIterable<string>;
```

---

## 9. Provider Adapters

### Generic: `AsyncIterable<string>`

The universal input contract. Any stream that yields string chunks of JSON content works directly with `streamValidate` without an adapter. This covers:

- Async generators: `async function* () { yield '{"name":'; yield '"Alice"}'; }`
- Node.js Readable streams in object mode: `readable[Symbol.asyncIterator]()`
- WHATWG ReadableStream: `readableStream[Symbol.asyncIterator]()` (or `readableStream.getReader()` with a manual loop for older environments)
- Custom async iterables from any source

### OpenAI Adapter

OpenAI provides two streaming APIs:

**Chat Completions API** (legacy): SSE events where each chunk is a `ChatCompletionChunk` object. The text content is at `chunk.choices[0].delta.content`. The stream ends with a `[DONE]` sentinel.

```
data: {"id":"chatcmpl-...","choices":[{"index":0,"delta":{"content":"{\""}}]}
data: {"id":"chatcmpl-...","choices":[{"index":0,"delta":{"content":"name"}}]}
data: {"id":"chatcmpl-...","choices":[{"index":0,"delta":{"content":"\": \""}}]}
data: {"id":"chatcmpl-...","choices":[{"index":0,"delta":{"content":"Alice"}}]}
data: {"id":"chatcmpl-...","choices":[{"index":0,"delta":{"content":"\"}"}}]}
data: [DONE]
```

**Responses API** (current): SSE events with typed event names. The text content is in `response.output_text.delta` events, with the text in the `delta` field.

The `fromOpenAI` adapter handles both formats:

```typescript
const openai = new OpenAI();
const chatStream = await openai.chat.completions.create({
  model: 'gpt-4o',
  messages: [{ role: 'user', content: 'Return a user profile as JSON' }],
  response_format: { type: 'json_object' },
  stream: true,
});

for await (const partial of streamValidate(fromOpenAI(chatStream), UserSchema)) {
  renderUser(partial.data);
}
```

### Anthropic Adapter

Anthropic streams `MessageStreamEvent` objects. Text content arrives in `content_block_delta` events where `delta.type === 'text_delta'` and the text is in `delta.text`. The event flow is:

```
event: message_start
event: content_block_start     (index: 0, type: "text")
event: content_block_delta     (delta: { type: "text_delta", text: "{\"" })
event: content_block_delta     (delta: { type: "text_delta", text: "name" })
event: content_block_delta     (delta: { type: "text_delta", text: "\": \"Alice\"}" })
event: content_block_stop
event: message_delta
event: message_stop
```

The `fromAnthropic` adapter filters for `content_block_delta` events with `text_delta` type and extracts the text:

```typescript
const anthropic = new Anthropic();
const messageStream = await anthropic.messages.create({
  model: 'claude-sonnet-4-20250514',
  max_tokens: 1024,
  messages: [{ role: 'user', content: 'Return a user profile as JSON' }],
  stream: true,
});

for await (const partial of streamValidate(fromAnthropic(messageStream), UserSchema)) {
  renderUser(partial.data);
}
```

### Google Gemini Adapter

Google Gemini streams `GenerateContentResponse` objects. Text content is at `response.candidates[0].content.parts[0].text`. Each response chunk may contain one or more text parts.

```typescript
const genAI = new GoogleGenerativeAI(apiKey);
const model = genAI.getGenerativeModel({ model: 'gemini-pro' });
const result = await model.generateContentStream('Return a user profile as JSON');

for await (const partial of streamValidate(fromGemini(result.stream), UserSchema)) {
  renderUser(partial.data);
}
```

### Fetch Response Adapter

For custom LLM endpoints that return streaming text via HTTP chunked transfer encoding or SSE, the `fromFetch` adapter reads from the `Response.body` ReadableStream and decodes chunks as text:

```typescript
const response = await fetch('https://my-llm-api.com/generate', {
  method: 'POST',
  body: JSON.stringify({ prompt: 'Return a user profile as JSON' }),
});

for await (const partial of streamValidate(fromFetch(response), UserSchema)) {
  renderUser(partial.data);
}
```

### SSE Adapter

For raw SSE streams (e.g., from EventSource or custom SSE endpoints), the `fromSSE` adapter parses the SSE text format, extracts `data:` fields, handles multi-line data, ignores comments (lines starting with `:`), and stops on the configured done signal (default: `[DONE]`):

```typescript
const response = await fetch('https://api.example.com/stream');
const textStream = fromFetch(response); // raw SSE text

for await (const partial of streamValidate(fromSSE(textStream), UserSchema)) {
  renderUser(partial.data);
}
```

### Custom Adapter API

Developers can write custom adapters for any stream source. An adapter is simply an async generator function that yields strings:

```typescript
async function* fromCustomSource(source: CustomStream): AsyncIterable<string> {
  for await (const event of source) {
    if (event.type === 'text') {
      yield event.content;
    }
  }
}

for await (const partial of streamValidate(fromCustomSource(myStream), UserSchema)) {
  renderUser(partial.data);
}
```

---

## 10. Partial Object Emission

### Emission Triggers

By default (with `emitStrategy: 'field'`), a new `ValidatedPartial<T>` is emitted every time a scalar field completes validation. Specifically:

1. **Scalar field completion**: When `$.name`, `$.age`, or any leaf-level field completes and passes validation.
2. **Array element completion**: When an array element completes validation (e.g., `$.tags[0]`). The partial includes the updated array with the new element.
3. **Nested object completion**: When all fields of a nested object have completed and the closing `}` is received. The composite validation runs and, if successful, the partial is emitted with the complete nested object.

### Debounced Emission

With `emitStrategy: 'debounce'`, partials are emitted at most once per `debounceMs` milliseconds. The debounce timer resets each time a field completes. This reduces the number of partial objects emitted for schemas with many fields, avoiding excessive re-renders in UI applications. The final partial (or completion event) is always emitted regardless of the debounce timer.

### Path-Filtered Emission

With `emitStrategy: 'paths'`, partials are emitted only when one of the specified `emitPaths` completes. This enables selective observation -- for example, emitting only when `$.name` or `$.summary` completes, ignoring intermediate field completions for less important fields. Useful for dashboards that display specific fields prominently.

### Immutability and Clone Semantics

Each emitted `ValidatedPartial<T>` contains a new object. The `data` property is a fresh object constructed by applying all completed fields to a new `DeepPartial<T>`. It is not a mutation of the previous partial's data object. This means consumers can safely store references to previous partials without worrying about them being modified by subsequent emissions. This is critical for React's state management, where `setState(partial.data)` must receive a new object reference to trigger a re-render.

The clone is a shallow structural clone -- objects at each level are new, but the leaf values (strings, numbers, booleans) are shared. This is efficient because JavaScript primitive values are immutable.

### `undefined` vs `null` Semantics

In a `ValidatedPartial<T>`, there is a clear distinction:

- **`undefined` (missing property)**: The field has not yet been received from the stream. It is either `pending` or `active`. The property does not exist on the partial object.
- **`null`**: The field's value is explicitly JSON `null`. The LLM returned `null` for this field, and it passed validation (the schema allows `z.nullable()` for this field).

This distinction is important for UI rendering: `undefined` means "not loaded yet" (show a placeholder or skeleton), while `null` means "intentionally empty" (show "N/A" or a null indicator).

### Metadata Per Emission

Each `ValidatedPartial<T>` includes a `meta` property that maps JSON paths to their current status. The meta object is updated with each emission:

```typescript
// After name completes:
{
  data: { name: "Alice" },
  meta: {
    "$.name": "complete",
    "$.age": "pending",
    "$.email": "pending",
    "$.address": "pending",
    "$.tags": "pending",
  },
  isComplete: false,
  seq: 1,
  elapsedMs: 245,
}

// After age starts streaming:
{
  data: { name: "Alice" },
  meta: {
    "$.name": "complete",
    "$.age": "active",
    "$.email": "pending",
    "$.address": "pending",
    "$.tags": "pending",
  },
  isComplete: false,
  seq: 2,  // (emitted because age transitioned to active, if tracking active transitions)
  elapsedMs: 312,
}

// After age completes:
{
  data: { name: "Alice", age: 30 },
  meta: {
    "$.name": "complete",
    "$.age": "complete",
    "$.email": "pending",
    "$.address": "pending",
    "$.tags": "pending",
  },
  isComplete: false,
  seq: 3,
  elapsedMs: 380,
}
```

---

## 11. Error Handling

### Malformed JSON in Stream

When the LLM produces invalid JSON characters mid-stream, the incremental parser detects the error immediately at the character that violates the JSON grammar. Common malformations from LLMs include:

| Malformation | Example | Detection Point |
|-------------|---------|----------------|
| Trailing comma | `{"a": 1, }` | The `}` after `,` when expecting a key string |
| Single-quoted string | `{'name': 'Alice'}` | The `'` when expecting `"` for a key or string value |
| Unquoted key | `{name: "Alice"}` | The `n` when expecting `"` for a key |
| Comment | `{"a": 1 // comment}` | The `/` when expecting `,` or `}` |
| JavaScript literal | `{"a": undefined}` | The `u` when expecting a JSON value |
| Truncated string | `{"name": "Ali` | End of stream while inside string state |
| Truncated number | `{"age": 3` | End of stream while inside number state |

**Recovery behavior** (with default `skip-value` strategy): The parser skips characters until it finds a recognizable recovery point (`,`, `}`, or `]`), then resumes parsing from there. All fields parsed before the error are preserved in the partial. Fields after the error resume normal parsing after recovery.

### Validation Failure on a Field

When a field value completes parsing but fails Zod validation, the `StreamValidationError` event is emitted:

```typescript
// Schema expects z.string().email(), but LLM produced "not-an-email"
{
  path: "$.email",
  value: "not-an-email",
  zodError: ZodError([{
    code: "invalid_string",
    validation: "email",
    message: "Invalid email",
    path: [],
  }]),
  elapsedMs: 450,
}
```

The field is excluded from subsequent partial emissions (with default `exclude` strategy). Other fields continue to validate normally. The consumer's `onValidationError` callback receives the error for logging or user notification.

### Stream Interruption

Stream interruptions occur when:

1. **Network error**: The HTTP connection drops mid-stream. The source async iterable throws an error.
2. **`max_tokens` cutoff**: The LLM reaches its token limit and the response is truncated. The stream ends normally (no error), but the JSON is incomplete.
3. **Timeout**: The `timeoutMs` option triggers after the configured duration.
4. **External cancellation**: The `signal` AbortSignal is triggered.

In all cases, `stream-validate` emits a completion event with `truncated: true` and the best available partial:

```typescript
const result = streamValidate(stream, UserSchema, { timeoutMs: 5000 });

for await (const partial of result) {
  renderUser(partial.data);
}

const completion = await result.completion;
if (completion.truncated) {
  console.warn(`Stream truncated. Got ${completion.completedFields}/${completion.totalFields} fields.`);
  console.warn(`Missing: ${completion.pendingPaths.join(', ')}`);
}
```

For `max_tokens` cutoff, the parser detects that the stream ended while inside a JSON structure (the state stack is not empty). If the parser is inside a string value, the partial string is discarded (it may be incomplete). If the parser is between fields (the last field completed but the next has not started), the partial includes all completed fields.

### Schema Mismatch

When the LLM produces JSON that does not match the expected structure at all (e.g., the schema expects an object but the LLM returns an array, or the LLM returns a completely different object shape), the behavior depends on where the mismatch occurs:

- **Root-level mismatch**: If the root schema is `z.object()` but the stream starts with `[`, a parse error is emitted and the pipeline aborts (the parser expected `{` at the root level).
- **Missing expected keys**: Keys expected by the schema but not present in the JSON are simply never marked as `complete`. They remain `pending` in the metadata.
- **Extra unexpected keys**: Keys present in the JSON but not in the schema are parsed (the parser does not consult the schema) but are not included in the validated partial (Stage 3 finds no matching schema entry and ignores the field). No error is emitted for extra keys, matching Zod's default `strip` behavior for unknown keys.

---

## 12. Streaming to UI

### React Integration Pattern

```typescript
import { useState, useEffect, useRef } from 'react';
import { streamValidate, fromOpenAI } from 'stream-validate';
import { z } from 'zod';

const ProfileSchema = z.object({
  name: z.string(),
  bio: z.string(),
  skills: z.array(z.string()),
  experience: z.number(),
});

type Profile = z.infer<typeof ProfileSchema>;

function useStreamValidate<T>(
  streamFactory: () => AsyncIterable<string>,
  schema: z.ZodObject<any>,
) {
  const [partial, setPartial] = useState<ValidatedPartial<T> | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    abortRef.current = controller;

    (async () => {
      try {
        const stream = streamFactory();
        for await (const p of streamValidate(stream, schema, {
          signal: controller.signal,
        })) {
          if (controller.signal.aborted) break;
          setPartial(p as ValidatedPartial<T>);
        }
      } catch (err) {
        if (!controller.signal.aborted) {
          setError(err as Error);
        }
      }
    })();

    return () => {
      controller.abort();
    };
  }, []);

  return { partial, error };
}

function ProfileCard() {
  const { partial, error } = useStreamValidate<Profile>(
    () => fromOpenAI(fetchProfileStream()),
    ProfileSchema,
  );

  if (error) return <div>Error: {error.message}</div>;
  if (!partial) return <div>Loading...</div>;

  return (
    <div>
      {partial.meta['$.name'] === 'complete'
        ? <h1>{partial.data.name}</h1>
        : <h1 className="skeleton" />}
      {partial.meta['$.bio'] === 'active'
        ? <p className="typing">{partial.data.bio}</p>
        : partial.meta['$.bio'] === 'complete'
        ? <p>{partial.data.bio}</p>
        : <p className="skeleton" />}
      {partial.data.skills?.map((skill, i) => (
        <span key={i} className="badge">{skill}</span>
      ))}
    </div>
  );
}
```

### Vue / Composable Pattern

```typescript
import { ref, onUnmounted } from 'vue';
import { streamValidate } from 'stream-validate';
import type { ValidatedPartial } from 'stream-validate';

function useStreamValidate<T>(
  streamFactory: () => AsyncIterable<string>,
  schema: z.ZodObject<any>,
) {
  const partial = ref<ValidatedPartial<T> | null>(null);
  const error = ref<Error | null>(null);
  const controller = new AbortController();

  (async () => {
    try {
      for await (const p of streamValidate(streamFactory(), schema, {
        signal: controller.signal,
      })) {
        partial.value = p as ValidatedPartial<T>;
      }
    } catch (err) {
      if (!controller.signal.aborted) {
        error.value = err as Error;
      }
    }
  })();

  onUnmounted(() => controller.abort());

  return { partial, error };
}
```

### Server-Sent Events Forwarding

For applications that need to forward progressive validation results to connected browser clients:

```typescript
import { streamValidate, fromAnthropic } from 'stream-validate';

app.get('/api/profile/stream', async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  const llmStream = await anthropic.messages.create({ /* ... */ stream: true });

  for await (const partial of streamValidate(fromAnthropic(llmStream), ProfileSchema)) {
    res.write(`data: ${JSON.stringify(partial.data)}\n\n`);
  }

  res.write('event: done\ndata: {}\n\n');
  res.end();
});
```

---

## 13. Configuration

### Complete Options Reference

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `onParseError` | `'abort' \| 'skip-value' \| 'skip-to-next-key'` | `'skip-value'` | How to handle JSON parse errors. |
| `validationErrorStrategy` | `'exclude' \| 'include-raw' \| 'abort'` | `'exclude'` | How to handle Zod validation failures. |
| `coerce` | `boolean` | `false` | Enable type coercion before validation. |
| `emitStrategy` | `'field' \| 'debounce' \| 'paths'` | `'field'` | When to emit partial objects. |
| `debounceMs` | `number` | `50` | Debounce interval (only with `debounce` strategy). |
| `emitPaths` | `string[]` | `[]` | Paths to watch (only with `paths` strategy). |
| `maxDepth` | `number` | `64` | Maximum JSON nesting depth. |
| `timeoutMs` | `number` | `undefined` | Stream timeout in milliseconds. |
| `signal` | `AbortSignal` | `undefined` | External cancellation signal. |
| `onField` | `(path, value) => void` | `undefined` | Callback on each field completion. |
| `onValidationError` | `(error) => void` | `undefined` | Callback on validation failures. |
| `onError` | `(error) => void` | `undefined` | Callback on parse errors. |

### Configuration Examples

**Strict mode**: Abort on any error.

```typescript
streamValidate(stream, schema, {
  onParseError: 'abort',
  validationErrorStrategy: 'abort',
  timeoutMs: 30_000,
});
```

**Tolerant mode**: Skip errors, emit partials on a debounce.

```typescript
streamValidate(stream, schema, {
  onParseError: 'skip-value',
  validationErrorStrategy: 'include-raw',
  emitStrategy: 'debounce',
  debounceMs: 100,
});
```

**Selective observation**: Only care about specific fields.

```typescript
streamValidate(stream, schema, {
  emitStrategy: 'paths',
  emitPaths: ['$.title', '$.summary', '$.tags'],
});
```

---

## 14. Testing Strategy

### Unit Testing the Incremental Parser

The parser is tested independently from the validation layer. Tests provide character sequences (as single-character chunks, multi-character chunks, and single large chunks) and verify that the correct `FieldCompletion` events are emitted with the correct paths and values.

**Test categories**:

| Category | Examples |
|----------|---------|
| Scalar values | String, number, boolean, null at root level and nested |
| Escape sequences | `\"`, `\\`, `\n`, `\t`, `\uXXXX`, surrogate pairs |
| Number edge cases | `0`, `-0`, `1e10`, `3.14`, `-1.5E-3`, `0.001` |
| Nested objects | 1 level, 5 levels, maximum depth |
| Arrays | Empty array, single element, mixed types, nested arrays |
| Chunk boundaries | Split tokens across chunks at every possible position |
| Error cases | Trailing comma, unquoted key, truncated input, invalid literal |
| Recovery | Skip-value recovery, skip-to-next-key recovery |

**Chunk boundary testing**: A critical test fixture generates every possible 2-split of a JSON string and verifies that the parser produces the same output regardless of where the split occurs. For a JSON string of length N, this produces N-1 test cases. This ensures the parser handles arbitrary chunk boundaries correctly.

### Unit Testing Progressive Validation

The validation layer is tested with mock `FieldCompletion` events (not connected to the parser). Tests verify:

- Correct schema lookup for simple paths (`$.name`), nested paths (`$.address.city`), and array paths (`$.items[0].name`).
- Validation passes and failures for each Zod type.
- Partial object construction: fields accumulate correctly.
- Immutability: previous partials are not mutated.
- Metadata tracking: field statuses transition correctly.

### Integration Testing

End-to-end tests connect the full pipeline: a mock async generator yields chunks, the parser parses them, validation validates them, and the test consumes the emitted partials.

**Simulation test fixtures**: Recorded LLM responses (stored as JSON arrays of string chunks) are replayed through the pipeline. Fixtures cover:

- OpenAI JSON mode response (character-by-character)
- Anthropic text_delta response (word-by-word)
- Truncated response (mid-string cutoff)
- Large response (1000+ fields)
- Response with validation errors (wrong types for some fields)

### Provider Adapter Testing

Each adapter is tested with mock provider stream events. The test verifies that the adapter correctly extracts text content and yields it as plain strings. Provider-specific edge cases are covered:

- OpenAI: `delta.content` is null/undefined on some chunks (function call chunks)
- Anthropic: Non-text content blocks (tool_use blocks) are filtered out
- Gemini: Empty candidates array
- Fetch: Non-200 response, empty body

### Testing Utilities

`stream-validate` exports test utilities for consumer testing:

```typescript
import { mockStream } from 'stream-validate/testing';

// Create a mock stream that yields chunks with configurable delays
const stream = mockStream('{"name": "Alice", "age": 30}', {
  chunkSize: 5,       // characters per chunk
  delayMs: 10,        // delay between chunks
});

// Create a mock stream from an array of explicit chunks
const stream2 = mockStream(['{"name":', ' "Alice",', ' "age": 30}']);
```

---

## 15. Performance

### Parser Overhead

The incremental JSON parser processes one character at a time with O(1) work per character (a switch statement on the current state and the input character). There are no regular expressions, no string concatenation for non-string values, and no backtracking. The parser's per-character cost is comparable to a hand-written lexer: approximately 50-100 nanoseconds per character on modern hardware. For a typical LLM JSON response of 1-10 KB, the total parsing overhead is 50-1000 microseconds -- negligible compared to the network latency of the stream.

String values require buffer accumulation. The parser appends characters to an array and joins them when the string completes. This is O(n) in the length of the string value, which is the theoretical minimum.

### Memory Usage

Memory usage is proportional to:

1. **State stack depth**: O(d) where d is the nesting depth. Each stack frame is a small struct (state enum, path segment, accumulator reference). At the default max depth of 64, this is negligible.
2. **Largest in-progress value**: The string buffer for the currently accumulating string value. For typical LLM output, this is at most a few KB (a long string field like a description or summary).
3. **Accumulated partial object**: The partial object grows as fields complete. Its size is proportional to the number of completed fields and their values. This is bounded by the size of the final JSON output.

The parser does not retain completed values. Once a field completion event is emitted, the parser discards the value. Stage 3 retains the accumulated partial object, which is the minimum memory required to emit partials.

### Latency Per Chunk

The end-to-end latency from receiving a chunk to emitting a partial is dominated by the Zod `.safeParse()` call. For simple types (`z.string()`, `z.number()`), safeParse takes approximately 1-5 microseconds. For complex types with refinements (`.email()`, `.regex()`), it may take 10-50 microseconds. For composite objects with many fields, the final composite validation may take 100-500 microseconds. These latencies are far below the rendering frame budget (16ms for 60fps) and the inter-chunk arrival time from LLM streams (typically 10-100ms per token).

### Benchmark Targets

| Scenario | Target |
|----------|--------|
| Parse throughput (chars/sec) | > 10 million |
| Per-field validation overhead | < 100 microseconds |
| Memory overhead (above raw JSON size) | < 2x |
| Time to first partial emission | < 5ms from first chunk |

---

## 16. Dependencies

### Runtime Dependencies

None. `stream-validate` has zero runtime dependencies.

### Peer Dependencies

| Package | Version | Purpose |
|---------|---------|---------|
| `zod` | `^3.22.0` | Schema definition and validation. The consumer must install Zod independently. |

### Dev Dependencies

| Package | Version | Purpose |
|---------|---------|---------|
| `typescript` | `^5.3.0` | TypeScript compiler. |
| `vitest` | `^1.0.0` | Test runner. |
| `eslint` | `^8.0.0` | Linter. |
| `@types/node` | `^20.0.0` | Node.js type definitions. |

### Why Zero Runtime Dependencies

The incremental JSON parser is implemented from scratch because existing streaming JSON parsers (`@streamparser/json`, `stream-json`, `partial-json-parser`) are designed for general-purpose use cases and provide APIs that do not align with `stream-validate`'s specific needs. The parser needs to emit field-level events with JSON path information, track field status for metadata, and integrate tightly with the Zod validation stage. Building on a general-purpose parser would require wrapping it, losing the ability to control error recovery behavior and field completion detection. The custom parser is approximately 500-700 lines of focused, well-tested code -- smaller than the transitive dependency tree of any alternative.

Zod is a peer dependency rather than a bundled dependency because the consumer's application already uses Zod for schema definition. Bundling Zod would create duplicate instances, increasing bundle size and potentially causing type incompatibilities.

---

## 17. File Structure

```
stream-validate/
├── src/
│   ├── index.ts                    # Public API exports
│   ├── stream-validate.ts          # streamValidate() function implementation
│   ├── stream-validator.ts         # StreamValidator class (push-based API)
│   ├── parser/
│   │   ├── incremental-parser.ts   # Character-by-character JSON state machine
│   │   ├── states.ts               # Parser state enum and context types
│   │   └── path-tracker.ts         # JSON path stack management
│   ├── validation/
│   │   ├── progressive-validator.ts # Zod field validation, partial object building
│   │   ├── schema-map.ts           # Zod schema traversal, path-to-type mapping
│   │   └── deep-partial.ts         # DeepPartial<T> type utility
│   ├── adapters/
│   │   ├── openai.ts               # fromOpenAI adapter
│   │   ├── anthropic.ts            # fromAnthropic adapter
│   │   ├── gemini.ts               # fromGemini adapter
│   │   ├── fetch.ts                # fromFetch adapter
│   │   └── sse.ts                  # fromSSE adapter
│   ├── types.ts                    # All public TypeScript type definitions
│   └── testing.ts                  # Test utilities (mockStream)
├── src/__tests__/
│   ├── parser/
│   │   ├── incremental-parser.test.ts   # Parser unit tests
│   │   ├── chunk-boundary.test.ts       # Chunk boundary exhaustive tests
│   │   ├── escape-sequences.test.ts     # String escape handling tests
│   │   ├── numbers.test.ts              # Number parsing edge cases
│   │   └── error-recovery.test.ts       # Parse error recovery tests
│   ├── validation/
│   │   ├── progressive-validator.test.ts # Validation unit tests
│   │   ├── schema-map.test.ts           # Schema traversal tests
│   │   └── partial-emission.test.ts     # Partial object construction tests
│   ├── adapters/
│   │   ├── openai.test.ts               # OpenAI adapter tests
│   │   ├── anthropic.test.ts            # Anthropic adapter tests
│   │   ├── gemini.test.ts               # Gemini adapter tests
│   │   └── fetch.test.ts               # Fetch adapter tests
│   ├── integration/
│   │   ├── end-to-end.test.ts           # Full pipeline integration tests
│   │   ├── fixtures/                    # Recorded LLM response fixtures
│   │   │   ├── openai-user-profile.json
│   │   │   ├── anthropic-analysis.json
│   │   │   └── truncated-response.json
│   │   ├── backpressure.test.ts         # Backpressure behavior tests
│   │   └── timeout.test.ts             # Timeout and cancellation tests
│   └── testing.test.ts                 # Test utility tests
├── package.json
├── tsconfig.json
├── SPEC.md
└── README.md
```

---

## 18. Implementation Roadmap

### Phase 1: Core Parser (Week 1)

**Deliverables**: The incremental JSON parser with full test coverage.

1. Implement the state machine with all JSON grammar states.
2. Implement path tracking.
3. Implement field completion detection for all value types.
4. Implement string parsing with escape sequence handling.
5. Implement number parsing and validation.
6. Implement nested object and array parsing.
7. Write chunk boundary exhaustive tests.
8. Write error recovery tests.

**Exit criteria**: Parser correctly parses any valid JSON document delivered in arbitrary chunk sizes, emitting correct `FieldCompletion` events with correct paths and values. All edge cases in the test suite pass.

### Phase 2: Progressive Validation (Week 2)

**Deliverables**: The schema map and progressive validation stage.

1. Implement Zod schema traversal to build the `SchemaMap`.
2. Implement per-field validation with `safeParse`.
3. Implement partial object construction with immutable semantics.
4. Implement field metadata tracking.
5. Implement the `DeepPartial<T>` type utility.
6. Implement validation error handling strategies.
7. Write validation unit tests.
8. Write partial emission tests.

**Exit criteria**: Given mock `FieldCompletion` events, the validator produces correct `ValidatedPartial<T>` objects with correct types, metadata, and immutability guarantees.

### Phase 3: Pipeline Assembly (Week 2-3)

**Deliverables**: The `streamValidate` function and `StreamValidator` class.

1. Implement the `streamValidate` function connecting Stages 1, 2, and 3.
2. Implement the `StreamValidator` class with write/end/abort API and event emitter.
3. Implement emission strategies (field, debounce, paths).
4. Implement timeout and AbortSignal support.
5. Implement the `completion` promise.
6. Implement `ReadableStream` to `AsyncIterable` adaptation.
7. Write end-to-end integration tests.
8. Write backpressure tests.

**Exit criteria**: Full pipeline works end-to-end with async iterables and ReadableStreams. All emission strategies work. Timeout and cancellation work. Backpressure is respected.

### Phase 4: Provider Adapters (Week 3)

**Deliverables**: All provider adapter functions.

1. Implement `fromOpenAI` (Chat Completions and Responses API formats).
2. Implement `fromAnthropic` (content_block_delta extraction).
3. Implement `fromGemini` (GenerateContentResponse extraction).
4. Implement `fromFetch` (Response body reading).
5. Implement `fromSSE` (SSE format parsing).
6. Write adapter tests with mock provider events.

**Exit criteria**: Each adapter correctly transforms provider-specific stream events into plain string chunks. Edge cases (null deltas, non-text blocks, empty responses) are handled.

### Phase 5: Testing Utilities and Polish (Week 4)

**Deliverables**: Test utilities, documentation, and final polish.

1. Implement `mockStream` test utility.
2. Create recorded LLM response fixtures.
3. Write comprehensive README with usage examples.
4. Run performance benchmarks and optimize hot paths if needed.
5. Review and finalize all public API types.
6. Ensure all tests pass, lint is clean, build succeeds.

**Exit criteria**: Package is ready for initial npm publish. All tests pass. README covers all use cases. Performance meets benchmark targets.

---

## 19. Example Use Cases

### Streaming Chat UI with Progressive Object Rendering

A chat application where the user asks for a structured analysis. The LLM streams a JSON object with `summary`, `keyPoints`, `sentiment`, and `recommendations` fields. The UI renders each section as it completes:

```typescript
import { streamValidate, fromAnthropic } from 'stream-validate';
import { z } from 'zod';

const AnalysisSchema = z.object({
  summary: z.string(),
  keyPoints: z.array(z.string()),
  sentiment: z.enum(['positive', 'negative', 'neutral', 'mixed']),
  confidence: z.number().min(0).max(1),
  recommendations: z.array(z.object({
    action: z.string(),
    priority: z.enum(['high', 'medium', 'low']),
    rationale: z.string(),
  })),
});

const stream = await anthropic.messages.create({
  model: 'claude-sonnet-4-20250514',
  max_tokens: 2048,
  messages: [{ role: 'user', content: 'Analyze this quarterly report...' }],
  stream: true,
});

for await (const partial of streamValidate(fromAnthropic(stream), AnalysisSchema)) {
  // Summary appears first -- show it immediately
  if (partial.data.summary) {
    renderSummary(partial.data.summary);
  }

  // Key points stream in one at a time
  if (partial.data.keyPoints) {
    renderBulletList(partial.data.keyPoints);
  }

  // Sentiment badge appears as soon as the enum value completes
  if (partial.data.sentiment) {
    renderSentimentBadge(partial.data.sentiment);
  }

  // Recommendations appear as each one completes
  if (partial.data.recommendations) {
    renderRecommendations(partial.data.recommendations);
  }

  // Show progress indicator
  renderProgress(partial.meta);
}
```

### Data Extraction Pipeline

An extraction pipeline that processes documents and extracts structured entities. Each entity is validated as it completes, and valid entities are immediately forwarded to a database:

```typescript
import { streamValidate, fromOpenAI } from 'stream-validate';
import { z } from 'zod';

const ExtractionSchema = z.object({
  entities: z.array(z.object({
    name: z.string(),
    type: z.enum(['person', 'organization', 'location', 'event']),
    confidence: z.number().min(0).max(1),
    mentions: z.array(z.object({
      text: z.string(),
      offset: z.number(),
    })),
  })),
  relationships: z.array(z.object({
    source: z.string(),
    target: z.string(),
    type: z.string(),
    confidence: z.number().min(0).max(1),
  })),
});

const stream = await openai.chat.completions.create({
  model: 'gpt-4o',
  response_format: { type: 'json_object' },
  messages: [{ role: 'user', content: `Extract entities from: ${document}` }],
  stream: true,
});

let lastEntityCount = 0;

for await (const partial of streamValidate(fromOpenAI(stream), ExtractionSchema)) {
  // Process new entities as they complete
  const entities = partial.data.entities ?? [];
  if (entities.length > lastEntityCount) {
    const newEntities = entities.slice(lastEntityCount);
    for (const entity of newEntities) {
      await db.insertEntity(entity);  // Insert immediately, don't wait for full response
    }
    lastEntityCount = entities.length;
  }
}
```

### Agent Tool Output Validation

An agent framework where one LLM generates structured tool arguments. The downstream tool can start executing as soon as its required arguments are available:

```typescript
import { streamValidate, fromOpenAI } from 'stream-validate';
import { z } from 'zod';

const SearchToolSchema = z.object({
  query: z.string().min(1),
  filters: z.object({
    dateRange: z.object({
      start: z.string(),
      end: z.string(),
    }).optional(),
    category: z.enum(['news', 'academic', 'web']).optional(),
    language: z.string().optional(),
  }).optional(),
  maxResults: z.number().int().min(1).max(100).optional(),
});

const stream = await openai.chat.completions.create({
  model: 'gpt-4o',
  response_format: { type: 'json_object' },
  messages: [{ role: 'user', content: 'Search for recent AI safety papers' }],
  stream: true,
});

const result = streamValidate(fromOpenAI(stream), SearchToolSchema, {
  emitStrategy: 'paths',
  emitPaths: ['$.query'],  // Start searching as soon as query is available
});

for await (const partial of result) {
  if (partial.data.query && !searchStarted) {
    // Start the search immediately with just the query
    searchPromise = startSearch(partial.data.query);
    searchStarted = true;
  }
}

// Refine search with filters once the full response is available
const completion = await result.completion;
if (completion.data.filters) {
  await refineSearch(searchPromise, completion.data.filters);
}
```

### Graceful Degradation with Truncated Responses

A service that handles `max_tokens` cutoff gracefully by using whatever fields completed before truncation:

```typescript
import { streamValidate, fromAnthropic } from 'stream-validate';
import { z } from 'zod';

const ReportSchema = z.object({
  title: z.string(),
  executive_summary: z.string(),
  sections: z.array(z.object({
    heading: z.string(),
    content: z.string(),
    charts: z.array(z.object({
      type: z.enum(['bar', 'line', 'pie']),
      data: z.record(z.number()),
    })).optional(),
  })),
  conclusion: z.string(),
});

const stream = await anthropic.messages.create({
  model: 'claude-sonnet-4-20250514',
  max_tokens: 4096,  // May not be enough for a full report
  messages: [{ role: 'user', content: 'Generate a quarterly report...' }],
  stream: true,
});

const result = streamValidate(fromAnthropic(stream), ReportSchema, {
  timeoutMs: 60_000,
});

let latestPartial: ValidatedPartial<z.infer<typeof ReportSchema>> | null = null;

for await (const partial of result) {
  latestPartial = partial;
}

const completion = await result.completion;

if (completion.truncated) {
  // Return what we have with a note about truncation
  return {
    report: completion.data,
    complete: false,
    completedSections: completion.completedFields,
    totalExpectedSections: completion.totalFields,
    missing: completion.pendingPaths,
    message: `Report was truncated. ${completion.completedFields} of ${completion.totalFields} fields completed.`,
  };
} else {
  return {
    report: completion.data,
    complete: true,
  };
}
```
