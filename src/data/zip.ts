// Archives zip, sans dépendance : écriture sans compression (« stored », ce que le BCF permet et que tous les outils lisent),
// lecture des entrées stockées et compressées (deflate). Noms en UTF-8, CRC-32 vérifié à la lecture. Les entrées se lisent
// une à une, à la demande : une archive pleine de photos n'est jamais en mémoire d'un seul bloc. Pas de zip64 ni de
// chiffrement : une telle archive est refusée avec un message.

const TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

/** CRC-32 (celui du zip), à poursuivre sur un morceau suivant en passant `crc`. */
export function crc32(data: Uint8Array, crc = 0): number {
  let c = ~crc >>> 0;
  for (let i = 0; i < data.length; i++) c = TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return ~c >>> 0;
}

export interface ZipInput {
  name: string;
  data: Uint8Array | Blob;
}

const UTF8_NAMES = 0x0800;
const LIMIT = 0xffffffff;

function dosTime(date: Date): { time: number; day: number } {
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1),
    day: ((Math.max(1980, date.getFullYear()) - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

/** Une archive sans compression. Une entrée `Blob` est lue pour son CRC, puis reprise telle quelle (pas de copie gardée). */
export async function writeZip(entries: Iterable<ZipInput>, date = new Date()): Promise<Blob> {
  const encoder = new TextEncoder();
  const { time, day } = dosTime(date);
  const parts: BlobPart[] = [], central: Uint8Array<ArrayBuffer>[] = [];
  let offset = 0, count = 0;
  for (const entry of entries) {
    const name = encoder.encode(entry.name);
    const bytes = entry.data instanceof Blob ? new Uint8Array(await entry.data.arrayBuffer()) : entry.data;
    const crc = crc32(bytes), size = bytes.length;
    if (size > LIMIT || offset + 30 + name.length + size > LIMIT) throw new Error('Archive trop grande (plus de 4 Go).');
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint16(6, UTF8_NAMES, true);
    local.setUint16(10, time, true);
    local.setUint16(12, day, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, size, true);
    local.setUint32(22, size, true);
    local.setUint16(26, name.length, true);
    parts.push(local.buffer, name, entry.data instanceof Blob ? entry.data : bytes.slice());
    const record = new DataView(new ArrayBuffer(46));
    record.setUint32(0, 0x02014b50, true);
    record.setUint16(4, 20, true);
    record.setUint16(6, 20, true);
    record.setUint16(8, UTF8_NAMES, true);
    record.setUint16(12, time, true);
    record.setUint16(14, day, true);
    record.setUint32(16, crc, true);
    record.setUint32(20, size, true);
    record.setUint32(24, size, true);
    record.setUint16(28, name.length, true);
    record.setUint32(42, offset, true);
    central.push(new Uint8Array(record.buffer), name);
    offset += 30 + name.length + size;
    count++;
  }
  if (count > 0xffff) throw new Error('Archive trop grande (plus de 65 535 fichiers).');
  const size = central.reduce((sum, part) => sum + part.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, count, true);
  end.setUint16(10, count, true);
  end.setUint32(12, size, true);
  end.setUint32(16, offset, true);
  return new Blob([...parts, ...central, end.buffer], { type: 'application/zip' });
}

/** Décompresse un flux deflate brut, en flux : la lecture s'arrête dès que la sortie dépasse ce qu'elle peut être. Injectable : les tests passent celui de Node. */
export type Inflate = (data: Uint8Array) => ReadableStream<Uint8Array>;

/** Celui du navigateur (`DecompressionStream`), hors du fil principal. */
export const inflateRaw: Inflate = (data) => new Blob([data.slice()]).stream().pipeThrough(new DecompressionStream('deflate-raw'));

export interface ZipEntry {
  name: string;
  /** Taille décompressée, en octets. */
  size: number;
  /** Le contenu, lu et vérifié (CRC) à l'appel. */
  bytes(): Promise<Uint8Array>;
}

/** Taille annoncée au plus d'une entrée, entrées au plus, et octets décompressés au plus par archive (toutes lectures comprises). */
export const MAX_ENTRY = 512e6;
export const MAX_ENTRIES = 20_000;
export const MAX_TOTAL = 1e9;

/** Lit un flux jusqu'au bout, ou lève dès qu'il dépasse `max` octets : une bombe de décompression n'est jamais déroulée. */
async function readAtMost(stream: ReadableStream<Uint8Array>, max: number, name: string): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  for (let next = await reader.read(); !next.done; next = await reader.read()) {
    length += next.value.length;
    if (length > max) {
      void reader.cancel().catch(() => {});
      throw new Error(`« ${name} » est abîmé (plus grand qu’annoncé).`);
    }
    chunks.push(next.value);
  }
  const out = new Uint8Array(length);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}

/** Le répertoire de l'archive ; le contenu de chaque entrée se lit à la demande. Les dossiers sont ignorés. */
export async function readZip(file: Blob, inflate: Inflate = inflateRaw): Promise<Map<string, ZipEntry>> {
  const tailSize = Math.min(file.size, 22 + 0xffff);
  const tail = new DataView(await file.slice(file.size - tailSize).arrayBuffer());
  let at = -1;
  for (let i = tailSize - 22; i >= 0; i--) if (tail.getUint32(i, true) === 0x06054b50) { at = i; break; }
  if (at < 0) throw new Error('Ce fichier n’est pas une archive zip.');
  const count = tail.getUint16(at + 10, true), size = tail.getUint32(at + 12, true), start = tail.getUint32(at + 16, true);
  if (count === 0xffff || start === LIMIT) throw new Error('Archive zip64 non prise en charge.');
  if (count > MAX_ENTRIES) throw new Error(`Archive trop grande (plus de ${MAX_ENTRIES.toLocaleString('fr-FR')} fichiers).`);
  const directory = new DataView(await file.slice(start, start + size).arrayBuffer());
  const decoder = new TextDecoder();
  const entries = new Map<string, ZipEntry>();
  let inflated = 0;
  let p = 0;
  for (let n = 0; n < count; n++) {
    if (p + 46 > directory.byteLength || directory.getUint32(p, true) !== 0x02014b50) throw new Error('Archive zip abîmée (répertoire illisible).');
    const flags = directory.getUint16(p + 8, true), method = directory.getUint16(p + 10, true), crc = directory.getUint32(p + 16, true);
    const packed = directory.getUint32(p + 20, true), length = directory.getUint32(p + 24, true);
    const nameLength = directory.getUint16(p + 28, true), extra = directory.getUint16(p + 30, true), comment = directory.getUint16(p + 32, true);
    const local = directory.getUint32(p + 42, true);
    const name = decoder.decode(new Uint8Array(directory.buffer, p + 46, nameLength)).replace(/\\/g, '/');
    p += 46 + nameLength + extra + comment;
    if (name.endsWith('/')) continue;
    entries.set(name, {
      name, size: length,
      async bytes() {
        if (flags & 1) throw new Error(`« ${name} » est chiffré : non pris en charge.`);
        if (method !== 0 && method !== 8) throw new Error(`« ${name} » : compression ${method} non prise en charge.`);
        if (length > MAX_ENTRY) throw new Error(`« ${name} » est trop grand (${Math.round(length / 1e6)} Mo).`);
        // Chaque lecture réserve sa taille annoncée, que la décompression ne peut pas dépasser.
        if (inflated + length > MAX_TOTAL) throw new Error(`Archive trop grande une fois décompressée (plus de ${MAX_TOTAL / 1e6} Mo).`);
        inflated += length;
        const header = new DataView(await file.slice(local, local + 30).arrayBuffer());
        if (header.byteLength < 30 || header.getUint32(0, true) !== 0x04034b50) throw new Error(`« ${name} » est abîmé (en-tête illisible).`);
        const from = local + 30 + header.getUint16(26, true) + header.getUint16(28, true);
        const raw = new Uint8Array(await file.slice(from, from + packed).arrayBuffer());
        const data = method === 0 ? raw : await readAtMost(inflate(raw), length, name);
        if (data.length !== length || crc32(data) !== crc) throw new Error(`« ${name} » est abîmé (somme de contrôle).`);
        return data;
      },
    });
  }
  return entries;
}
