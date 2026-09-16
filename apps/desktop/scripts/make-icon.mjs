#!/usr/bin/env node
/**
 * Generate build/icon.ico (the Windows app + installer icon) from the brand
 * gradient, with no image-processing dependency.
 *
 * WHY THIS EXISTS AT ALL
 * electron-builder falls back to a stock Electron icon when no icon is
 * configured, so a release built without this would ship someone else's logo on
 * the desktop shortcut, the taskbar and in Add/Remove Programs.
 *
 * WHY HAND-ROLLED INSTEAD OF sharp/jimp/png-to-ico
 * The mark is a flat rounded square plus a two-letter monogram: a few hundred
 * lines of pixel math. Adding a native image toolchain (sharp pulls a
 * platform-specific binary) to the install graph of a project that currently
 * has four devDependencies is a worse trade than owning this file, and every
 * new install-time binary is new supply-chain surface.
 *
 * WHY PNG-IN-ICO RATHER THAN CLASSIC BMP/DIB
 * The ICO container accepts either. PNG frames avoid the DIB format's two
 * traps: the doubled biHeight and the mandatory (usually junk) AND mask. Vista
 * and later read PNG frames natively, and electron-builder itself requires
 * Windows 7+, so there is no consumer here that needs the DIB form.
 *
 * COLOURS ARE NOT INVENTED HERE. They are the same two stops as the README
 * wordmark and the app's own .heading-gradient token in
 * apps/desktop/src/renderer/src/styles.css: #ED457D -> #9B49DF. Retune all
 * three together or the product drifts apart visually.
 *
 * Deterministic by construction: no randomness, no clock, no network. Running
 * it twice on the same source produces byte-identical output, so a rebuilt icon
 * never shows up as spurious diff noise.
 */

import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Brand stops, sRGB. Keep in sync with styles.css .heading-gradient.
const PINK = [0xed, 0x45, 0x7d];
const PURPLE = [0x9b, 0x49, 0xdf];

// Windows picks the closest size and downscales; supplying the exact sizes it
// asks for avoids its low-quality shrink. 16/32/48 are the shell sizes, 256 is
// what the installer header and the Store-style large views use.
const SIZES = [16, 32, 48, 64, 128, 256];

/** Linear interpolation between the two brand stops. t is clamped to [0,1]. */
function gradientAt(t) {
  const clamped = t < 0 ? 0 : t > 1 ? 1 : t;
  return [
    Math.round(PINK[0] + (PURPLE[0] - PINK[0]) * clamped),
    Math.round(PINK[1] + (PURPLE[1] - PINK[1]) * clamped),
    Math.round(PINK[2] + (PURPLE[2] - PINK[2]) * clamped),
  ];
}

/**
 * Coverage of a pixel by a rounded rectangle, sampled on a grid.
 *
 * Supersampling rather than an analytic edge: the shape is evaluated once per
 * icon at build time, so the simple, obviously-correct version wins over a
 * faster exact-area routine that is easy to get subtly wrong at the corners.
 */
function roundedRectCoverage(px, py, size, radius, inset, samples) {
  const lo = inset;
  const hi = size - inset;
  let hits = 0;
  for (let sy = 0; sy < samples; sy++) {
    for (let sx = 0; sx < samples; sx++) {
      const x = px + (sx + 0.5) / samples;
      const y = py + (sy + 0.5) / samples;
      if (x < lo || x > hi || y < lo || y > hi) continue;
      // Distance to the nearest corner circle centre; inside the straight
      // edges this is <= 0 on one axis and the test degenerates to the box.
      const dx = Math.max(lo + radius - x, 0, x - (hi - radius));
      const dy = Math.max(lo + radius - y, 0, y - (hi - radius));
      if (dx * dx + dy * dy <= radius * radius) hits++;
    }
  }
  return hits / (samples * samples);
}

