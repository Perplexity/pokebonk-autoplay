/**
 * Null WebGL2 context. Replaces the GPU: three.js `WebGLRenderer` (and the postprocessing composer the game builds on
 * it) can be constructed and can "render" against it, but nothing is drawn and nothing can be read back.
 *
 * - UPPER_CASE properties are GL enum constants. The handful three.js branches on have their real values; any other
 *   constant gets a stable unique number, so three's internal lookup tables keyed by constant do not collide.
 * - `getParameter` answers with generous desktop limits; `get*Parameter(…, LINK/COMPILE_STATUS)` say "ok";
 *   programs report zero active uniforms and attributes (so no uniform upload code runs at all).
 * - Every other method is a no-op. `readPixels` leaves its buffer untouched (zeros): the game's "black screen"
 *   watchdog reads it, which is presentation-only.
 */

const KNOWN: Record<string, number> = {
  VERSION: 0x1f02, SHADING_LANGUAGE_VERSION: 0x8b8c, VENDOR: 0x1f00, RENDERER: 0x1f01,
  MAX_TEXTURE_SIZE: 0x0d33, MAX_CUBE_MAP_TEXTURE_SIZE: 0x851c, MAX_TEXTURE_IMAGE_UNITS: 0x8872,
  MAX_VERTEX_TEXTURE_IMAGE_UNITS: 0x8b4c, MAX_COMBINED_TEXTURE_IMAGE_UNITS: 0x8b4d, MAX_VERTEX_ATTRIBS: 0x8869,
  MAX_VERTEX_UNIFORM_VECTORS: 0x8dfb, MAX_VARYING_VECTORS: 0x8dfc, MAX_FRAGMENT_UNIFORM_VECTORS: 0x8dfd,
  MAX_SAMPLES: 0x8d57, MAX_RENDERBUFFER_SIZE: 0x84e8, MAX_3D_TEXTURE_SIZE: 0x8073, MAX_ARRAY_TEXTURE_LAYERS: 0x88ff,
  MAX_DRAW_BUFFERS: 0x8824, MAX_COLOR_ATTACHMENTS: 0x8cdf, MAX_VIEWPORT_DIMS: 0x0d3a,
  MAX_UNIFORM_BUFFER_BINDINGS: 0x8a2f, MAX_UNIFORM_BLOCK_SIZE: 0x8a30,
  SCISSOR_BOX: 0x0c10, VIEWPORT: 0x0ba2, ALIASED_LINE_WIDTH_RANGE: 0x846e, ALIASED_POINT_SIZE_RANGE: 0x846d,
  COMPILE_STATUS: 0x8b81, LINK_STATUS: 0x8b82, VALIDATE_STATUS: 0x8b83, DELETE_STATUS: 0x8b80,
  ACTIVE_UNIFORMS: 0x8b86, ACTIVE_ATTRIBUTES: 0x8b89, ACTIVE_UNIFORM_BLOCKS: 0x8a36, ATTACHED_SHADERS: 0x8b85,
  FRAMEBUFFER_COMPLETE: 0x8cd5, NO_ERROR: 0, IMPLEMENTATION_COLOR_READ_FORMAT: 0x8b9b, IMPLEMENTATION_COLOR_READ_TYPE: 0x8b9a,
  RGBA: 0x1908, UNSIGNED_BYTE: 0x1401, FLOAT: 0x1406, HALF_FLOAT: 0x140b,
  LOW_FLOAT: 0x8df0, MEDIUM_FLOAT: 0x8df1, HIGH_FLOAT: 0x8df2, LOW_INT: 0x8df3, MEDIUM_INT: 0x8df4, HIGH_INT: 0x8df5,
  VERTEX_SHADER: 0x8b31, FRAGMENT_SHADER: 0x8b30, TEXTURE0: 0x84c0,
  SYNC_GPU_COMMANDS_COMPLETE: 0x9117, ALREADY_SIGNALED: 0x911a, CONDITION_SATISFIED: 0x911c, SIGNALED: 0x9119,
  QUERY_RESULT_AVAILABLE: 0x8867, QUERY_RESULT: 0x8866,
  MAX_TEXTURE_MAX_ANISOTROPY_EXT: 0x84ff,
};

