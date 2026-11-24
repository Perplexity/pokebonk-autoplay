import { inflateSync } from 'node:zlib';

/**
 * Minimal image readers for the headless sim. No native modules.
 *
 * - `imageSize` reads the pixel size from the header of a PNG, JPEG, WebP or GIF: the game slices sprite sheets by
 *   the image's natural size, so the fake `Image` must report the real one.
 * - `decodePng` turns a PNG into RGBA bytes. This is NOT cosmetic: the game measures each sprite's opaque bounding box
 *   with `getImageData` and derives the enemy's collision radius and height from it, so the 2D canvas shim has to hand
 *   back real pixels for sprites.
 */

export interface Size { width: number; height: number }
export interface Pixels extends Size { data: Uint8ClampedArray }

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
export const isPng = (b: Uint8Array) => b.length > 24 && PNG_SIG.every((v, i) => b[i] === v);

export function imageSize(b: Uint8Array): Size | null {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  if (isPng(b)) return { width: dv.getUint32(16), height: dv.getUint32(20) };
  if (b[0] === 0xff && b[1] === 0xd8) { // JPEG: walk the segments to the start-of-frame marker
    let o = 2;
    while (o + 9 < b.length) {
      if (b[o] !== 0xff) { o++; continue; }
      const m = b[o + 1];
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { height: dv.getUint16(o + 5), width: dv.getUint16(o + 7) };
      if (m === 0xd8 || (m >= 0xd0 && m <= 0xd7) || m === 0x01) { o += 2; continue; }
      o += 2 + dv.getUint16(o + 2);
    }
    return null;
  }
  if (b.length > 30 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45) { // RIFF....WEBP
    const fmt = String.fromCharCode(b[12], b[13], b[14], b[15]);
    if (fmt === 'VP8 ') return { width: dv.getUint16(26, true) & 0x3fff, height: dv.getUint16(28, true) & 0x3fff };
    if (fmt === 'VP8L') { const v = dv.getUint32(21, true); return { width: (v & 0x3fff) + 1, height: ((v >> 14) & 0x3fff) + 1 }; }
    if (fmt === 'VP8X') return { width: 1 + (b[24] | (b[25] << 8) | (b[26] << 16)), height: 1 + (b[27] | (b[28] << 8) | (b[29] << 16)) };
    return null;
  }
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return { width: dv.getUint16(6, true), height: dv.getUint16(8, true) };
  return null;
}

/** Decode a non-interlaced PNG (any colour type, 1–16 bit) to 8-bit RGBA. Throws on anything else. */
export function decodePng(b: Uint8Array): Pixels {
  if (!isPng(b)) throw new Error('not a PNG');
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let o = 8, width = 0, height = 0, depth = 0, ctype = 0, interlace = 0;
  let palette: Uint8Array | null = null, trns: Uint8Array | null = null;
  const idat: Uint8Array[] = [];
  while (o + 8 <= b.length) {
    const len = dv.getUint32(o), type = String.fromCharCode(b[o + 4], b[o + 5], b[o + 6], b[o + 7]);
    const body = b.subarray(o + 8, o + 8 + len);
    if (type === 'IHDR') { width = dv.getUint32(o + 8); height = dv.getUint32(o + 12); depth = b[o + 16]; ctype = b[o + 17]; interlace = b[o + 20]; }
    else if (type === 'PLTE') palette = body;
    else if (type === 'tRNS') trns = body;
    else if (type === 'IDAT') idat.push(body);
    else if (type === 'IEND') break;
    o += 12 + len;
  }
  if (interlace) throw new Error('interlaced PNG is not supported by the sim decoder');
  const channels = ctype === 0 ? 1 : ctype === 2 ? 3 : ctype === 3 ? 1 : ctype === 4 ? 2 : 4;
  const bpp = Math.max(1, (channels * depth) >> 3); // bytes per pixel for the filters
  const stride = (width * channels * depth + 7) >> 3;
  const raw = inflateSync(Buffer.concat(idat));
  if (raw.length < (stride + 1) * height) throw new Error('truncated PNG data');
  const cur = new Uint8Array(stride), prev = new Uint8Array(stride);
  const out = new Uint8ClampedArray(width * height * 4);
  const sample16 = depth === 16;
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)], line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? cur[x - bpp] : 0, up = prev[x], c = x >= bpp ? prev[x - bpp] : 0;
      let v = line[x];
      if (f === 1) v += a;
      else if (f === 2) v += up;
      else if (f === 3) v += (a + up) >> 1;
      else if (f === 4) { const p = a + up - c, pa = Math.abs(p - a), pb = Math.abs(p - up), pc = Math.abs(p - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? up : c; }
      cur[x] = v & 255;
    }
    // One sample of the row, scaled to 8 bits (raw index for palette images).
    const at = (i: number): number => {
      if (depth === 8) return cur[i];
      if (sample16) return cur[i * 2];
      const bit = i * depth, v = (cur[bit >> 3] >> (8 - depth - (bit & 7))) & ((1 << depth) - 1);
      return ctype === 3 ? v : Math.round((v * 255) / ((1 << depth) - 1));
    };
    for (let x = 0; x < width; x++) {
      const q = (y * width + x) * 4;
      if (ctype === 6) { out[q] = at(x * 4); out[q + 1] = at(x * 4 + 1); out[q + 2] = at(x * 4 + 2); out[q + 3] = at(x * 4 + 3); }
      else if (ctype === 2) {
        const r = at(x * 3), g = at(x * 3 + 1), bl = at(x * 3 + 2);
        out[q] = r; out[q + 1] = g; out[q + 2] = bl;
        out[q + 3] = trns && depth === 8 && trns.length >= 6 && r === trns[1] && g === trns[3] && bl === trns[5] ? 0 : 255;
      } else if (ctype === 3) {
        const i = at(x);
        out[q] = palette ? palette[i * 3] : 0; out[q + 1] = palette ? palette[i * 3 + 1] : 0; out[q + 2] = palette ? palette[i * 3 + 2] : 0;
        out[q + 3] = trns && i < trns.length ? trns[i] : 255;
      } else if (ctype === 4) { const g = at(x * 2); out[q] = out[q + 1] = out[q + 2] = g; out[q + 3] = at(x * 2 + 1); }
      else { const g = at(x); out[q] = out[q + 1] = out[q + 2] = g; out[q + 3] = 255; }
    }
    prev.set(cur);
  }
  return { width, height, data: out };
}
