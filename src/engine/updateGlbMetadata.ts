/** Rewrite only JSON metadata, preserving original geometry, images and binary buffers. */
export function updateGlbMetadata(source: ArrayBuffer, properties: ReadonlyMap<string, Record<string, unknown>>, readOnly: readonly string[], options: {
  nodeKeys?: ReadonlyMap<number, string>;
  labels?: ReadonlyMap<string, string>;
} = {}): ArrayBuffer {
  const header = new DataView(source);
  if (source.byteLength < 20 || header.getUint32(0, true) !== 0x46546c67 || header.getUint32(4, true) !== 2 || header.getUint32(16, true) !== 0x4e4f534a) throw new Error('Fichier GLB invalide.');
  const jsonLength = header.getUint32(12, true), binaryStart = 20 + jsonLength;
  if (binaryStart > source.byteLength) throw new Error('Fichier GLB incomplet.');
  const document = JSON.parse(new TextDecoder().decode(new Uint8Array(source, 20, jsonLength))) as { nodes?: { name?: string; extras?: Record<string, unknown> }[]; extras?: Record<string, unknown> };
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
  const encoded = new TextEncoder().encode(JSON.stringify(document)), aligned = (encoded.byteLength + 3) & ~3;
  const out = new ArrayBuffer(20 + aligned + source.byteLength - binaryStart), view = new DataView(out), bytes = new Uint8Array(out);
  bytes.set(new Uint8Array(source, 0, 12)); view.setUint32(8, out.byteLength, true); view.setUint32(12, aligned, true); view.setUint32(16, 0x4e4f534a, true);
  bytes.set(encoded, 20); bytes.fill(32, 20 + encoded.byteLength, 20 + aligned); bytes.set(new Uint8Array(source, binaryStart), 20 + aligned);
  return out;
}
