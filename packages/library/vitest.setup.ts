// Node 25+ defines an experimental `globalThis.localStorage` getter that returns
// `undefined` without `--localstorage-file`, shadowing jsdom's `window.localStorage`
// in Vitest v2 worker realms. Install an in-memory Web Storage when needed.
if (typeof window !== 'undefined') {
  let ok = false;
  try {
    ok = typeof globalThis.localStorage?.getItem === 'function';
  } catch {
    ok = false;
  }
  if (!ok) {
    const store = new Map<string, string>();
    const memoryStorage: Storage = {
      get length() {
        return store.size;
      },
      clear() {
        store.clear();
      },
      getItem(key: string) {
        return store.has(String(key)) ? store.get(String(key))! : null;
      },
      key(index: number) {
        return [...store.keys()][index] ?? null;
      },
      removeItem(key: string) {
        store.delete(String(key));
      },
      setItem(key: string, value: string) {
        store.set(String(key), String(value));
      },
    };
    Object.defineProperty(globalThis, 'localStorage', {
      value: memoryStorage,
      configurable: true,
      writable: true,
    });
    Object.defineProperty(window, 'localStorage', {
      value: memoryStorage,
      configurable: true,
      writable: true,
    });
  }
}
