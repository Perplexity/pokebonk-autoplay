/**
 * One implementation of the transcendental Math functions for BOTH sides of the fidelity comparison.
 *
 * Why: Node's V8 and Chrome's V8 are different builds of different versions, and they do not compute sin, cos, exp,
 * log, atan2 … identically: a few percent of results differ in the last bit (`node scripts/fidelity/math.ts`). The
 * game's map generator and physics call these functions, so a headless run and a browser run cannot be bit-identical
 * however good the shims are. To tell "the shims change behaviour" apart from "the two engines round differently",
 * the comparison can be run with these functions replaced, on both sides, by the same plain-JavaScript code below.
 * It only uses + − × ÷, Math.sqrt and bit access to doubles, which are exact (IEEE-754) in every engine, so both
 * sides get identical results by construction.
 *
 * This is an instrument of the comparison, not a fix and not part of the environment: it is installed only by the
 * fidelity scripts, only when asked (`--common-math`). The functions are ports of the usual fdlibm / musl kernels
 * (errors of about 1 ulp); a few are built from the others (asin, acos, sinh, cosh, tanh, log1p, expm1, cbrt, the
 * inverse hyperbolics) and are a little less accurate. They are not what either engine computes.
 *
 * Self-contained (it is sent to the page as source text): no imports, no closures.
 */