/**
 * The monogram, drawn as filled rectangles in a 0..1 unit square.
 *
 * Glyphs are hand-built boxes, not text: an ICO is rasterised with no font
 * engine available, and at 16x16 a real typeface would be an illegible smudge
 * anyway. "M" and "C" read as MCPeasy's initials at every size above.
 */
function monogramShape() {
  const bars = [];
  // Stem weight. 0.088 made the M's two legs each a third of its width, which
  // squeezed the counter to a slot; a capital M wants stems noticeably thinner
  // than the space between them.
  const stroke = 0.062;

  // A capital M is wider than it is tall. The first proportions (0.27 wide vs
  // 0.36 tall) made it a narrow upright block, which is most of why it did not
  // read as an M regardless of how the vertex was drawn.
  const mLeft = 0.15;
  const mRight = 0.5;
  const mTop = 0.33;
  const mBottom = 0.67;

  // ---- M, built as a solid block with a V carved out of it.
  //
  // The first version drew the vertex as two thin diagonal staircases added on
  // top of two verticals. That produced a hairline notch that read as a nick in
  // a rectangle, not as an M. Carving the counter instead means the notch width
  // is what you set, independent of stroke weight, and the diagonal edges are
  // implicitly as thick as the space around them.
  bars.push({ x0: mLeft, y0: mTop, x1: mRight, y1: mBottom });

  // V notch: full width between the two stems at the cap line, tapering to a
  // point at vertexDepth. Stopping above the baseline is what leaves the two
  // legs joined, which is the difference between an M and two separate bars.
  const notch = {
    left: mLeft + stroke,
    right: mRight - stroke,
    top: mTop,
    // The vertex must descend nearly to the baseline. At 0.62 the glyph kept a
    // solid slab under the V and read as a "V" sitting on a block; in a real M
    // the counter runs almost the full height, leaving two distinct legs joined
    // only at the vertex. 0.86 stops just short so the legs stay connected.
    bottom: mTop + (mBottom - mTop) * 0.86,
  };

  // ---- C: an open ring, built as a top bar, bottom bar and left stem so the
  // opening faces right. A true arc would not survive 16x16.
  // Tracked to the M's new right edge, keeping the gap between the two letters
  // close to the stroke weight so they read as a pair, not as two marks.
  const cLeft = 0.58;
  const cRight = 0.85;
  const cTop = 0.33;
  const cBottom = 0.67;
  bars.push({ x0: cLeft, y0: cTop, x1: cLeft + stroke, y1: cBottom });
  bars.push({ x0: cLeft, y0: cTop, x1: cRight, y1: cTop + stroke });
  bars.push({ x0: cLeft, y0: cBottom - stroke, x1: cRight, y1: cBottom });

  return { bars, notch };
}

/** True when (ux, uy) falls inside the M's carved V counter. */
function inNotch(notch, ux, uy) {
  if (uy < notch.top || uy > notch.bottom) return false;
  // Linear taper: full width at the top, zero at the vertex.
  const t = (uy - notch.top) / (notch.bottom - notch.top);
  const centre = (notch.left + notch.right) / 2;
  const halfWidth = ((notch.right - notch.left) / 2) * (1 - t);
  return ux >= centre - halfWidth && ux <= centre + halfWidth;
}

