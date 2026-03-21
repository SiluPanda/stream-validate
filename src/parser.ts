export interface ParsedField {
  path: string      // e.g. "name", "address.city", "items[0]"
  value: unknown    // fully parsed value
  position: number  // end position in original stream
}

/**
 * Incremental JSON parser that emits ParsedField events as object fields complete.
 * Uses a buffering + scanning approach: buffer incoming chunks, scan for complete
 * JSON values using balanced delimiter counting.
 */
export class IncrementalJsonParser {
  private buf = ''
  private streamPos = 0   // cumulative position in overall stream
  private scanPos = 0     // where in buf we've already scanned

  feed(chunk: string): ParsedField[] {
    this.buf += chunk
    this.streamPos += chunk.length
    return this.scan()
  }

  end(): ParsedField[] {
    // Flush: attempt to parse whatever remains as a complete object
    const remaining = this.buf.slice(this.scanPos).trim()
    if (!remaining) return []
    try {
      const val = JSON.parse(remaining)
      if (val !== null && typeof val === 'object' && !Array.isArray(val)) {
        return this.extractFields(val as Record<string, unknown>, '', this.streamPos)
      }
    } catch {
      // incomplete/malformed — nothing more to emit
    }
    return []
  }

  private insideObject = false

  private scan(): ParsedField[] {
    const fields: ParsedField[] = []

    // Find the opening '{' if we haven't entered the object yet
    if (!this.insideObject) {
      const openIdx = this.buf.indexOf('{')
      if (openIdx === -1) return fields
      this.insideObject = true
      this.scanPos = openIdx + 1
    }

    // Continue scanning for key-value pairs from scanPos
    let pos = this.scanPos

    while (pos < this.buf.length) {
      // Skip whitespace
      pos = this.skipWhitespace(this.buf, pos)
      if (pos >= this.buf.length) break

      const ch = this.buf[pos]

      // End of object
      if (ch === '}') {
        this.scanPos = pos + 1
        break
      }

      // Skip commas between fields
      if (ch === ',') {
        pos++
        continue
      }

      // Expect a key (string)
      if (ch !== '"') {
        pos++
        continue
      }

      // Parse the key
      const keyResult = this.parseString(this.buf, pos)
      if (keyResult === null) break  // incomplete key, wait for more data
      const { value: key, endPos: afterKey } = keyResult

      // Skip whitespace and colon
      let p = this.skipWhitespace(this.buf, afterKey)
      if (p >= this.buf.length) break
      if (this.buf[p] !== ':') { pos = p + 1; continue }
      p++

      // Skip whitespace before value
      p = this.skipWhitespace(this.buf, p)
      if (p >= this.buf.length) break

      // Parse the value
      const valResult = this.parseValue(this.buf, p)
      if (valResult === null) break  // incomplete value, wait for more data

      const { value, endPos: afterVal } = valResult
      const absPos = this.streamPos - this.buf.length + afterVal

      // Emit leaf fields for this value
      const subFields = this.extractFields(
        { [key as string]: value },
        '',
        absPos
      )
      fields.push(...subFields)

      this.scanPos = afterVal
      pos = afterVal
    }

    return fields
  }

  private skipWhitespace(s: string, pos: number): number {
    while (pos < s.length && /\s/.test(s[pos])) pos++
    return pos
  }

  /**
   * Parse a JSON string starting at pos (which must be `"`).
   * Returns { value, endPos } where endPos is one past the closing `"`, or null if incomplete.
   */
  private parseString(s: string, pos: number): { value: string; endPos: number } | null {
    if (s[pos] !== '"') return null
    let i = pos + 1
    while (i < s.length) {
      if (s[i] === '\\') {
        i += 2  // skip escaped character
        continue
      }
      if (s[i] === '"') {
        const raw = s.slice(pos, i + 1)
        try {
          return { value: JSON.parse(raw) as string, endPos: i + 1 }
        } catch {
          return null
        }
      }
      i++
    }
    return null  // incomplete
  }

  /**
   * Parse any JSON value starting at pos.
   * Returns { value, endPos } or null if incomplete.
   */
  private parseValue(s: string, pos: number): { value: unknown; endPos: number } | null {
    if (pos >= s.length) return null
    const ch = s[pos]

    if (ch === '"') {
      return this.parseString(s, pos)
    }

    if (ch === '{' || ch === '[') {
      return this.parseBalanced(s, pos)
    }

    // null, true, false
    const literals: Array<[string, unknown]> = [
      ['null', null],
      ['true', true],
      ['false', false],
    ]
    for (const [lit, val] of literals) {
      if (s.startsWith(lit, pos)) {
        return { value: val, endPos: pos + lit.length }
      }
    }

    // Number: ends at `,`, `}`, `]`, whitespace
    const numMatch = s.slice(pos).match(/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/)
    if (numMatch) {
      const numStr = numMatch[0]
      // Make sure the number is actually complete (followed by delimiter or end of known token)
      const afterNum = pos + numStr.length
      if (afterNum >= s.length) {
        // Could be incomplete (e.g. "1" might become "123") — only safe if followed by delimiter
        // Check if next non-whitespace is a delimiter
        const next = this.skipWhitespace(s, afterNum)
        if (next >= s.length) return null  // wait for more
        const nextCh = s[next]
        if (nextCh === ',' || nextCh === '}' || nextCh === ']') {
          return { value: JSON.parse(numStr), endPos: afterNum }
        }
        return null
      }
      return { value: JSON.parse(numStr), endPos: afterNum }
    }

    return null
  }

  /**
   * Parse a balanced `{...}` or `[...]` block.
   */
  private parseBalanced(s: string, pos: number): { value: unknown; endPos: number } | null {
    const open = s[pos]
    const close = open === '{' ? '}' : ']'
    let depth = 0
    let i = pos
    let inString = false

    while (i < s.length) {
      const ch = s[i]
      if (inString) {
        if (ch === '\\') { i += 2; continue }
        if (ch === '"') inString = false
      } else {
        if (ch === '"') inString = true
        else if (ch === open) depth++
        else if (ch === close) {
          depth--
          if (depth === 0) {
            const raw = s.slice(pos, i + 1)
            try {
              return { value: JSON.parse(raw), endPos: i + 1 }
            } catch {
              return null
            }
          }
        }
      }
      i++
    }
    return null  // incomplete
  }

  /**
   * Recursively extract leaf fields from a (possibly nested) object/value,
   * emitting one ParsedField per leaf.
   */
  private extractFields(
    obj: Record<string, unknown> | unknown,
    prefix: string,
    absPos: number
  ): ParsedField[] {
    const fields: ParsedField[] = []

    if (obj !== null && typeof obj === 'object' && !Array.isArray(obj)) {
      for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
        const path = prefix ? `${prefix}.${k}` : k
        if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
          fields.push(...this.extractFields(v, path, absPos))
        } else if (Array.isArray(v)) {
          // Emit the array as a single field (with path), plus individual items
          fields.push({ path, value: v, position: absPos })
          for (let idx = 0; idx < v.length; idx++) {
            fields.push(...this.extractFields(v[idx], `${path}[${idx}]`, absPos))
          }
        } else {
          fields.push({ path, value: v, position: absPos })
        }
      }
    } else if (Array.isArray(obj)) {
      for (let idx = 0; idx < (obj as unknown[]).length; idx++) {
        fields.push(...this.extractFields((obj as unknown[])[idx], `${prefix}[${idx}]`, absPos))
      }
    } else {
      if (prefix) {
        fields.push({ path: prefix, value: obj, position: absPos })
      }
    }

    return fields
  }
}