/** What `getExtension` hands out: the extensions a current desktop GPU has, as inert objects. */
const EXTENSIONS = [
  'EXT_color_buffer_float', 'EXT_color_buffer_half_float', 'EXT_texture_filter_anisotropic', 'OES_texture_float_linear',
  'EXT_float_blend', 'KHR_parallel_shader_compile', 'WEBGL_lose_context', 'WEBGL_debug_renderer_info',
  'WEBGL_multisampled_render_to_texture', 'OES_draw_buffers_indexed', 'EXT_disjoint_timer_query_webgl2',
];

export interface NullGLStats { calls: number; draws: number }

export function createNullGL(canvas: any, attrs: Record<string, unknown> = {}): any {
  const stats: NullGLStats = { calls: 0, draws: 0 };
  const consts = new Map<string, number>(Object.entries(KNOWN));
  let nextConst = 0x20000;
  const K = (name: string) => { let v = consts.get(name); if (v === undefined) { v = nextConst++; consts.set(name, v); } return v; };
  const byValue = (v: number) => { for (const [k, n] of consts) if (n === v) return k; return ''; };
  const noop = () => undefined;
  let nextObj = 1;
  const obj = (kind: string) => ({ __gl: kind, id: nextObj++ });

  const contextAttributes = {
    alpha: true, antialias: false, depth: true, stencil: false, premultipliedAlpha: true, preserveDrawingBuffer: false,
    powerPreference: 'default', failIfMajorPerformanceCaveat: false, desynchronized: false, xrCompatible: false, ...attrs,
  };

  const getParameter = (p: number): unknown => {
    switch (byValue(p)) {
      case 'VERSION': return 'WebGL 2.0 (null context, headless sim)';
      case 'SHADING_LANGUAGE_VERSION': return 'WebGL GLSL ES 3.00 (null context)';
      case 'VENDOR': return 'pokebonk-autoplay';
      case 'RENDERER': return 'Null WebGL2 (headless sim)';
      case 'MAX_TEXTURE_SIZE': case 'MAX_CUBE_MAP_TEXTURE_SIZE': case 'MAX_RENDERBUFFER_SIZE': return 16384;
      case 'MAX_3D_TEXTURE_SIZE': case 'MAX_ARRAY_TEXTURE_LAYERS': return 2048;
      case 'MAX_TEXTURE_IMAGE_UNITS': case 'MAX_VERTEX_TEXTURE_IMAGE_UNITS': return 16;
      case 'MAX_COMBINED_TEXTURE_IMAGE_UNITS': return 32;
      case 'MAX_VERTEX_ATTRIBS': return 16;
      case 'MAX_VERTEX_UNIFORM_VECTORS': return 4096;
      case 'MAX_FRAGMENT_UNIFORM_VECTORS': return 1024;
      case 'MAX_VARYING_VECTORS': return 30;
      case 'MAX_SAMPLES': return 4;
      case 'MAX_DRAW_BUFFERS': case 'MAX_COLOR_ATTACHMENTS': return 8;
      case 'MAX_UNIFORM_BUFFER_BINDINGS': return 24;
      case 'MAX_UNIFORM_BLOCK_SIZE': return 65536;
      case 'MAX_TEXTURE_MAX_ANISOTROPY_EXT': return 16;
      case 'MAX_VIEWPORT_DIMS': return new Int32Array([16384, 16384]);
      case 'SCISSOR_BOX': case 'VIEWPORT': return new Int32Array([0, 0, canvas.width || 1, canvas.height || 1]);
      case 'ALIASED_LINE_WIDTH_RANGE': return new Float32Array([1, 1]);
      case 'ALIASED_POINT_SIZE_RANGE': return new Float32Array([1, 1024]);
      case 'IMPLEMENTATION_COLOR_READ_FORMAT': return K('RGBA');
      case 'IMPLEMENTATION_COLOR_READ_TYPE': return K('UNSIGNED_BYTE');
      default: return null;
    }
  };
  const statusParameter = (_o: unknown, p: number): unknown => {
    switch (byValue(p)) {
      case 'COMPILE_STATUS': case 'LINK_STATUS': case 'VALIDATE_STATUS': return true;
      case 'DELETE_STATUS': return false;
      default: return 0; // ACTIVE_UNIFORMS, ACTIVE_ATTRIBUTES, ACTIVE_UNIFORM_BLOCKS, ATTACHED_SHADERS
    }
  };

  const extObjects = new Map<string, unknown>();
  const methods: Record<string, (...a: any[]) => unknown> = {
    getContextAttributes: () => ({ ...contextAttributes }),
    isContextLost: () => false,
    getError: () => 0,
    getParameter,
    getSupportedExtensions: () => [...EXTENSIONS],
    getExtension: (name: string) => {
      if (!EXTENSIONS.includes(name)) return null;
      let e = extObjects.get(name);
      if (!e) {
        // Extension objects: constants resolve like the context's, functions are no-ops.
        e = new Proxy({}, { get: (_t, prop) => typeof prop !== 'string' ? undefined : /^[A-Z][A-Z0-9_]*$/.test(prop) ? K(prop) : noop });
        extObjects.set(name, e);
      }
      return e;
    },
    getShaderPrecisionFormat: () => ({ rangeMin: 127, rangeMax: 127, precision: 23 }),
    getShaderParameter: statusParameter,
    getProgramParameter: statusParameter,
    getShaderInfoLog: () => '',
    getProgramInfoLog: () => '',
    getShaderSource: () => '',
    getActiveUniform: () => null,
    getActiveAttrib: () => null,
    getUniformLocation: () => null,
    getAttribLocation: () => -1,
    getUniformBlockIndex: () => 0,
    getActiveUniformBlockName: () => '',
    getActiveUniformBlockParameter: () => 0,
    getUniformIndices: () => [],
    getActiveUniforms: () => [],
    checkFramebufferStatus: () => K('FRAMEBUFFER_COMPLETE'),
    getBufferParameter: () => 0,
    getFramebufferAttachmentParameter: () => 0,
    getRenderbufferParameter: () => 0,
    getTexParameter: () => 0,
    getInternalformatParameter: () => new Int32Array([4, 2, 1]),
    fenceSync: () => obj('sync'),
    clientWaitSync: () => K('CONDITION_SATISFIED'),
    getSyncParameter: () => K('SIGNALED'),
    getQueryParameter: (_q: unknown, p: number) => (byValue(p) === 'QUERY_RESULT_AVAILABLE' ? true : 0),
    getQuery: () => null,
    drawArrays: () => { stats.draws++; },
    drawElements: () => { stats.draws++; },
    drawArraysInstanced: () => { stats.draws++; },
    drawElementsInstanced: () => { stats.draws++; },
    drawRangeElements: () => { stats.draws++; },
    readPixels: noop, // leaves the caller's buffer as it is (zeros)
  };

  const target: Record<string, unknown> = { canvas, drawingBufferColorSpace: 'srgb', unpackColorSpace: 'srgb', __nullGL: stats };
  return new Proxy(target, {
    get(t, prop) {
      if (typeof prop !== 'string') return undefined;
      if (prop in t) return t[prop];
      if (prop === 'drawingBufferWidth') return canvas.width || 1;
      if (prop === 'drawingBufferHeight') return canvas.height || 1;
      if (prop === 'then') return undefined;
      if (/^[A-Z][A-Z0-9_]*$/.test(prop)) return K(prop);
      let f: (...a: any[]) => unknown;
      const m = methods[prop];
      if (m) f = (...a) => { stats.calls++; return m(...a); };
      else if (/^create[A-Z]/.test(prop)) { const kind = prop.slice(6); f = () => { stats.calls++; return obj(kind); }; }
      else if (/^is[A-Z]/.test(prop)) f = () => { stats.calls++; return false; };
      else f = () => { stats.calls++; return undefined; };
      t[prop] = f; // cache: the next lookup of this method skips the proxy logic above
      return f;
    },
    set(t, prop, v) { t[prop as string] = v; return true; },
    has() { return true; },
  });
}
