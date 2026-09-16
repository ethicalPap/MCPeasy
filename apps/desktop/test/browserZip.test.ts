import { crc32 as nodeCrc32 } from "node:zlib";
import { describe, expect, it } from "vitest";
import { buildZipBytes, crc32 } from "../src/renderer/src/browser/zip";

// The browser zip writer must produce archives any reader accepts. Structural
// assertions mirror exportZip.test.ts; the CRC table is additionally
// cross-checked against node:zlib's independent implementation.

const FIXED = new Date(2024, 5, 15, 12, 30, 20);

describe("browser crc32", () => {
  it("matches node:zlib's crc32 (independent implementation)", () => {
    for (const text of ["", "a", "hello world", "\u00e9\u00e8\u2713 unicode", "x".repeat(10_000)]) {
      const bytes = new TextEncoder().encode(text);
      expect(crc32(bytes)).toBe(nodeCrc32(Buffer.from(bytes)) >>> 0);
    }
  });
});

describe("buildZipBytes", () => {
  it("produces a structurally valid stored zip", () => {
    const entries = [
      { path: "README.md", content: "# hi\n" },
      { path: "src/serv\u00e9r.ts", content: "console.log(1);\n" },
    ];
    const buf = Buffer.from(buildZipBytes(entries, FIXED));

    // Local header signature at offset 0.
    expect(buf.readUInt32LE(0)).toBe(0x04034b50);
    // Method is 0 (stored) — the whole point of the browser writer.
    expect(buf.readUInt16LE(8)).toBe(0);
    // UTF-8 names flag.
    expect(buf.readUInt16LE(6)).toBe(0x0800);
    // First entry: crc + sizes + name round-trip.
    const data0 = Buffer.from(entries[0]!.content, "utf8");
    expect(buf.readUInt32LE(14)).toBe(nodeCrc32(data0) >>> 0);
    expect(buf.readUInt32LE(18)).toBe(data0.length); // compressed == raw
    expect(buf.readUInt32LE(22)).toBe(data0.length);
    const nameLen = buf.readUInt16LE(26);
    expect(buf.subarray(30, 30 + nameLen).toString("utf8")).toBe("README.md");
    expect(buf.subarray(30 + nameLen, 30 + nameLen + data0.length).toString("utf8")).toBe("# hi\n");

    // EOCD closes the file and counts both entries.
    const eocd = buf.length - 22;
    expect(buf.readUInt32LE(eocd)).toBe(0x06054b50);
    expect(buf.readUInt16LE(eocd + 10)).toBe(2);
    // EOCD's central-directory offset points at the first central header.
    const centralOffset = buf.readUInt32LE(eocd + 16);
    expect(buf.readUInt32LE(centralOffset)).toBe(0x02014b50);
    // Central size accounts for exactly the bytes between directory and EOCD.
    expect(centralOffset + buf.readUInt32LE(eocd + 12)).toBe(eocd);
  });

  it("is deterministic for a fixed date", () => {
    const entries = [{ path: "a.txt", content: "same" }];
    expect(Buffer.from(buildZipBytes(entries, FIXED)).equals(Buffer.from(buildZipBytes(entries, FIXED)))).toBe(
      true,
    );
  });
});
