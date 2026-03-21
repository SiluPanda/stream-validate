type Listener<T> = (payload: T) => void

export class TypedEmitter<Events extends Record<string, unknown>> {
  private listeners: Partial<Record<string, Array<Listener<unknown>>>> = {}

  on<K extends keyof Events & string>(event: K, fn: Listener<Events[K]>): () => void {
    if (!this.listeners[event]) this.listeners[event] = []
    this.listeners[event]!.push(fn as Listener<unknown>)
    return () => this.off(event, fn)
  }

  off<K extends keyof Events & string>(event: K, fn: Listener<Events[K]>): void {
    const arr = this.listeners[event]
    if (!arr) return
    const idx = arr.indexOf(fn as Listener<unknown>)
    if (idx !== -1) arr.splice(idx, 1)
  }

  emit<K extends keyof Events & string>(event: K, payload: Events[K]): void {
    const arr = this.listeners[event]
    if (!arr) return
    for (const fn of arr.slice()) {
      fn(payload)
    }
  }
}
