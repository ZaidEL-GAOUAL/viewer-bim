import { parseGlb, replaceGlbJson } from './glbFile.ts';

/** Rewrite only JSON metadata, preserving original geometry, images and binary buffers. */
export function updateGlbMetadata(source: ArrayBuffer, properties: ReadonlyMap<string, Record<string, unknown>>, readOnly: readonly string[], options: {
  nodeKeys?: ReadonlyMap<number, string>;
  labels?: ReadonlyMap<string, string>;
} = {}): ArrayBuffer {
  const { json, afterJson } = parseGlb(source);
  const document = json as { nodes?: { name?: string; extras?: Record<string, unknown> }[]; extras?: Record<string, unknown> };
  for (const [index, node] of (document.nodes ?? []).entries()) {
    const id = options.nodeKeys ? options.nodeKeys.get(index) : String(node.extras?.id ?? node.name ?? '');
    if (id === undefined) continue;
    const current = properties.get(id);
    if (current) {
      node.extras = { ...current, id };
      if (options.labels?.has(id)) node.name = options.labels.get(id);
    }
  }
  document.extras = { ...document.extras, readOnly: [...readOnly] };
  return replaceGlbJson(source, afterJson, document);
}
