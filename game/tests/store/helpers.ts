// Test helpers for tests/store and tests/net. Owner: O8.
import type { StorageLike } from '../../src/store/save';

/** An in-memory Web Storage stand-in that records writes. */
export class MemStorage implements StorageLike {
  readonly map = new Map<string, string>();
  writes = 0;
  getItem(key: string): string | null {
    return this.map.has(key) ? this.map.get(key)! : null;
  }
  setItem(key: string, value: string): void {
    this.writes++;
    this.map.set(key, String(value));
  }
  removeItem(key: string): void {
    this.map.delete(key);
  }
}

/** A storage whose reads and/or writes throw (private mode, disabled storage, quota exceeded). */
export class ThrowingStorage extends MemStorage {
  constructor(public throwOnGet: boolean, public throwOnSet: boolean) {
    super();
  }
  override getItem(key: string): string | null {
    if (this.throwOnGet) throw new DOMException('denied', 'SecurityError');
    return super.getItem(key);
  }
  override setItem(key: string, value: string): void {
    if (this.throwOnSet) throw new DOMException('full', 'QuotaExceededError');
    super.setItem(key, value);
  }
}