/** Render one square RGBA frame. Returns a raw pixel buffer, 4 bytes/px. */
function renderFrame(size) {
  const rgba = Buffer.alloc(size * size * 4);
  // Corner radius and inset scale with the icon so the silhouette is constant.
  const radius = size * 0.22;
  const inset = Math.max(size * 0.02, 0.5);
  // Small icons need more samples per pixel because each pixel covers more of
  // the curve; large ones are already smooth.
  const samples = size <= 32 ? 6 : 4;
  const { bars, notch } = monogramShape();

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const coverage = roundedRectCoverage(x, y, size, radius, inset, samples);
      if (coverage <= 0) continue;

      // Diagonal sweep: matches the wordmark's left-to-right ramp while
      // staying legible on a square, where a purely horizontal ramp leaves the
      // top and bottom edges flat.
      const [r, g, b] = gradientAt((x / size) * 0.75 + (y / size) * 0.25);

      // Monogram is knocked out in white. Supersampled on the same grid as the
      // silhouette: the V counter has sloped edges, and sampling those at the
      // pixel centre alone produces visible jaggies at 32px and below.
      const ux = (x + 0.5) / size;
      const uy = (y + 0.5) / size;
      let glyphHits = 0;
      for (let sy = 0; sy < samples; sy++) {
        for (let sx = 0; sx < samples; sx++) {
          const gx = (x + (sx + 0.5) / samples) / size;
          const gy = (y + (sy + 0.5) / samples) / size;
          let inside = false;
          for (const bar of bars) {
            if (gx >= bar.x0 && gx <= bar.x1 && gy >= bar.y0 && gy <= bar.y1) {
              inside = true;
              break;
            }
          }
          // The notch is subtractive: it removes ink from the M's block rather
          // than adding any, so it is tested after the bars, not alongside them.
          if (inside && inNotch(notch, gx, gy)) inside = false;
          if (inside) glyphHits++;
        }
      }
      const glyphCoverage = glyphHits / (samples * samples);

      // Blend white over the gradient by glyph coverage. Compositing here, in
      // opaque colour space, rather than via the alpha channel is deliberate:
      // the glyph is a knockout INSIDE an opaque tile, so its edge must soften
      // against the gradient, never against whatever is behind the icon.
      const offset = (y * size + x) * 4;
      rgba[offset] = Math.round(r + (0xff - r) * glyphCoverage);
      rgba[offset + 1] = Math.round(g + (0xff - g) * glyphCoverage);
      rgba[offset + 2] = Math.round(b + (0xff - b) * glyphCoverage);
      rgba[offset + 3] = Math.round(coverage * 255);
    }
  }
  return rgba;
}

/** CRC-32 as specified by PNG (IEEE polynomial, reflected). */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeAndData = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData), 0);
  return Buffer.concat([length, typeAndData, crc]);
}

/** Encode raw RGBA as a PNG (colour type 6, 8-bit, no interlace). */
function encodePng(rgba, size) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  // 10..12 stay 0: deflate, adaptive filtering, no interlace.

  // Filter byte 0 (None) per scanline. The image is a smooth gradient, so Sub
  // or Paeth would compress better — but this file is ~100 KB either way and
  // "None" keeps the encoder trivially verifiable.
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  return Buffer.concat([
    signature,
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(raw, { level: 9 })),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

/** Wrap PNG frames in an ICO container (ICONDIR + ICONDIRENTRY per image). */
function buildIco(frames) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type 1 = icon
  header.writeUInt16LE(frames.length, 4);

  const entries = [];
  // Image data starts after the directory; every entry's offset is absolute.
  let offset = 6 + frames.length * 16;
  for (const frame of frames) {
    const entry = Buffer.alloc(16);
    // 256 is stored as 0 — the field is one byte and 256 does not fit.
    entry[0] = frame.size >= 256 ? 0 : frame.size;
    entry[1] = frame.size >= 256 ? 0 : frame.size;
    entry[2] = 0; // palette colours (0 = truecolour)
    entry[3] = 0; // reserved
    entry.writeUInt16LE(1, 4); // colour planes
    entry.writeUInt16LE(32, 6); // bits per pixel
    entry.writeUInt32LE(frame.png.length, 8);
    entry.writeUInt32LE(offset, 12);
    entries.push(entry);
    offset += frame.png.length;
  }

  return Buffer.concat([header, ...entries, ...frames.map((f) => f.png)]);
}

const here = dirname(fileURLToPath(import.meta.url));
const outputPath = join(here, "..", "build", "icon.ico");

const frames = SIZES.map((size) => ({ size, png: encodePng(renderFrame(size), size) }));
const ico = buildIco(frames);

mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, ico);

console.log(`[mcpeasy] wrote ${outputPath} (${frames.length} frames, ${ico.length} bytes)`);
