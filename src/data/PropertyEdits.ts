import { SUPPORTED_VERSION, ownValue, unflattenProperties, type FlatProps, type Metadata, type PropValue, type PropertyStore } from './metadata.ts';

interface Entry { props: FlatProps | undefined; label?: string }
interface Change { before: Map<number, Entry>; after: Map<number, Entry>; path: string; readOnly?: { before: string[]; after: string[] } }
const define = (props: FlatProps, path: string, value: PropValue) => Object.defineProperty(props, path, { value, enumerable: true, configurable: true, writable: true });
/** Undoable metadata changes. This class has no access to geometry. */
export class PropertyEdits {
  private readonly store: PropertyStore;
  private readonly notify: (path: string) => void;
  private changes: Change[] = [];
  private cursor = 0;
  private saved = 0;
  /** Each touched element as the file gave it, before its first change: what `diff`, `isModified` and `revert` compare to. */
  private readonly baseline = new Map<number, Entry>();
  private counted: number | null = null;
  constructor(store: PropertyStore, notify: (path: string) => void) { this.store = store; this.notify = notify; }
  get changed(): boolean { return this.cursor !== this.saved; }
  /** Undo steps. */
  get count(): number { return this.cursor; }
  get canUndo(): boolean { return this.cursor > 0; }
  get canRedo(): boolean { return this.cursor < this.changes.length; }
  private entry(i: number): Entry { const props = this.store.propsOf(i); return { props: props ? { ...props } : undefined, label: this.store.labelOf(i) }; }
  private apply(entries: Map<number, Entry>, readOnly?: string[]): void {
    for (const [i, entry] of entries) this.store.set(i, entry.props ? { ...entry.props } : undefined, entry.label);
    if (readOnly) this.store.readOnly = [...readOnly];
    this.store.finalize();
    this.counted = null;
  }
  private record(change: Change): boolean {
    if (!change.after.size && !change.readOnly) return false;
    if (this.saved > this.cursor) this.saved = -1;
    for (const [i, entry] of change.before) if (!this.baseline.has(i)) this.baseline.set(i, entry);
    this.changes.splice(this.cursor); this.changes.push(change); this.cursor++;
    this.apply(change.after, change.readOnly?.after); this.notify(change.path); return true;
  }
  set(indices: Iterable<number>, path: string, value: PropValue): boolean { return this.write([...new Set(indices)].map((i) => [i, path, value] as const)); }
  delete(indices: Iterable<number>, path: string): boolean { return this.write([...new Set(indices)].map((i) => [i, path, undefined] as const)); }
  /** One value per element and property (dates of a planning…), undone in a single step. */
  setMany(updates: Iterable<readonly [index: number, path: string, value: PropValue]>): boolean { return this.write(updates); }
  /** Back to the file's value of `path` for these elements (removed if the file had none), in one undo step. */
  revert(indices: Iterable<number>, path: string): boolean {
    return this.write([...new Set(indices)].flatMap((i) => this.isModified(i, path) ? [[i, path, ownValue(this.baseline.get(i)!.props, path)] as const] : []));
  }
  /** `undefined` removes the property. */
  private write(updates: Iterable<readonly [number, string, PropValue | undefined]>): boolean {
    const before = new Map<number, Entry>(), after = new Map<number, Entry>(), paths = new Set<string>();
    for (const [i, path, value] of updates) {
      if (!path.trim() || !this.store.isEditable(path) || (typeof value === 'number' && !Number.isFinite(value))) return false;
      if (!Number.isInteger(i) || i < 0 || i >= this.store.count) continue;
      const remove = value === undefined;
      const old = after.get(i) ?? this.entry(i), owns = old.props !== undefined && Object.hasOwn(old.props, path);
      if (remove ? !owns : owns && old.props![path] === value) continue;
      const next = { props: { ...old.props }, label: old.label };
      if (remove) delete next.props[path];
      else define(next.props, path, value);
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
        : { props: this.complete(old.props, incoming.props), label: incoming.label ?? old.label };
      if (old.label === next.label && Object.keys(old.props ?? {}).length === Object.keys(next.props).length && Object.entries(next.props).every(([key, value]) => Object.hasOwn(old.props!, key) && old.props![key] === value)) continue;
      before.set(i, old);
      after.set(i, next);
    }
    const beforeReadOnly = [...this.store.readOnly];
    const afterReadOnly = [...new Set([...beforeReadOnly, ...(metadata.readOnly ?? [])])];
    const readOnly = afterReadOnly.length !== beforeReadOnly.length ? { before: beforeReadOnly, after: afterReadOnly } : undefined;
    return this.record({ before, after, path: '*', readOnly });
  }
  /** A merge-mode JSON on an element: `null` removes, and a value the file locked stays the file's (it is fresh, the JSON may not be). */
  private complete(props: FlatProps | undefined, incoming: FlatProps): FlatProps {
    const out: FlatProps = { ...props };
    for (const [path, value] of Object.entries(incoming)) {
      if (props && Object.hasOwn(props, path) && !this.store.isEditable(path)) continue;
      if (value === null) delete out[path];
      else define(out, path, value);
    }
    return out;
  }
  undo(): void {
    if (!this.canUndo) return;
    const change = this.changes[--this.cursor]; this.apply(change.before, change.readOnly?.before); this.notify(change.path);
  }
  redo(): void {
    if (!this.canRedo) return;
    const change = this.changes[this.cursor++]; this.apply(change.after, change.readOnly?.after); this.notify(change.path);
  }
  /** Undoes every step: back to the file. */
  revertAll(): void {
    if (!this.canUndo) return;
    while (this.cursor > 0) { const change = this.changes[--this.cursor]; this.apply(change.before, change.readOnly?.before); }
    this.notify('*');
  }
  markSaved(): void { this.saved = this.cursor; }

