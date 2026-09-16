import { crc32, deflateRawSync } from "node:zlib";

// Dependency-free ZIP writer for "Export as language" (user decision: export
// lands as one .zip via the save dialog). Node's own zlib provides both
// deflate-raw and crc32 (crc32 landed in Node 22.2; this repo pins >=22.12),
// so pulling in an archiver package would only add supply-chain surface for
// ~100 lines of well-specified format (APPNOTE.TXT 4.4.x structures).

export interface ZipEntry {
  /** Zip-relative path, forward slashes. */
  path: string;
  content: string;
}

const MAX_FILES = 200;
const MAX_TOTAL_BYTES = 8 * 1024 * 1024;

/** Renderer payloads are untrusted: refuse anything that could escape the
 * archive root when extracted (zip-slip) or that is not plain text. */
export function validateZipEntries(raw: unknown): ZipEntry[] | { error: string } {
  if (!Array.isArray(raw)) return { error: "export payload must be a file list" };
  if (raw.length === 0) return { error: "nothing to export" };
  if (raw.length > MAX_FILES) return { error: `too many files (max ${MAX_FILES})` };
  const entries: ZipEntry[] = [];
  const seen = new Set<string>();
  let total = 0;
  for (const item of raw) {
    if (item === null || typeof item !== "object") return { error: "invalid file entry" };
    const { path, content } = item as { path?: unknown; content?: unknown };
    if (typeof path !== "string" || typeof content !== "string") return { error: "invalid file entry" };
    if (path.length === 0 || path.length > 512) return { error: `invalid path length: ${path.slice(0, 64)}` };
    // One rule set, applied strictly: forward slashes, no absolute paths, no
    // "." / ".." segments, no backslashes, no control characters.
    if (
      path.startsWith("/") ||
      path.includes("\\") ||
      /[\u0000-\u001f]/.test(path) ||
      path.split("/").some((seg) => seg === "" || seg === "." || seg === "..")
    ) {
      return { error: `unsafe path in export: ${path}` };
    }
    if (seen.has(path)) return { error: `duplicate path in export: ${path}` };
    seen.add(path);
    total += Buffer.byteLength(content, "utf8");
    if (total > MAX_TOTAL_BYTES) return { error: `export exceeds ${MAX_TOTAL_BYTES} bytes` };
    entries.push({ path, content });
  }
  return entries;
}

function dosDateTime(date: Date): { time: number; date: number } {
  // ZIP stores MS-DOS local date/time: 2-second resolution, epoch 1980.
  const year = Math.max(date.getFullYear(), 1980);
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

/** Build a complete .zip buffer. `now` is injectable so tests are stable. */
export function buildZip(entries: ZipEntry[], now: Date = new Date()): Buffer {
  const { time, date } = dosDateTime(now);
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.path, "utf8");
    const data = Buffer.from(entry.content, "utf8");
    const deflated = deflateRawSync(data);
    // Store uncompressed when deflate does not help (tiny files often grow);
    // readers pick the method per entry, so mixing is fine.
    const useDeflate = deflated.length < data.length;
    const payload = useDeflate ? deflated : data;
    const method = useDeflate ? 8 : 0;
    const crc = crc32(data) >>> 0;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); // local file header signature
    local.writeUInt16LE(20, 4); // version needed: 2.0 (deflate)
    local.writeUInt16LE(0x0800, 6); // flags: bit 11 = UTF-8 names
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28); // extra field length
    localParts.push(local, name, payload);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); // central directory signature
    central.writeUInt16LE(20, 4); // version made by
    central.writeUInt16LE(20, 6); // version needed
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(payload.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    // extra len, comment len, disk number, internal attrs: all zero
    central.writeUInt32LE(0, 38); // external attributes
    central.writeUInt32LE(offset, 42); // local header offset
    centralParts.push(central, name);

    offset += local.length + name.length + payload.length;
  }

  const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); // end of central directory signature
  eocd.writeUInt16LE(entries.length, 8); // entries on this disk
  eocd.writeUInt16LE(entries.length, 10); // entries total
  eocd.writeUInt32LE(centralSize, 12);
  eocd.writeUInt32LE(offset, 16); // central directory offset
  return Buffer.concat([...localParts, ...centralParts, eocd]);
}
