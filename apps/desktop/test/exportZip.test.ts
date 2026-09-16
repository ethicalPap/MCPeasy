import { describe, expect, it } from "vitest";
import { crc32, inflateRawSync } from "node:zlib";
import { buildZip, validateZipEntries } from "../src/main/exportZip";

// The zip writer is verified structurally against APPNOTE.TXT offsets rather
// than by shelling out to an unzip binary: the byte layout IS the contract,
// and this keeps the test deterministic on any machine.

function readEntry(zip: Buffer, offset: number): { path: string; data: Buffer; next: number } {
  expect(zip.readUInt32LE(offset)).toBe(0x04034b50); // local header signature
  const method = zip.readUInt16LE(offset + 8);
  const crc = zip.readUInt32LE(offset + 14);
  const compressedSize = zip.readUInt32LE(offset + 18);
  const nameLength = zip.readUInt16LE(offset + 26);
  const extraLength = zip.readUInt16LE(offset + 28);
  const nameStart = offset + 30;
  const path = zip.subarray(nameStart, nameStart + nameLength).toString("utf8");
  const payloadStart = nameStart + nameLength + extraLength;
  const payload = zip.subarray(payloadStart, payloadStart + compressedSize);
  const data = method === 8 ? inflateRawSync(payload) : Buffer.from(payload);
  expect(crc32(data) >>> 0).toBe(crc);
  return { path, data, next: payloadStart + compressedSize };
}

describe("validateZipEntries", () => {
  it("accepts a normal file list", () => {
    const result = validateZipEntries([{ path: "proj/a.txt", content: "hello" }]);
    expect(result).toEqual([{ path: "proj/a.txt", content: "hello" }]);
  });

  it.each([
    ["absolute", "/etc/passwd"],
    ["parent traversal", "proj/../../x"],
    ["dot segment", "proj/./x"],
    ["backslash", "proj\\x"],
    ["empty segment", "proj//x"],
    ["control char", "proj/\u0001x"],
  ])("rejects %s paths (zip-slip guard)", (_name, path) => {
    const result = validateZipEntries([{ path, content: "x" }]);
    expect(result).toHaveProperty("error");
  });

  it("rejects duplicates, empties, and non-lists", () => {
    expect(validateZipEntries([])).toHaveProperty("error");
    expect(validateZipEntries("nope")).toHaveProperty("error");
    expect(
      validateZipEntries([
        { path: "a", content: "1" },
        { path: "a", content: "2" },
      ]),
    ).toHaveProperty("error");
    expect(validateZipEntries([{ path: "a", content: 5 }])).toHaveProperty("error");
  });
});

describe("buildZip", () => {
  it("produces an archive whose entries round-trip byte-identically", () => {
    // Long repetitive content exercises the deflate path; the short one the
    // stored path (deflate would grow it).
    const entries = [
      { path: "p/server.ts", content: "const x = 1;\n".repeat(200) },
      { path: "p/.gitignore", content: "n\n" },
    ];
    const zip = buildZip(entries, new Date(2026, 0, 2, 3, 4, 6));

    let offset = 0;
    for (const entry of entries) {
      const parsed = readEntry(zip, offset);
      expect(parsed.path).toBe(entry.path);
      expect(parsed.data.toString("utf8")).toBe(entry.content);
      offset = parsed.next;
    }
    // Central directory follows the last payload, EOCD closes the file.
    expect(zip.readUInt32LE(offset)).toBe(0x02014b50);
    expect(zip.readUInt32LE(zip.length - 22)).toBe(0x06054b50);
    expect(zip.readUInt16LE(zip.length - 22 + 10)).toBe(entries.length);
    // EOCD's central-directory offset must point at the first central header.
    expect(zip.readUInt32LE(zip.length - 22 + 16)).toBe(offset);
  });

  it("handles UTF-8 paths and content", () => {
    const zip = buildZip([{ path: "p/héllo.md", content: "grüß ✓" }], new Date(2026, 5, 6));
    const parsed = readEntry(zip, 0);
    expect(parsed.path).toBe("p/héllo.md");
    expect(parsed.data.toString("utf8")).toBe("grüß ✓");
  });
});
