import type { Pixels } from './png.ts';

/**
 * Headless 2D canvas context. Replaces `CanvasRenderingContext2D`.
 *
 * Almost everything is a no-op (paths, text, gradients, fills: all presentation). Three things are real, because the
 * game reads pixels back and uses them for gameplay numbers (sprite bounding box → enemy collision radius/height):
 *
 *   - `drawImage` copies pixels from a decoded image or another canvas (nearest neighbour, source-over ignored: copy);
 *   - `getImageData` / `putImageData` / `clearRect` work on that RGBA buffer;
 *   - the buffer is created lazily and reset when the canvas is resized, as in a browser;
 *   - a canvas that is part of the document (the HUD minimap and the like) is a display surface: drawing into it is
 *     skipped altogether. Only detached canvases, the ones code uses as scratch buffers, keep pixels.
 *
 * A canvas that was only painted with vector calls or with an image we cannot decode reads back as transparent
 * black; `stats` counts those so the report can say whether it ever happened where it matters.
 */

export const canvasStats = {
  contexts: 0,
  drawImage: 0,
  drawImageNoPixels: 0,   // drawImage whose source had no decodable pixels (JPEG/WebP/broken image)
  drawImageScaled: 0,     // drawImage with resampling (nearest neighbour here, smoothed in a browser)
  drawImageDisplay: 0,    // drawImage into a canvas that is in the document: skipped
  getImageData: 0,
  getImageDataBlank: 0,   // read back from a canvas nothing real was drawn into
  blankReads: [] as string[],
};

/** Anything that can be the source of drawImage in the sim exposes its pixels through this symbol. */
export const PIXELS = Symbol.for('pb.sim.pixels');

function sourcePixels(src: any): Pixels | null {
  if (!src) return null;
  try { const f = src[PIXELS]; return typeof f === 'function' ? f.call(src) : null; } catch { return null; }
}

class Gradient { addColorStop() { /* presentation only */ } }

export class NullContext2D {
  canvas: any;
  private buf: Uint8ClampedArray | null = null;
  private bw = 0;
  private bh = 0;
  private painted = false;

  // State properties the game assigns; values are kept so reads return what was written.
  fillStyle: unknown = '#000'; strokeStyle: unknown = '#000'; font = '10px sans-serif'; globalAlpha = 1;
  globalCompositeOperation = 'source-over'; lineWidth = 1; lineCap = 'butt'; lineJoin = 'miter'; miterLimit = 10;
  textAlign = 'start'; textBaseline = 'alphabetic'; shadowBlur = 0; shadowColor = 'rgba(0,0,0,0)'; shadowOffsetX = 0;
  shadowOffsetY = 0; imageSmoothingEnabled = true; imageSmoothingQuality = 'low'; filter = 'none'; lineDashOffset = 0;
  direction = 'ltr'; letterSpacing = '0px';

  constructor(canvas: any) { this.canvas = canvas; canvasStats.contexts++; }

  /** The backing store, sized like the canvas right now (a resize clears it, as in a browser). */
  private pixels(create: boolean): Uint8ClampedArray | null {
    const w = Math.max(0, this.canvas.width | 0), h = Math.max(0, this.canvas.height | 0);
    if (this.buf && (w !== this.bw || h !== this.bh)) { this.buf = null; this.painted = false; }
    if (!this.buf && create && w > 0 && h > 0) {
      if (w * h > 64_000_000) return null;
      this.buf = new Uint8ClampedArray(w * h * 4); this.bw = w; this.bh = h;
    }
    return this.buf;
  }

  [PIXELS](): Pixels | null {
    const data = this.pixels(false);
    return data && this.painted ? { width: this.bw, height: this.bh, data } : null;
  }

  drawImage(src: any, ...a: number[]): void {
    canvasStats.drawImage++;
    if (this.canvas.isConnected) { canvasStats.drawImageDisplay++; return; }
    const sp = sourcePixels(src);
    if (!sp) { canvasStats.drawImageNoPixels++; return; }
    let sx = 0, sy = 0, sw = sp.width, sh = sp.height, dx = 0, dy = 0, dw = sp.width, dh = sp.height;
    if (a.length === 2) [dx, dy] = a;
    else if (a.length === 4) [dx, dy, dw, dh] = a;
    else if (a.length >= 8) [sx, sy, sw, sh, dx, dy, dw, dh] = a;
    const dst = this.pixels(true);
    if (!dst || !(sw > 0) || !(sh > 0) || !(dw > 0) || !(dh > 0)) return;
    if (dw !== sw || dh !== sh) canvasStats.drawImageScaled++;
    this.painted = true;
    dx = Math.round(dx); dy = Math.round(dy); dw = Math.round(dw); dh = Math.round(dh);
    const W = this.bw, H = this.bh, kx = sw / dw, ky = sh / dh;
    for (let y = 0; y < dh; y++) {
      const ty = dy + y; if (ty < 0 || ty >= H) continue;
      const fy = Math.floor(sy + (y + 0.5) * ky); if (fy < 0 || fy >= sp.height) continue;
      for (let x = 0; x < dw; x++) {
        const tx = dx + x; if (tx < 0 || tx >= W) continue;
        const fx = Math.floor(sx + (x + 0.5) * kx); if (fx < 0 || fx >= sp.width) continue;
        const s = (fy * sp.width + fx) * 4, d = (ty * W + tx) * 4;
        const al = sp.data[s + 3];
        if (al === 0) continue; // source-over: a transparent source pixel leaves the destination alone
        dst[d] = sp.data[s]; dst[d + 1] = sp.data[s + 1]; dst[d + 2] = sp.data[s + 2];
        dst[d + 3] = Math.max(dst[d + 3], al);
      }
    }
  }

