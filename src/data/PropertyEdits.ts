import { type FlatProps, type Metadata, type PropValue, type PropertyStore } from './metadata.ts';

interface Entry { props: FlatProps | undefined; label?: string }
interface Change { before: Map<number, Entry>; after: Map<number, Entry>; path: string; readOnly?: { before: string[]; after: string[] } }
/** Undoable metadata changes. This class has no access to geometry. */
export class PropertyEdits {
  private readonly store: PropertyStore;
  private readonly notify: (path: string) => void;
  private changes: Change[] = [];
  private cursor = 0;
  private saved = 0;
  constructor(store: PropertyStore, notify: (path: string) => void) { this.store = store; this.notify = notify; }
  get changed(): boolean { return this.cursor !== this.saved; }
  get count(): number { return this.cursor; }
  get canUndo(): boolean { return this.cursor > 0; }
  get canRedo(): boolean { return this.cursor < this.changes.length; }
  private entry(i: number): Entry { const props = this.store.propsOf(i); return { props: props ? { ...props } : undefined, label: this.store.labelOf(i) }; }
  private apply(entries: Map<number, Entry>, readOnly?: string[]): void {
    for (const [i, entry] of entries) this.store.set(i, entry.props ? { ...entry.props } : undefined, entry.label);
    if (readOnly) this.store.readOnly = [...readOnly];
    this.store.finalize();
  }
  private record(change: Change): boolean {
    if (!change.after.size && !change.readOnly) return false;
    if (this.saved > this.cursor) this.saved = -1;
    this.changes.splice(this.cursor); this.changes.push(change); this.cursor++;
    this.apply(change.after, change.readOnly?.after); this.notify(change.path); return true;
  }
  set(indices: Iterable<number>, path: string, value: PropValue): boolean { return this.write([...new Set(indices)].map((i) => [i, path, value] as const), false); }
  delete(indices: Iterable<number>, path: string): boolean { return this.write([...new Set(indices)].map((i) => [i, path, null] as const), true); }
  /** One value per element and property (dates of a planning…), undone in a single step. */
  setMany(updates: Iterable<readonly [index: number, path: string, value: PropValue]>): boolean { return this.write(updates, false); }
  private write(updates: Iterable<readonly [number, string, PropValue]>, remove: boolean): boolean {
    const before = new Map<number, Entry>(), after = new Map<number, Entry>(), paths = new Set<string>();
    for (const [i, path, value] of updates) {
      if (!path.trim() || !this.store.isEditable(path) || (typeof value === 'number' && !Number.isFinite(value))) return false;
      if (!Number.isInteger(i) || i < 0 || i >= this.store.count) continue;
      const old = after.get(i) ?? this.entry(i), owns = old.props !== undefined && Object.hasOwn(old.props, path);
      if (remove ? !owns : owns && old.props![path] === value) continue;
      const next = { props: { ...old.props }, label: old.label };
      if (remove) delete next.props[path];
      else Object.defineProperty(next.props, path, { value, enumerable: true, configurable: true, writable: true });
      if (old.label !== undefined && owns && old.label === String(old.props![path])) next.label = remove || value === null || value === '' ? undefined : String(value);
      if (!before.has(i)) before.set(i, old);
      after.set(i, next); paths.add(path);
    }
    return this.record({ before, after, path: paths.size === 1 ? [...paths][0] : '*' });
  }
  import(metadata: Metadata, keys: readonly string[]): boolean {
    const before = new Map<number, Entry>(), after = new Map<number, Entry>();
    for (let i = 0; i < this.store.count; i++) {
      const incoming = metadata.elements.get(keys[i]);
      if (!incoming) continue;
      const old = this.entry(i);
      const next = metadata.propertiesMode === 'replace'
        ? { props: { ...incoming.props }, label: incoming.label }
        : { props: { ...old.props, ...incoming.props }, label: incoming.label ?? old.label };
      if (old.label === next.label && old.props && Object.keys(old.props).length === Object.keys(next.props).length && Object.entries(next.props).every(([key, value]) => Object.hasOwn(old.props!, key) && old.props![key] === value)) continue;
      before.set(i, old);
      after.set(i, next);
    }
    const beforeReadOnly = [...this.store.readOnly];
    const afterReadOnly = [...new Set([...beforeReadOnly, ...(metadata.readOnly ?? [])])];
    const readOnly = afterReadOnly.length !== beforeReadOnly.length ? { before: beforeReadOnly, after: afterReadOnly } : undefined;
    return this.record({ before, after, path: '*', readOnly });
  }
  undo(): void {
    if (!this.canUndo) return;
    const change = this.changes[--this.cursor]; this.apply(change.before, change.readOnly?.before); this.notify(change.path);
  }
  redo(): void {
    if (!this.canRedo) return;
    const change = this.changes[this.cursor++]; this.apply(change.after, change.readOnly?.after); this.notify(change.path);
  }
  revert(): void {
    if (!this.canUndo) return;
    while (this.cursor > 0) { const change = this.changes[--this.cursor]; this.apply(change.before, change.readOnly?.before); }
    this.notify('*');
  }
  markSaved(): void { this.saved = this.cursor; }
}
