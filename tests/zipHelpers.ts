import { Readable } from 'node:stream';
import { createInflateRaw, deflateRawSync } from 'node:zlib';
import { crc32, type Inflate } from '../src/data/zip.ts';

const text = (value: string) => new TextEncoder().encode(value);

/** Node's zlib stands in for the browser's DecompressionStream, as a stream too: readZip stops it as soon as it says too much. */
export const nodeInflate: Inflate = (data) => Readable.toWeb(Readable.from([data]).pipe(createInflateRaw())) as ReadableStream<Uint8Array>;

/** A zip whose entries are deflated (method 8), built by hand as other tools write them, with a data descriptor flag. */
export function deflatedZip(files: Record<string, string | Uint8Array>): Blob {
  const parts: Uint8Array<ArrayBuffer>[] = [], central: Uint8Array<ArrayBuffer>[] = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const data = typeof content === 'string' ? text(content) : content;
    const packed = new Uint8Array(deflateRawSync(data));
    const nameBytes = text(name);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint16(6, 0x0808, true);
    local.setUint16(8, 8, true);
    local.setUint16(26, nameBytes.length, true);
    // Sizes and CRC left at zero in the local header (bit 3): only the central directory has them.
    parts.push(new Uint8Array(local.buffer), nameBytes, packed);
    const entry = new DataView(new ArrayBuffer(46));
    entry.setUint32(0, 0x02014b50, true);
    entry.setUint16(6, 20, true);
    entry.setUint16(8, 0x0808, true);
    entry.setUint16(10, 8, true);
    entry.setUint32(16, crc32(data), true);
    entry.setUint32(20, packed.length, true);
    entry.setUint32(24, data.length, true);
    entry.setUint16(28, nameBytes.length, true);
    entry.setUint32(42, offset, true);
    central.push(new Uint8Array(entry.buffer), nameBytes);
    offset += 30 + nameBytes.length + packed.length;
  }
  const size = central.reduce((sum, part) => sum + part.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, Object.keys(files).length, true);
  end.setUint16(10, Object.keys(files).length, true);
  end.setUint32(12, size, true);
  end.setUint32(16, offset, true);
  return new Blob([...parts, ...central, new Uint8Array(end.buffer)]);
}