  getImageData(x: number, y: number, w: number, h: number): { data: Uint8ClampedArray; width: number; height: number; colorSpace: string } {
    canvasStats.getImageData++;
    w = Math.max(1, Math.abs(w | 0)); h = Math.max(1, Math.abs(h | 0)); x |= 0; y |= 0;
    const out = new Uint8ClampedArray(w * h * 4);
    const src = this.pixels(false);
    if (!src || !this.painted) {
      canvasStats.getImageDataBlank++;
      if (canvasStats.blankReads.length < 20) canvasStats.blankReads.push(`${this.canvas.width}x${this.canvas.height}`);
    } else {
      for (let r = 0; r < h; r++) {
        const sy = y + r; if (sy < 0 || sy >= this.bh) continue;
        const x0 = Math.max(0, x), x1 = Math.min(this.bw, x + w);
        if (x1 > x0) out.set(src.subarray((sy * this.bw + x0) * 4, (sy * this.bw + x1) * 4), (r * w + (x0 - x)) * 4);
      }
    }
    return { data: out, width: w, height: h, colorSpace: 'srgb' };
  }

  putImageData(img: { data: ArrayLike<number>; width: number; height: number }, dx: number, dy: number): void {
    const dst = this.pixels(true); if (!dst || !img?.data) return;
    this.painted = true;
    for (let r = 0; r < img.height; r++) {
      const ty = (dy | 0) + r; if (ty < 0 || ty >= this.bh) continue;
      for (let c = 0; c < img.width; c++) {
        const tx = (dx | 0) + c; if (tx < 0 || tx >= this.bw) continue;
        const s = (r * img.width + c) * 4, d = (ty * this.bw + tx) * 4;
        dst[d] = img.data[s]; dst[d + 1] = img.data[s + 1]; dst[d + 2] = img.data[s + 2]; dst[d + 3] = img.data[s + 3];
      }
    }
  }

  createImageData(w: any, h?: number) {
    const width = typeof w === 'object' ? w.width : w | 0, height = typeof w === 'object' ? w.height : (h ?? 0) | 0;
    return { data: new Uint8ClampedArray(Math.max(1, width * height * 4)), width, height, colorSpace: 'srgb' };
  }

  clearRect(x: number, y: number, w: number, h: number): void {
    const dst = this.pixels(false); if (!dst) return;
    const x0 = Math.max(0, Math.floor(x)), y0 = Math.max(0, Math.floor(y)), x1 = Math.min(this.bw, Math.ceil(x + w)), y1 = Math.min(this.bh, Math.ceil(y + h));
    for (let r = y0; r < y1; r++) dst.fill(0, (r * this.bw + x0) * 4, (r * this.bw + x1) * 4);
  }

  measureText(text: string) {
    // No font engine: a fixed advance per character of the current font size. Layout only.
    const px = Number(/(\d+(?:\.\d+)?)px/.exec(this.font)?.[1] ?? 10);
    const width = String(text).length * px * 0.55;
    return { width, actualBoundingBoxLeft: 0, actualBoundingBoxRight: width, actualBoundingBoxAscent: px * 0.8, actualBoundingBoxDescent: px * 0.2, fontBoundingBoxAscent: px * 0.8, fontBoundingBoxDescent: px * 0.2 };
  }

  createLinearGradient() { return new Gradient(); }
  createRadialGradient() { return new Gradient(); }
  createConicGradient() { return new Gradient(); }
  createPattern() { return {}; }
  getLineDash(): number[] { return []; }
  getTransform() { return { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }; }
  isPointInPath() { return false; }
  isPointInStroke() { return false; }
  getContextAttributes() { return { alpha: true, colorSpace: 'srgb', desynchronized: false, willReadFrequently: false }; }
}

// Drawing calls with no effect in the sim.
for (const m of ['save', 'restore', 'scale', 'rotate', 'translate', 'transform', 'setTransform', 'resetTransform', 'beginPath',
  'closePath', 'moveTo', 'lineTo', 'bezierCurveTo', 'quadraticCurveTo', 'arc', 'arcTo', 'ellipse', 'rect', 'roundRect', 'fill',
  'stroke', 'clip', 'fillRect', 'strokeRect', 'fillText', 'strokeText', 'setLineDash', 'drawFocusIfNeeded', 'reset'])
  (NullContext2D.prototype as any)[m] = function () { /* presentation only */ };