export function installCommonMath(target: any = Math): string[] {
  const f64 = new Float64Array(1), u32 = new Uint32Array(f64.buffer); // little-endian hosts: u32[1] is the high word
  const sqrt = Math.sqrt, abs = Math.abs, round = Math.round, floor = Math.floor, nativePow = Math.pow;
  const hi = (x: number) => { f64[0] = x; return u32[1]; };
  const expo = (x: number) => (hi(x) >>> 20) & 0x7ff;
  /** x · 2^k, exact while the result is a normal number. */
  const scalb = (x: number, k: number): number => {
    if (k > 1023) { x *= 8.98846567431158e307; k -= 1023; if (k > 1023) { x *= 8.98846567431158e307; k -= 1023; if (k > 1023) k = 1023; } }
    else if (k < -1022) { x *= 2.004168360008973e-292; k += 969; if (k < -1022) { x *= 2.004168360008973e-292; k += 969; if (k < -1022) k = -1022; } }
    u32[0] = 0; u32[1] = (0x3ff + k) << 20;
    return x * f64[0];
  };

  const LN2_HI = 6.93147180369123816490e-01, LN2_LO = 1.90821492927058770002e-10, INV_LN2 = 1.44269504088896338700e+00;
  const P1 = 1.66666666666666019037e-01, P2 = -2.77777777770155933842e-03, P3 = 6.61375632143793436117e-05, P4 = -1.65339022054652515390e-06, P5 = 4.13813679705723846039e-08;
  const exp = (x: number): number => {
    if (x !== x) return NaN;
    if (x > 709.782712893384) return Infinity;
    if (x < -745.1332191019411) return 0;
    const ax = abs(x);
    let k = 0, h = x, l = 0;
    if (ax > 0.34657359027997264) { k = round(x * INV_LN2); h = x - k * LN2_HI; l = k * LN2_LO; }
    else if (ax < 3.725290298461914e-9) return 1 + x;
    const r = h - l, t = r * r, c = r - t * (P1 + t * (P2 + t * (P3 + t * (P4 + t * P5))));
    const y = 1 - ((l - (r * c) / (2 - c)) - h);
    return k === 0 ? y : scalb(y, k);
  };

  const Lg1 = 6.666666666666735130e-01, Lg2 = 3.999999999940941908e-01, Lg3 = 2.857142874366239149e-01, Lg4 = 2.222219843214978396e-01, Lg5 = 1.818357216161805012e-01, Lg6 = 1.531383769920937332e-01, Lg7 = 1.479819860511658591e-01;
  const log = (x: number): number => {
    if (x !== x || x < 0) return NaN;
    if (x === 0) return -Infinity;
    if (x === Infinity) return Infinity;
    let k = 0;
    f64[0] = x;
    if (u32[1] < 0x00100000) { k -= 54; f64[0] = x * 18014398509481984; }
    let hx = u32[1];
    const lx = u32[0];
    if (hx === 0x3ff00000 && lx === 0) return k === 0 ? 0 : k * LN2_HI + k * LN2_LO;
    hx += 0x3ff00000 - 0x3fe6a09e;
    k += (hx >>> 20) - 0x3ff;
    hx = (hx & 0x000fffff) + 0x3fe6a09e;
    u32[1] = hx; u32[0] = lx;
    const f = f64[0] - 1, hfsq = 0.5 * f * f, s = f / (2 + f), z = s * s, w = z * z;
    const t1 = w * (Lg2 + w * (Lg4 + w * Lg6)), t2 = z * (Lg1 + w * (Lg3 + w * (Lg5 + w * Lg7)));
    return s * (hfsq + (t2 + t1)) + k * LN2_LO - hfsq + f + k * LN2_HI;
  };

  const S1 = -1.66666666666666324348e-01, S2 = 8.33333333332248946124e-03, S3 = -1.98412698298579493134e-04, S4 = 2.75573137070700676789e-06, S5 = -2.50507602534068634195e-08, S6 = 1.58969099521155010221e-10;
  const ksin = (x: number, y: number, iy: number): number => {
    const z = x * x, w = z * z, r = S2 + z * (S3 + z * S4) + z * w * (S5 + z * S6), v = z * x;
    return iy === 0 ? x + v * (S1 + z * r) : x - ((z * (0.5 * y - v * r) - y) - v * S1);
  };
  const C1 = 4.16666666666666019037e-02, C2 = -1.38888888888741095749e-03, C3 = 2.48015872894767294178e-05, C4 = -2.75573143513906633035e-07, C5 = 2.08757232129817482790e-09, C6 = -1.13596475577881948265e-11;
  const kcos = (x: number, y: number): number => {
    const z = x * x, w = z * z, r = z * (C1 + z * (C2 + z * C3)) + w * w * (C4 + z * (C5 + z * C6)), hz = 0.5 * z, q = 1 - hz;
    return q + (((1 - q) - hz) + (z * r - x * y));
  };
  const TOINT = 6755399441055744, INV_PIO2 = 6.36619772367581382433e-01, PIO2_1 = 1.57079632673412561417e+00, PIO2_1T = 6.07710050650619224932e-11;
  const PIO2_2 = 6.07710050630396597660e-11, PIO2_2T = 2.02226624879595063154e-21, PIO2_3 = 2.02226624871116645580e-21, PIO2_3T = 8.47842766036889956997e-32;
  const TWO_PI = 6.283185307179586;
  let y0 = 0, y1 = 0;
  /** x = n·π/2 + (y0 + y1), |y0| ≤ π/4. Returns n mod 4. */
  const remPio2 = (x: number): number => {
    // Beyond about 1.6 million the three-constant reduction runs out of bits: fold the argument first. Coarse, and
    // the same on both sides, which is all that is asked of it here.
    if (abs(x) >= 1647099) x = x - floor(x / TWO_PI) * TWO_PI;
    const fn = x * INV_PIO2 + TOINT - TOINT;
    let r = x - fn * PIO2_1, w = fn * PIO2_1T;
    y0 = r - w;
    const ex = expo(x);
    if (ex - expo(y0) > 16) {
      let t = r;
      w = fn * PIO2_2; r = t - w; w = fn * PIO2_2T - ((t - r) - w); y0 = r - w;
      if (ex - expo(y0) > 49) { t = r; w = fn * PIO2_3; r = t - w; w = fn * PIO2_3T - ((t - r) - w); y0 = r - w; }
    }
    y1 = (r - y0) - w;
    return ((fn % 4) + 4) % 4;
  };
  const sin = (x: number): number => {
    if (x !== x || x === Infinity || x === -Infinity) return NaN;
    if (abs(x) <= 0.7853981633974483) return abs(x) < 7.450580596923828e-9 ? x : ksin(x, 0, 0);
    const n = remPio2(x);
    return n === 0 ? ksin(y0, y1, 1) : n === 1 ? kcos(y0, y1) : n === 2 ? -ksin(y0, y1, 1) : -kcos(y0, y1);
  };
  const cos = (x: number): number => {
    if (x !== x || x === Infinity || x === -Infinity) return NaN;
    if (abs(x) <= 0.7853981633974483) return kcos(x, 0);
    const n = remPio2(x);
    return n === 0 ? kcos(y0, y1) : n === 1 ? -ksin(y0, y1, 1) : n === 2 ? -kcos(y0, y1) : ksin(y0, y1, 1);
  };
  const tan = (x: number): number => (x === 0 ? x : sin(x) / cos(x));

  const ATAN_HI = [4.63647609000806093515e-01, 7.85398163397448278999e-01, 9.82793723247329054082e-01, 1.57079632679489655800e+00];
  const ATAN_LO = [2.26987774529616870924e-17, 3.06161699786838301793e-17, 1.39033110312309984516e-17, 6.12323399573676603587e-17];
  const aT = [3.33333333333329318027e-01, -1.99999999998764832476e-01, 1.42857142725034663711e-01, -1.11111104054623557880e-01, 9.09088713343650656196e-02, -7.69187620504482999495e-02, 6.66107313738753120669e-02, -5.83357013379057348645e-02, 4.97687799461593236017e-02, -3.65315727442169155270e-02, 1.62858201153657823623e-02];
  const atan = (x: number): number => {
    if (x !== x) return NaN;
    const neg = x < 0 || Object.is(x, -0);
    let a = abs(x), id = -1;
    if (a >= 7.378697629483821e19) return neg ? -ATAN_HI[3] : ATAN_HI[3];
    if (a < 0.4375) { if (a < 7.450580596923828e-9) return x; }
    else if (a < 1.1875) { if (a < 0.6875) { id = 0; a = (2 * a - 1) / (2 + a); } else { id = 1; a = (a - 1) / (a + 1); } }
    else if (a < 2.4375) { id = 2; a = (a - 1.5) / (1 + 1.5 * a); }
    else { id = 3; a = -1 / a; }
    const z = a * a, w = z * z;
    const s1 = z * (aT[0] + w * (aT[2] + w * (aT[4] + w * (aT[6] + w * (aT[8] + w * aT[10])))));
    const s2 = w * (aT[1] + w * (aT[3] + w * (aT[5] + w * (aT[7] + w * aT[9]))));
    const r = id < 0 ? a - a * (s1 + s2) : ATAN_HI[id] - ((a * (s1 + s2) - ATAN_LO[id]) - a);
    return neg ? -r : r;
  };
  const PI = 3.1415926535897931160e+00, PI_LO = 1.2246467991473531772e-16;
  const atan2 = (y: number, x: number): number => {
    if (x !== x || y !== y) return NaN;
    const m = (y < 0 || Object.is(y, -0) ? 1 : 0) | (x < 0 || Object.is(x, -0) ? 2 : 0);
    if (y === 0) return m === 0 || m === 1 ? y : m === 2 ? PI : -PI;
    if (x === 0) return m & 1 ? -PI / 2 : PI / 2;
    const xInf = x === Infinity || x === -Infinity, yInf = y === Infinity || y === -Infinity;
    if (xInf) return yInf ? [PI / 4, -PI / 4, (3 * PI) / 4, (-3 * PI) / 4][m] : [0, -0, PI, -PI][m];
    if (yInf) return m & 1 ? -PI / 2 : PI / 2;
    const z = atan(abs(y / x));
    return m === 0 ? z : m === 1 ? -z : m === 2 ? PI - (z - PI_LO) : (z - PI_LO) - PI;
  };
  const asin = (x: number): number => (x !== x || abs(x) > 1 ? NaN : x === 0 ? x : atan2(x, sqrt((1 - x) * (1 + x))));
  const acos = (x: number): number => (x !== x || abs(x) > 1 ? NaN : atan2(sqrt((1 - x) * (1 + x)), x));

  const expm1 = (x: number): number => {
    if (x !== x) return NaN;
    if (x === 0) return x;
    const u = exp(x);
    if (u === Infinity) return Infinity;
    if (u === 1) return x;
    const d = u - 1;
    return d === -1 ? -1 : (d * x) / log(u);
  };
  const log1p = (x: number): number => {
    if (x !== x || x < -1) return NaN;
    if (x === Infinity) return Infinity;
    const u = 1 + x;
    return u === 1 ? x : (log(u) * x) / (u - 1);
  };
  const log2 = (x: number): number => {
    if (x !== x || x < 0) return NaN;
    if (x === 0) return -Infinity;
    if (x === Infinity) return Infinity;
    let k = 0;
    f64[0] = x;
    if (u32[1] < 0x00100000) { k -= 54; f64[0] = x * 18014398509481984; }
    k += (u32[1] >>> 20) - 0x3ff;
    u32[1] = (u32[1] & 0x000fffff) | 0x3ff00000;
    const m = f64[0];
    return m === 1 ? k : k + log(m) * INV_LN2;
  };
  const log10 = (x: number): number => {
    const r = log(x) * 0.4342944819032518;
    if (r !== r || r === Infinity || r === -Infinity) return r;
    const k = round(r);
    return abs(r - k) < 1e-9 && nativePow(10, k) === x ? k : r;
  };
  const sinh = (x: number): number => {
    if (x !== x || x === 0) return x;
    const a = abs(x);
    let r: number;
    if (a < 22) { const t = expm1(a); r = 0.5 * (t + t / (t + 1)); } else r = a < 709 ? 0.5 * exp(a) : scalb(exp(a - 1), 0) * 1.3591409142295225;
    return x < 0 ? -r : r;
  };
  const cosh = (x: number): number => {
    if (x !== x) return NaN;
    const a = abs(x);
    if (a < 709) { const t = exp(a); return 0.5 * (t + 1 / t); }
    return exp(a - 1) * 1.3591409142295225;
  };
  const tanh = (x: number): number => {
    if (x !== x || x === 0) return x;
    const a = abs(x);
    let r: number;
    if (a < 20) { const t = expm1(2 * a); r = t / (t + 2); } else r = 1;
    return x < 0 ? -r : r;
  };
  const asinh = (x: number): number => {
    if (x !== x || x === 0 || x === Infinity || x === -Infinity) return x;
    const a = abs(x);
    const r = a > 1e8 ? log(a) + 0.6931471805599453 : a > 0.5 ? log(a + sqrt(a * a + 1)) : log1p(a + (a * a) / (1 + sqrt(1 + a * a)));
    return x < 0 ? -r : r;
  };
  const acosh = (x: number): number => (x !== x || x < 1 ? NaN : x > 1e8 ? log(x) + 0.6931471805599453 : log(x + sqrt((x - 1) * (x + 1))));
  const atanh = (x: number): number => {
    if (x !== x || abs(x) > 1) return NaN;
    if (x === 0) return x;
    const a = abs(x), r = 0.5 * log1p((2 * a) / (1 - a));
    return x < 0 ? -r : r;
  };
  const cbrt = (x: number): number => {
    if (x !== x || x === 0 || x === Infinity || x === -Infinity) return x;
    const a = abs(x);
    let t = exp(log(a) / 3);
    t = t - (t * t * t - a) / (3 * t * t);
    const r = round(t);
    if (r * r * r === a) t = r;
    return x < 0 ? -t : t;
  };

  const fns: Record<string, (...a: number[]) => number> = { sin, cos, tan, asin, acos, atan, atan2, sinh, cosh, tanh, asinh, acosh, atanh, exp, expm1, log, log1p, log2, log10, cbrt };
  for (const name of Object.keys(fns)) Object.defineProperty(target, name, { value: fns[name], writable: true, configurable: true, enumerable: false });
  return Object.keys(fns);
}