  /** True if the element's value of `path` differs from the file's. Locked properties are the file's: never modified. */
  isModified(index: number, path: string): boolean {
    const base = this.baseline.get(index);
    return base !== undefined && this.store.isEditable(path) && ownValue(base.props, path) !== ownValue(this.store.propsOf(index), path);
  }
  /** Elements whose properties or name differ from the file. */
  get modifiedCount(): number {
    if (this.counted === null) {
      this.counted = 0;
      for (const [i, base] of this.baseline) if (this.differences(i) || base.label !== this.store.labelOf(i)) this.counted++;
    }
    return this.counted;
  }
  /** The element's editable properties that differ from the file, at their current value (`null`: removed); null if none. */
  private differences(i: number): FlatProps | null {
    const base = this.baseline.get(i)?.props ?? {}, now = this.store.propsOf(i) ?? {};
    let out: FlatProps | null = null;
    for (const path of new Set([...Object.keys(base), ...Object.keys(now)])) {
      if (this.isModified(i, path)) define(out ??= {}, path, ownValue(now, path) ?? null);
    }
    return out;
  }
  /**
   * What differs from the file, in the merge mode of the contract (`null`: removed): the "Modifications" JSON. Each element
   * also carries the locked properties it has, which identify it in its source file (« Identifiant Revit »…). `diff` reads
   * the touched elements only.
   */
  diff(keys: readonly string[]): { version: number; elements: Record<string, unknown> } {
    const elements: Record<string, unknown> = {};
    for (const [i, base] of this.baseline) {
      const changed = this.differences(i), label = this.store.labelOf(i);
      if (!changed && base.label === label) continue;
      const now = this.store.propsOf(i), props: FlatProps = {};
      for (const pattern of this.store.readOnly) { const value = ownValue(now, pattern); if (value !== undefined) define(props, pattern, value); }
      for (const [path, value] of Object.entries(changed ?? {})) define(props, path, value);
      const entry: Record<string, unknown> = {};
      if (label !== undefined && label !== base.label) entry.label = label;
      entry.properties = unflattenProperties(props);
      Object.defineProperty(elements, keys[i], { value: entry, enumerable: true, configurable: true, writable: true });
    }
    return { version: SUPPORTED_VERSION, elements };
  }
}
