class MemoryStorage implements Storage {
  private store = new Map<string, string>();

  get length(): number {
    return this.store.size;
  }

  clear(): void {
    this.store.clear();
  }

  getItem(key: string): string | null {
    return this.store.has(key) ? this.store.get(key)! : null;
  }

  key(index: number): string | null {
    return Array.from(this.store.keys())[index] ?? null;
  }

  removeItem(key: string): void {
    this.store.delete(key);
  }

  setItem(key: string, value: string): void {
    this.store.set(key, String(value));
  }
}

const local = new MemoryStorage();
const session = new MemoryStorage();

if (typeof window !== 'undefined') {
  Object.defineProperty(window, 'localStorage', {
    value: local,
    configurable: true,
    writable: true,
  });
  Object.defineProperty(window, 'sessionStorage', {
    value: session,
    configurable: true,
    writable: true,
  });
}

Object.defineProperty(globalThis, 'localStorage', {
  value: local,
  configurable: true,
  writable: true,
});
Object.defineProperty(globalThis, 'sessionStorage', {
  value: session,
  configurable: true,
  writable: true,
});
