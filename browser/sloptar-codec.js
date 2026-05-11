// sloptar-codec.js — Sloptar BCH(63, 45, t=3) codec.
//
// Pure JavaScript: no DOM, no canvas, no FileReader. Works in:
//   • a browser   <script src="sloptar-codec.js">    → window.SLOPTAR
//   • Node.js     const sloptar = require('./sloptar-codec.js');
//   • a worker    importScripts('sloptar-codec.js')  → self.SLOPTAR
//
// Public API (all functions accept/return only Uint8Array, BigInt, plain
// objects, and Promises):
//   makeGeometry(xcrosses, ycrosses)              → page constants
//   encodeBytes(bytes, opts)                      → { pages: Uint8Array[], geom, ... }
//   decodeImageData({width, height, data}, opts)  → { bytes, stats, geom, ... }
//   wrapWithHeader(bytes, filename) [async]       → Uint8Array (OPTR + sha256 + name + NUL + body)
//   unwrapHeader(bytes)            [async]        → { filename, body, hashOk, hasHeader, ... }
//   stitchFrames(frames, opts)     [async]        → { bytes, stats, unique, dupes, failed }
//   buildFormatString(geom, pageNumber, totalPages, label)
//   parseFormatString(s)                          → { xcrosses, ycrosses } | null
//   bchEncode(45-bit data)                        → 63-bit BigInt codeword
//   bchDecode(63-bit BigInt)                      → { data, errors, reparable }
//
// `decodeImageData`'s argument is a structural type — any object with
// `width`, `height`, and an RGBA byte array `data` works. The browser's
// ImageData satisfies this; in Node, build one from `node-canvas`, `sharp`,
// or by hand.

(function (root, factory) {
  if (typeof exports === 'object' && typeof module !== 'undefined') {
    module.exports = factory();             // CommonJS / Node
  } else if (typeof define === 'function' && define.amd) {
    define([], factory);                    // AMD
  } else {
    root.SLOPTAR = factory();                 // Browser / worker global
  }
}(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this), function () {
  'use strict';

  // ==========================================================================
  // Constants — Twibright Sloptar geometry, BCH(63,45,t=3) FEC.
  // ==========================================================================
  const BORDER         = 2;
  const CHALF          = 3;
  const CPITCH         = 24;
  const TEXT_HEIGHT    = 24;
  const FEC_LARGEBITS  = 63;
  const FEC_SMALLBITS  = 45;
  // FEC_ORDER values:
  //   1     = Golay (legacy, original Sloptar)
  //   2..5  = Hamming variants (legacy)
  //   10    = BCH(63, 45, t=3), no per-page integrity check
  //   11    = BCH(63, 45, t=3) + per-page CRC32 (last codeword of each page
  //           holds CRC32 of the page's user-data bits)
  //   12    = BCH(63, 45, t=3) + per-page CRC32 + 5-color WRGBK palette
  //           (16 BCH bits packed into 7 cells, 5 states per cell: W/R/G/B/K)
  //   13    = BCH(63, 45, t=3) + per-page CRC32 + 5-color WCMYK palette
  //           (same geometry as 12; cells: W/C/M/Y/K — used for print output)
  // The encoder defaults to 11 (CRC); the decoder auto-branches on whatever
  // FEC_ORDER is parsed out of the user's format string, so older pages
  // (FEC_ORDER=10) and current pages (=11) both round-trip correctly.
  const FEC_ORDER      = 11;
  const DEFAULT_SCALE  = 3;

  // 5-color palettes: ids 0..4 (lightest → darkest, mirrors mono "0=light, 1=dark").
  //   WRGBK (fecOrder=12, screen/photo): 0=W  1=R  2=G  3=B  4=K
  //   WCMYK (fecOrder=13, print):        0=W  1=C  2=M  3=Y  4=K
  const PALETTE_5COLOR_RGB  = [[255,255,255],[255,0,0],[0,255,0],[0,0,255],[0,0,0]];
  const PALETTE_5COLOR_CMYK = [[255,255,255],[0,255,255],[255,0,255],[255,255,0],[0,0,0]];
  const PALETTE_5COLOR      = PALETTE_5COLOR_RGB;  // back-compat alias
  function paletteFor(colorMode) {
    if (colorMode === '5color-cmyk') return PALETTE_5COLOR_CMYK;
    if (colorMode === '5color')      return PALETTE_5COLOR_RGB;
    return null;
  }
  const COLOR_CHUNK_BITS  = 16;   // bits per base-5 chunk
  const COLOR_CHUNK_CELLS = 7;    // cells per chunk (5^7 = 78125 >= 2^16 = 65536)
  const PATCH_W           = 16;   // calibration patch width in cells
  const PATCH_H           = 20;   // calibration patch height (TEXT_HEIGHT-4, 2-cell border each side)

  const BCH_M         = 6;
  const BCH_N         = 63;
  const BCH_K         = 45;
  const BCH_T         = 3;
  const BCH_PARITY    = BCH_N - BCH_K;
  const BCH_PRIM_POLY = 0x43;  // x^6 + x + 1

  // Decoder magic constants — kept close to the C reference's tuned values.
  const SYNC_WHITE_CUT = 0.10;
  const WHITE_CUT      = 0.06;
  const CROSS_TRIM     = 0.75;
  const FINESTEP       = 0.25;

  const SLOPTAR_HEADER_MAGIC   = [0x4f, 0x50, 0x54, 0x52]; // "OPTR" — legacy uncompressed
  const SLOPTAR_HEADER_MAGIC_Z = [0x4f, 0x50, 0x54, 0x5a]; // "OPTZ" — gzip + explicit length

  // ==========================================================================
  // Geometry.
  // ==========================================================================
  function makeGeometry(xcrosses, ycrosses, colorMode) {
    colorMode = colorMode || 'mono';
    const DATA_WIDTH    = CPITCH * (xcrosses - 1) + 2 * CHALF;
    const DATA_HEIGHT   = CPITCH * (ycrosses - 1) + 2 * CHALF;
    const WIDTH         = 2 * BORDER + DATA_WIDTH;
    const HEIGHT        = 2 * BORDER + DATA_HEIGHT + TEXT_HEIGHT;
    const NARROWHEIGHT  = 2 * CHALF;
    const GAPWIDTH      = CPITCH - 2 * CHALF;
    const NARROWWIDTH   = GAPWIDTH * (xcrosses - 1);
    const NARROWPIXELS  = NARROWHEIGHT * NARROWWIDTH;
    const WIDEHEIGHT    = GAPWIDTH;
    const WIDEWIDTH     = WIDTH - 2 * BORDER;
    const WIDEPIXELS    = WIDEHEIGHT * WIDEWIDTH;
    const REPHEIGHT     = NARROWHEIGHT + WIDEHEIGHT;
    const REPPIXELS     = WIDEPIXELS + NARROWPIXELS;
    const TOTALBITS     = REPPIXELS * (ycrosses - 1) + NARROWPIXELS;

    let FEC_SYMS, NETBITS, patchCellPositions;
    if (colorMode === '5color' || colorMode === '5color-cmyk') {
      if (WIDTH < 5 * PATCH_W + 80) {
        throw new Error(
          `Page too narrow for 5-color mode (WIDTH=${WIDTH} cells, need >= ${5 * PATCH_W + 80}). ` +
          'Increase XCROSSES or use mono mode.'
        );
      }
      // Each COLOR_CHUNK_CELLS cells carry COLOR_CHUNK_BITS BCH bits.
      const chunksPerPage = Math.floor(TOTALBITS / COLOR_CHUNK_CELLS);
      const colorBits = chunksPerPage * COLOR_CHUNK_BITS;
      FEC_SYMS = Math.floor(colorBits / FEC_LARGEBITS);
      NETBITS  = FEC_SYMS * FEC_SMALLBITS;

      // Calibration patches: 5 patches at the right edge of the text strip.
      // Each patch interior is PATCH_W x PATCH_H cells; surrounded by a 2-cell
      // K border from the text-strip background fill.
      const stripY = BORDER + DATA_HEIGHT;         // top of text strip (cell row)
      const patchTop    = stripY + 2;              // 2-cell top border
      const patchBottom = stripY + 2 + PATCH_H;   // exclusive
      patchCellPositions = [];
      for (let k = 0; k < 5; k++) {
        const patchRight = WIDTH - 2 - k * (PATCH_W + 2);  // right edge of patch, exclusive
        const patchLeft  = patchRight - PATCH_W;
        patchCellPositions.unshift({ x0: patchLeft, y0: patchTop, x1: patchRight, y1: patchBottom });
      }
    } else {
      FEC_SYMS = Math.floor(TOTALBITS / FEC_LARGEBITS);
      NETBITS  = FEC_SYMS * FEC_SMALLBITS;
      patchCellPositions = null;
    }

    return {
      xcrosses, ycrosses,
      DATA_WIDTH, DATA_HEIGHT, WIDTH, HEIGHT,
      NARROWHEIGHT, GAPWIDTH, NARROWWIDTH, NARROWPIXELS,
      WIDEHEIGHT, WIDEWIDTH, WIDEPIXELS,
      REPHEIGHT, REPPIXELS, TOTALBITS,
      FEC_SYMS, NETBITS,
      colorMode, patchCellPositions,
    };
  }

  function seq2xy(geom, seq) {
    if (seq >= geom.TOTALBITS) return [-1, -1];
    const rep = Math.floor(seq / geom.REPPIXELS);
    let s = seq - rep * geom.REPPIXELS;
    let y = geom.REPHEIGHT * rep;
    let x;
    if (s >= geom.NARROWPIXELS) {
      y += geom.NARROWHEIGHT;
      s -= geom.NARROWPIXELS;
      y += Math.floor(s / geom.WIDEWIDTH);
      x  = s - Math.floor(s / geom.WIDEWIDTH) * geom.WIDEWIDTH;
    } else {
      x = 2 * CHALF;
      y += Math.floor(s / geom.NARROWWIDTH);
      s = s - Math.floor(s / geom.NARROWWIDTH) * geom.NARROWWIDTH;
      const gap = Math.floor(s / geom.GAPWIDTH);
      x += gap * CPITCH;
      s = s - gap * geom.GAPWIDTH;
      x += s;
    }
    return [x, y];
  }

  function seq2xyInto(geom, seq, out) {
    if (seq >= geom.TOTALBITS) { out[0] = -1; out[1] = -1; return; }
    const rep = (seq / geom.REPPIXELS) | 0;
    let s = seq - rep * geom.REPPIXELS;
    let y = geom.REPHEIGHT * rep;
    let x;
    if (s >= geom.NARROWPIXELS) {
      y += geom.NARROWHEIGHT;
      s -= geom.NARROWPIXELS;
      y += (s / geom.WIDEWIDTH) | 0;
      x  = s - ((s / geom.WIDEWIDTH) | 0) * geom.WIDEWIDTH;
    } else {
      x = 2 * CHALF;
      y += (s / geom.NARROWWIDTH) | 0;
      s = s - ((s / geom.NARROWWIDTH) | 0) * geom.NARROWWIDTH;
      const gap = (s / geom.GAPWIDTH) | 0;
      x += gap * CPITCH;
      s = s - gap * geom.GAPWIDTH;
      x += s;
    }
    out[0] = x;
    out[1] = y;
  }

  // ==========================================================================
  // BCH(63, 45, t=3) over GF(2^6).
  // ==========================================================================
  const BCH_GF_EXP = new Uint8Array(BCH_N + 1);
  const BCH_GF_LOG = new Int8Array(BCH_N + 1);
  (function initBCHTables() {
    let x = 1;
    for (let i = 0; i < BCH_N; i++) {
      BCH_GF_EXP[i] = x;
      BCH_GF_LOG[x] = i;
      x <<= 1;
      if (x & (1 << BCH_M)) x ^= BCH_PRIM_POLY;
    }
    BCH_GF_EXP[BCH_N] = BCH_GF_EXP[0];
    BCH_GF_LOG[0] = -1;
  })();

  function bchGfMul(a, b) {
    if (a === 0 || b === 0) return 0;
    return BCH_GF_EXP[(BCH_GF_LOG[a] + BCH_GF_LOG[b]) % BCH_N];
  }
  function bchGfDiv(a, b) {
    if (a === 0) return 0;
    if (b === 0) throw new Error('BCH GF division by zero');
    return BCH_GF_EXP[((BCH_GF_LOG[a] - BCH_GF_LOG[b]) % BCH_N + BCH_N) % BCH_N];
  }

  function bchMinimalPoly(k) {
    const seen = new Set();
    let v = k % BCH_N;
    while (!seen.has(v)) { seen.add(v); v = (v * 2) % BCH_N; }
    let poly = [1];
    for (const c of seen) {
      const ac = BCH_GF_EXP[c];
      const next = new Array(poly.length + 1).fill(0);
      for (let i = 0; i < poly.length; i++) {
        next[i + 1] ^= poly[i];
        next[i]     ^= bchGfMul(poly[i], ac);
      }
      poly = next;
    }
    let bits = 0;
    for (let i = 0; i < poly.length; i++) {
      if (poly[i] === 1) bits |= 1 << i;
      else if (poly[i] !== 0) throw new Error('BCH minimal poly should be over GF(2)');
    }
    return bits;
  }

  function bchPolyMulGF2(a, b) {
    let r = 0;
    while (b !== 0) { if (b & 1) r ^= a; a <<= 1; b >>>= 1; }
    return r;
  }

  const BCH_GEN     = bchPolyMulGF2(bchPolyMulGF2(bchMinimalPoly(1), bchMinimalPoly(3)), bchMinimalPoly(5));
  const BCH_GEN_BIG = BigInt(BCH_GEN);

  function bchEncode(data) {
    const d = typeof data === 'bigint' ? data : BigInt(data);
    let r = d << 18n;
    for (let i = 62; i >= 18; i--) {
      if ((r >> BigInt(i)) & 1n) r ^= BCH_GEN_BIG << BigInt(i - 18);
    }
    return (d << 18n) | r;
  }

  function bchSyndromes(received) {
    const r = typeof received === 'bigint' ? received : BigInt(received);
    const a1 = BCH_GF_EXP[1], a2 = BCH_GF_EXP[2], a3 = BCH_GF_EXP[3];
    const a4 = BCH_GF_EXP[4], a5 = BCH_GF_EXP[5], a6 = BCH_GF_EXP[6];
    let s1 = 0, s2 = 0, s3 = 0, s4 = 0, s5 = 0, s6 = 0;
    for (let j = BCH_N - 1; j >= 0; j--) {
      const cj = Number((r >> BigInt(j)) & 1n);
      s1 = bchGfMul(s1, a1) ^ cj;
      s2 = bchGfMul(s2, a2) ^ cj;
      s3 = bchGfMul(s3, a3) ^ cj;
      s4 = bchGfMul(s4, a4) ^ cj;
      s5 = bchGfMul(s5, a5) ^ cj;
      s6 = bchGfMul(s6, a6) ^ cj;
    }
    return [0, s1, s2, s3, s4, s5, s6];
  }

  function bchPGZ(S) {
    const M = bchGfMul, D = bchGfDiv;
    function det3(a) {
      return M(a[0][0], M(a[1][1], a[2][2]) ^ M(a[1][2], a[2][1]))
           ^ M(a[0][1], M(a[1][0], a[2][2]) ^ M(a[1][2], a[2][0]))
           ^ M(a[0][2], M(a[1][0], a[2][1]) ^ M(a[1][1], a[2][0]));
    }
    const M3 = [[S[1], S[2], S[3]], [S[2], S[3], S[4]], [S[3], S[4], S[5]]];
    const detM3 = det3(M3);
    if (detM3 !== 0) {
      const RHS = [S[4], S[5], S[6]];
      const m30 = [[RHS[0], M3[0][1], M3[0][2]], [RHS[1], M3[1][1], M3[1][2]], [RHS[2], M3[2][1], M3[2][2]]];
      const m31 = [[M3[0][0], RHS[0], M3[0][2]], [M3[1][0], RHS[1], M3[1][2]], [M3[2][0], RHS[2], M3[2][2]]];
      const m32 = [[M3[0][0], M3[0][1], RHS[0]], [M3[1][0], M3[1][1], RHS[1]], [M3[2][0], M3[2][1], RHS[2]]];
      return [1, D(det3(m32), detM3), D(det3(m31), detM3), D(det3(m30), detM3)];
    }
    const detM2 = M(S[1], S[3]) ^ M(S[2], S[2]);
    if (detM2 !== 0) {
      const lambda_1 = D(M(S[1], S[4]) ^ M(S[2], S[3]), detM2);
      const lambda_2 = D(M(S[2], S[4]) ^ M(S[3], S[3]), detM2);
      return [1, lambda_1, lambda_2];
    }
    if (S[1] !== 0) return [1, D(S[2], S[1])];
    return null;
  }

  function bchChienSearch(lambda) {
    const errors = [];
    for (let j = 0; j < BCH_N; j++) {
      let value = 0;
      const negJ = (BCH_N - j) % BCH_N;
      for (let k = 0; k < lambda.length; k++) {
        if (lambda[k] !== 0) {
          value ^= bchGfMul(lambda[k], BCH_GF_EXP[(k * negJ) % BCH_N]);
        }
      }
      if (value === 0) errors.push(j);
    }
    return errors;
  }

  function bchDecode(received) {
    const r = typeof received === 'bigint' ? received : BigInt(received);
    const S = bchSyndromes(r);
    if (S[1] === 0 && S[2] === 0 && S[3] === 0 && S[4] === 0 && S[5] === 0 && S[6] === 0) {
      return { data: Number(r >> 18n), errors: 0, reparable: true };
    }
    const lambda = bchPGZ(S);
    if (!lambda) {
      return { data: Number(r >> 18n), errors: 4, reparable: false };
    }
    const errs = bchChienSearch(lambda);
    if (errs.length !== lambda.length - 1) {
      return { data: Number(r >> 18n), errors: 4, reparable: false };
    }
    let corrected = r;
    for (const j of errs) corrected ^= 1n << BigInt(j);
    return { data: Number(corrected >> 18n), errors: errs.length, reparable: true };
  }

  // ==========================================================================
  // CRC32 (IEEE 802.3, reflected, init 0xFFFFFFFF, final XOR 0xFFFFFFFF).
  //
  // Used as an integrity check on each page's user-data bits, written into
  // the last BCH codeword of every page when FEC_ORDER == 11. CRC catches
  // BCH miscorrections — random bit patterns that BCH "fixes" to a
  // syntactically-valid but wrong codeword (1-3 bit errors that look
  // correctable but aren't).
  // ==========================================================================
  const CRC32_TABLE = (function () {
    const t = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let j = 0; j < 8; j++) {
        c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      }
      t[i] = c >>> 0;
    }
    return t;
  })();

  function crc32(bytes) {
    let c = 0xFFFFFFFF;
    for (let i = 0; i < bytes.length; i++) {
      c = (c >>> 8) ^ CRC32_TABLE[(c ^ bytes[i]) & 0xFF];
    }
    return (c ^ 0xFFFFFFFF) >>> 0;
  }

  // Streaming CRC over individual bits (MSB-first), with byte-level zero-pad
  // at finalize. Lets us feed each codeword's 45 bits into the CRC as the
  // encoder/decoder produces them, without materialising a large bit array.
  function makeBitwiseCrc32() {
    let accu = 0xFFFFFFFF;
    let buf = 0;
    let nbits = 0;
    return {
      consumeBit(bit) {
        buf = ((buf << 1) | (bit & 1)) & 0xFF;
        nbits++;
        if (nbits === 8) {
          accu = (accu >>> 8) ^ CRC32_TABLE[(accu ^ buf) & 0xFF];
          buf = 0;
          nbits = 0;
        }
      },
      finalize() {
        if (nbits > 0) {
          const padded = (buf << (8 - nbits)) & 0xFF;
          accu = (accu >>> 8) ^ CRC32_TABLE[(accu ^ padded) & 0xFF];
        }
        return (accu ^ 0xFFFFFFFF) >>> 0;
      },
    };
  }

  // ==========================================================================
  // Bit interleaver — exposed for tests / external integrations.
  // ==========================================================================
  function interleaveBits(codewords, fecSyms) {
    const out = new Uint8Array(fecSyms * FEC_LARGEBITS);
    for (let s = 0; s < codewords.length; s++) {
      const c = typeof codewords[s] === 'bigint' ? codewords[s] : BigInt(codewords[s]);
      for (let shift = FEC_LARGEBITS - 1; shift >= 0; shift--) {
        const idx = s + (FEC_LARGEBITS - 1 - shift) * fecSyms;
        out[idx] = Number((c >> BigInt(shift)) & 1n);
      }
    }
    return out;
  }

  function deinterleaveBits(bits, fecSyms) {
    const out = new Array(fecSyms);
    for (let s = 0; s < fecSyms; s++) {
      let c = 0n;
      for (let b = 0; b < FEC_LARGEBITS; b++) {
        const shift = FEC_LARGEBITS - 1 - b;
        c |= BigInt(bits[s + b * fecSyms]) << BigInt(shift);
      }
      out[s] = c;
    }
    return out;
  }

  // ==========================================================================
  // Page rendering — Uint8Array of 1 byte per cell (0=black, 0xff=white).
  // ==========================================================================
  // Draw alignment cross. In mono mode uses raw pixel bytes (0x00/0xff).
  // In 5-color mode uses palette ids (4=K, 0=W).
  function drawCross(cells, stride, x, y, black, white) {
    for (let r = 0; r < CHALF; r++) {
      const row = (y + r) * stride + x;
      cells.fill(black, row, row + CHALF);
      cells.fill(white, row + CHALF, row + 2 * CHALF);
      const row2 = row + CHALF * stride;
      cells.fill(white, row2, row2 + CHALF);
      cells.fill(black, row2 + CHALF, row2 + 2 * CHALF);
    }
  }

  function createBlankPage(geom) {
    const cells = new Uint8Array(geom.WIDTH * geom.HEIGHT);
    const use5 = (geom.colorMode === '5color' || geom.colorMode === '5color-cmyk');
    const BG    = use5 ? 0    : 0xff;   // page interior background (W=0 or white=0xff)
    const BLACK = use5 ? 4    : 0x00;   // border / text-strip / cross-black
    const WHITE = use5 ? 0    : 0xff;   // cross-white (same as BG)

    cells.fill(BG);
    cells.fill(BLACK, 0, BORDER * geom.WIDTH);
    for (let y = BORDER; y < BORDER + geom.DATA_HEIGHT; y++) {
      const row = y * geom.WIDTH;
      cells.fill(BLACK, row, row + BORDER);
      cells.fill(BLACK, row + geom.WIDTH - BORDER, row + geom.WIDTH);
    }
    const textStart = (BORDER + geom.DATA_HEIGHT) * geom.WIDTH;
    cells.fill(BLACK, textStart, textStart + TEXT_HEIGHT * geom.WIDTH);
    const bottom = (BORDER + geom.DATA_HEIGHT + TEXT_HEIGHT) * geom.WIDTH;
    cells.fill(BLACK, bottom, bottom + BORDER * geom.WIDTH);

    const maxY = geom.HEIGHT - TEXT_HEIGHT - BORDER - 2 * CHALF;
    const maxX = geom.WIDTH  - BORDER - 2 * CHALF;
    for (let y = BORDER; y <= maxY; y += CPITCH) {
      for (let x = BORDER; x <= maxX; x += CPITCH) {
        drawCross(cells, geom.WIDTH, x, y, BLACK, WHITE);
      }
    }

    // Paint 5-color calibration patches in the text strip (right edge).
    if (use5 && geom.patchCellPositions) {
      for (let k = 0; k < 5; k++) {
        const p = geom.patchCellPositions[k];
        for (let py = p.y0; py < p.y1; py++) {
          cells.fill(k, py * geom.WIDTH + p.x0, py * geom.WIDTH + p.x1);
        }
      }
    }

    return cells;
  }

  // ==========================================================================
  // Encoder pipeline: bytes → page-cell Uint8Arrays.
  // ==========================================================================
  function encodeBytes(bytes, opts) {
    const xcrosses  = (opts && opts.xcrosses) || 65;
    const ycrosses  = (opts && opts.ycrosses) || 93;
    // Derive colorMode and fecOrder, cross-defaulting each from the other.
    let colorMode = (opts && opts.colorMode) || 'mono';
    let fecOrder  = (opts && opts.fecOrder !== undefined) ? opts.fecOrder : FEC_ORDER;
    if (fecOrder === 12)              colorMode = '5color';
    if (fecOrder === 13)              colorMode = '5color-cmyk';
    if (colorMode === '5color')       fecOrder  = 12;
    if (colorMode === '5color-cmyk')  fecOrder  = 13;
    const useColor = (colorMode === '5color' || colorMode === '5color-cmyk');
    const useCRC   = (fecOrder === 11 || fecOrder === 12 || fecOrder === 13);
    const geom = makeGeometry(xcrosses, ycrosses, colorMode);
    // Per-page user-codeword count: one slot reserved for the CRC32 codeword
    // when CRC mode is on. Capacity drop is 1/FEC_SYMS ≈ 0.002% at A4.
    const userSlotsPerPage = useCRC ? geom.FEC_SYMS - 1 : geom.FEC_SYMS;
    const userBitsPerPage  = userSlotsPerPage * BCH_K;

    const totalBits = bytes.length * 8;
    const expectedPages = Math.max(1, Math.ceil(totalBits / userBitsPerPage));

    const pages = [];
    let cells = createBlankPage(geom);
    let symbolIndex = 0;
    let payloadAccu = 1n;
    const SENTINEL  = 1n << BigInt(BCH_K);
    const DATA_MASK = SENTINEL - 1n;
    let crc = useCRC ? makeBitwiseCrc32() : null;

    // Color mode: bits arrive at scattered seq positions (interleaved by the
    // BCH slot layout). We collect them into a flat buffer indexed by seq,
    // then pack the full buffer into base-5 chunks at endPage() time.
    // This preserves interleaving: chunk k covers seq k*16..(k+1)*16-1, which
    // are bit 0 of codewords k*16..(k+1)*16-1 — one bit from each of 16
    // different codewords — so a single misclassified chunk affects only 1 bit
    // per codeword and BCH corrects each independently.
    const colorBitBuf = useColor
      ? new Uint8Array(geom.FEC_SYMS * BCH_N + COLOR_CHUNK_BITS) : null;

    function writeChannelBit(bit, seq) {
      if (useColor) {
        colorBitBuf[seq] = bit & 1;
      } else {
        const xy = seq2xy(geom, seq);
        const x = xy[0] + BORDER;
        const y = xy[1] + BORDER;
        cells[x + y * geom.WIDTH] = (bit & 1) ? 0x00 : 0xff;
      }
    }

    function flushColorBitsToPage() {
      // Pack colorBitBuf into base-5 chunks, writing class ids into cells.
      const totalBCHBits = geom.FEC_SYMS * BCH_N;
      const numChunks = Math.ceil(totalBCHBits / COLOR_CHUNK_BITS);
      for (let ci = 0; ci < numChunks; ci++) {
        let N = 0;
        for (let b = 0; b < COLOR_CHUNK_BITS; b++) {
          const bseq = ci * COLOR_CHUNK_BITS + b;
          N = (N << 1) | (bseq < totalBCHBits ? colorBitBuf[bseq] : 0);
        }
        // Base-5-encode N (MSB-first) into 7 cells, LSDigit first.
        for (let di = 0; di < COLOR_CHUNK_CELLS; di++) {
          const classId = N % 5;
          N = (N / 5) | 0;
          const cellSeq = ci * COLOR_CHUNK_CELLS + di;
          const xy = seq2xy(geom, cellSeq);
          if (xy[0] >= 0) {
            cells[(xy[0] + BORDER) + (xy[1] + BORDER) * geom.WIDTH] = classId;
          }
        }
      }
    }

    // Encode `data` (45-bit BigInt) into BCH and write its 63 channel bits
    // to slot `slot` of the current page, interleaved across the FEC strips.
    function writeCodewordToSlot(data, slot) {
      const code = bchEncode(data);
      for (let shift = BCH_N - 1; shift >= 0; shift--) {
        const seq = slot + (BCH_N - 1 - shift) * geom.FEC_SYMS;
        const cb  = Number((code >> BigInt(shift)) & 1n);
        writeChannelBit(cb, seq);
      }
    }

    // Finalise the current page — pad any unfilled user slots with zeros
    // (so encoder/decoder feed the CRC the same number of bits), then write
    // the CRC codeword into the last slot.
    function endPage() {
      if (useCRC) {
        while (symbolIndex < geom.FEC_SYMS - 1) {
          for (let s = 0; s < BCH_K; s++) crc.consumeBit(0);
          symbolIndex++;
        }
        const crcValue = crc.finalize();
        const crcData  = BigInt(crcValue >>> 0); // low 32 bits → 45-bit slot
        writeCodewordToSlot(crcData, geom.FEC_SYMS - 1);
        crc = makeBitwiseCrc32();
      }
      // In color mode, pack the bit buffer into base-5 chunks in the cells array.
      if (useColor) {
        flushColorBitsToPage();
        colorBitBuf.fill(0); // reset for next page
      }
      pages.push(cells);
      cells = createBlankPage(geom);
      symbolIndex = 0;
    }

    function writePayloadBit(bit) {
      payloadAccu = (payloadAccu << 1n) | BigInt(bit & 1);
      if (payloadAccu & SENTINEL) {
        const data = payloadAccu & DATA_MASK;
        // Page full of user codewords? Close it (writes CRC, rolls page).
        if (symbolIndex >= userSlotsPerPage) endPage();
        writeCodewordToSlot(data, symbolIndex);
        if (useCRC) {
          for (let s = BCH_K - 1; s >= 0; s--) {
            crc.consumeBit(Number((data >> BigInt(s)) & 1n));
          }
        }
        symbolIndex++;
        payloadAccu = 1n;
      }
    }

    for (let i = 0; i < bytes.length; i++) {
      const b = bytes[i];
      for (let bit = 7; bit >= 0; bit--) writePayloadBit((b >>> bit) & 1);
    }
    for (let i = BCH_K - 1; i > 0; i--) writePayloadBit(0);
    endPage();

    // Attach fecOrder to geom so buildFormatString can read it.
    geom.fecOrder = fecOrder;

    return { geom, pages, nPages: pages.length, expectedPages, fecOrder, colorMode };
  }

  // ==========================================================================
  // Decoder pipeline — ImageData-shaped {width,height,data} → bytes.
  // Pure: no canvas, no FileReader. Caller supplies the pixel buffer.
  // ==========================================================================
  function imageDataToGray(imgData) {
    const d = imgData.data;
    const n = imgData.width * imgData.height;
    const out = new Uint8Array(n);
    for (let i = 0, j = 0; i < n; i++, j += 4) {
      out[i] = (d[j] * 299 + d[j + 1] * 587 + d[j + 2] * 114 + 500) / 1000 | 0;
    }
    return out;
  }

  // Extract one RGB channel (0=R, 1=G, 2=B) from an ImageData into a Uint8Array.
  function imageDataToChannel(imgData, channelIdx) {
    const d = imgData.data;
    const n = imgData.width * imgData.height;
    const out = new Uint8Array(n);
    for (let i = 0, j = channelIdx; i < n; i++, j += 4) out[i] = d[j];
    return out;
  }

  // Read the 5 calibration patches painted by createBlankPage and return their
  // mean (R,G,B) centroids. `crosses` gives the sync grid; for pixels in the
  // text strip (below the data area) we bilinear-interpolate from the page
  // corners rather than from the cross grid.
  function readPatchCentroids(imgData, geom, corners) {
    const W = imgData.width, H = imgData.height;
    const d = imgData.data;
    const scale = W / geom.WIDTH;  // pixels per cell
    const centroids = [];

    for (let k = 0; k < 5; k++) {
      const p = geom.patchCellPositions[k];
      // Convert cell coords to pixel coords (scale up), sample interior.
      const px0 = Math.round(p.x0 * scale);
      const py0 = Math.round(p.y0 * scale);
      const px1 = Math.round(p.x1 * scale);
      const py1 = Math.round(p.y1 * scale);
      let rSum = 0, gSum = 0, bSum = 0, cnt = 0;
      for (let py = py0; py < py1; py++) {
        for (let px = px0; px < px1; px++) {
          const idx = (py * W + px) * 4;
          rSum += d[idx]; gSum += d[idx + 1]; bSum += d[idx + 2];
          cnt++;
        }
      }
      if (cnt > 0) {
        centroids.push([rSum / cnt, gSum / cnt, bSum / cnt]);
      } else {
        centroids.push(paletteFor(geom.colorMode)[k].slice()); // fallback to nominal
      }
    }
    return centroids;
  }

  function analyzeCutlevel(gray) {
    const hist = new Uint32Array(256);
    for (let i = 0; i < gray.length; i++) hist[gray[i]]++;
    let total = 0;
    for (let i = 0; i < gray.length; i++) total += gray[i];
    const n = gray.length;
    let cut = ((total + (n >> 1)) / n) | 0;
    for (let iter = 0; iter < 32; iter++) {
      const last = cut;
      let whiteRms = 0, blackRms = 0;
      let blackPixels = 0, whitePixels = 0;
      for (let i = 0; i < cut; i++) {
        const d = cut - i;
        blackRms += hist[i] * d * d;
        blackPixels += hist[i];
      }
      for (let i = cut + 1; i < 256; i++) {
        const d = i - cut;
        whiteRms += hist[i] * d * d;
        whitePixels += hist[i];
      }
      if (whitePixels) whiteRms = Math.sqrt(whiteRms / whitePixels);
      if (blackPixels) blackRms = Math.sqrt(blackRms / blackPixels);
      const white = cut + whiteRms;
      const black = cut - blackRms;
      cut = Math.floor(white * SYNC_WHITE_CUT + black * (1 - SYNC_WHITE_CUT) + 0.5);
      if (cut === last) break;
    }
    return cut;
  }

  function getpixu(gray, W, H, x, y) {
    if (x < 0 || y < 0 || x >= W || y >= H) return 0xff;
    return gray[x + y * W];
  }

  function diagScan(gray, W, H, xstart, ystart, dx, dy, cut) {
    const limit = Math.min(W, H);
    for (let xb = xstart, len = 1;
         (dx > 0 ? xb < limit : xb >= 0) && len <= limit;
         xb += dx, len++) {
      let x = xb, y = ystart;
      for (let c = len; c > 0; c--, x -= dx, y += dy) {
        if (x < 0 || y < 0 || x >= W || y >= H) continue;
        if (gray[x + y * W] < cut) return [x, y];
      }
    }
    return null;
  }

  function findCorners(gray, W, H, cut) {
    const ul = diagScan(gray, W, H, 0,     0,     1,  1, cut);
    const ur = diagScan(gray, W, H, W - 1, 0,    -1,  1, cut);
    const ll = diagScan(gray, W, H, 0,     H - 1, 1, -1, cut);
    const lr = diagScan(gray, W, H, W - 1, H - 1, -1, -1, cut);
    if (!ul || !ur || !ll || !lr) {
      throw new Error('decoder: cannot find page corners');
    }
    return [
      [ul[0],     ul[1]],
      [ur[0] + 1, ur[1]],
      [ll[0],     ll[1] + 1],
      [lr[0] + 1, lr[1] + 1],
    ];
  }

  function computeVectors(corners, geom) {
    const ul = corners[0], ur = corners[1], ll = corners[2], lr = corners[3];
    let pixelhx = (ur[0] + lr[0] - ul[0] - ll[0]) / 2;
    let pixelhy = (ur[1] + lr[1] - ul[1] - ll[1]) / 2;
    let pixelvx = (ll[0] + lr[0] - ul[0] - ur[0]) / 2;
    let pixelvy = (ll[1] + lr[1] - ul[1] - ur[1]) / 2;
    const hl = Math.hypot(pixelhx, pixelhy);
    const vl = Math.hypot(pixelvx, pixelvy);
    pixelhx /= hl; pixelhy /= hl;
    pixelvx /= vl; pixelvy /= vl;
    const hpixel = ((ur[0] + lr[0] - ul[0] - ll[0]) / 2) / geom.WIDTH;
    const vpixel = ((ll[1] + lr[1] - ul[1] - ur[1]) / 2) / geom.HEIGHT;
    const chalf     = Math.max(1, Math.floor(Math.min(hpixel, vpixel) * CHALF * 0.5));
    const chalfFine = Math.max(1, Math.floor(Math.min(hpixel * (CHALF - CROSS_TRIM),
                                                      vpixel * (CHALF - CROSS_TRIM))));
    return { pixelhx, pixelhy, pixelvx, pixelvy, hpixel, vpixel, chalf, chalfFine };
  }

  function bilinear(ul, ur, ll, lr, hpar, vpar) {
    const u = ur * hpar + ul * (1 - hpar);
    const l = lr * hpar + ll * (1 - hpar);
    return l * vpar + u * (1 - vpar);
  }

  function getPixelInterp(gray, W, H, x, y) {
    const xi = x < 0 ? 0 : Math.floor(x);
    const yi = y < 0 ? 0 : Math.floor(y);
    return bilinear(
      getpixu(gray, W, H, xi,     yi),
      getpixu(gray, W, H, xi + 1, yi),
      getpixu(gray, W, H, xi,     yi + 1),
      getpixu(gray, W, H, xi + 1, yi + 1),
      x - xi, y - yi);
  }

  function crossCorrel(gray, W, H, v, globalCut, cx, cy) {
    let sum = 0;
    const ch = v.chalfFine;
    for (let dy = 0; dy < ch; dy++) {
      for (let dx = 0; dx < ch; dx++) {
        sum -= getPixelInterp(gray, W, H, cx + dx,         cy + dy)         - globalCut;
        sum -= getPixelInterp(gray, W, H, cx - 1 - dx,     cy - 1 - dy)     - globalCut;
        sum += getPixelInterp(gray, W, H, cx + dx,         cy - 1 - dy)     - globalCut;
        sum += getPixelInterp(gray, W, H, cx - 1 - dx,     cy + dy)         - globalCut;
      }
    }
    return sum;
  }

  function resyncCross(gray, W, H, v, globalCut, coord) {
    const phx = v.pixelhx, phy = v.pixelhy, pvx = v.pixelvx, pvy = v.pixelvy;
    const ch = v.chalf;
    let bestX = coord[0], bestY = coord[1];
    let best = crossCorrel(gray, W, H, v, globalCut, bestX, bestY);
    for (let xoff = -ch; xoff <= ch; xoff++) {
      for (let yoff = -ch; yoff <= ch; yoff++) {
        const sx = coord[0] + xoff * phx + yoff * pvx;
        const sy = coord[1] + xoff * phy + yoff * pvy;
        const r = crossCorrel(gray, W, H, v, globalCut, sx, sy);
        if (r > best) { best = r; bestX = sx; bestY = sy; }
      }
    }
    const HALFRANGE = Math.floor(0.5 / FINESTEP);
    let fx = bestX, fy = bestY;
    best = crossCorrel(gray, W, H, v, globalCut, fx, fy);
    for (let xoff = -HALFRANGE; xoff <= HALFRANGE; xoff++) {
      for (let yoff = -HALFRANGE; yoff <= HALFRANGE; yoff++) {
        const sx = bestX + xoff * FINESTEP * phx + yoff * FINESTEP * pvx;
        const sy = bestY + xoff * FINESTEP * phy + yoff * FINESTEP * pvy;
        const r = crossCorrel(gray, W, H, v, globalCut, sx, sy);
        if (r > best) { best = r; fx = sx; fy = sy; }
      }
    }
    coord[0] = fx;
    coord[1] = fy;
  }

  function crossStats(gray, W, H, v, globalCut, cx, cy) {
    const hh = Math.floor(v.hpixel * (CHALF - CROSS_TRIM));
    const vh = Math.floor(v.vpixel * (CHALF - CROSS_TRIM));
    let whiteRms = 0, blackRms = 0;
    let whitePix = 0, blackPix = 0;
    for (let xoff = -hh; xoff <= hh; xoff++) {
      for (let yoff = -vh; yoff <= vh; yoff++) {
        const sx = cx + xoff * v.pixelhx + yoff * v.pixelvx;
        const sy = cy + xoff * v.pixelhy + yoff * v.pixelvy;
        const val = getPixelInterp(gray, W, H, sx, sy);
        if (val > globalCut)      { const d = val - globalCut; whiteRms += d * d; whitePix++; }
        else if (val < globalCut) { const d = val - globalCut; blackRms += d * d; blackPix++; }
      }
    }
    if (!whitePix || !blackPix) return globalCut;
    whiteRms = Math.sqrt(whiteRms / whitePix);
    blackRms = Math.sqrt(blackRms / blackPix);
    const white = globalCut + whiteRms;
    const black = globalCut - blackRms;
    return white * WHITE_CUT + black * (1 - WHITE_CUT);
  }

  function syncCrosses(gray, W, H, corners, v, geom, globalCut) {
    const xc = geom.xcrosses, yc = geom.ycrosses;
    const crosses = new Array(xc);
    const cutlevels = new Array(xc);
    for (let i = 0; i < xc; i++) {
      crosses[i] = new Array(yc);
      cutlevels[i] = new Float32Array(yc);
      for (let j = 0; j < yc; j++) crosses[i][j] = [0, 0];
    }
    const rightx = ((corners[1][0] + corners[3][0] - corners[0][0] - corners[2][0]) / 2) * CPITCH / geom.WIDTH;
    const righty = ((corners[1][1] + corners[3][1] - corners[0][1] - corners[2][1]) / 2) * CPITCH / geom.WIDTH;
    const downx  = ((corners[2][0] + corners[3][0] - corners[0][0] - corners[1][0]) / 2) * CPITCH / geom.HEIGHT;
    const downy  = ((corners[2][1] + corners[3][1] - corners[0][1] - corners[1][1]) / 2) * CPITCH / geom.HEIGHT;
    const fx = (BORDER + CHALF) / geom.WIDTH;
    const fy = (BORDER + CHALF) / geom.HEIGHT;
    crosses[0][0][0] = bilinear(corners[0][0], corners[1][0], corners[2][0], corners[3][0], fx, fy);
    crosses[0][0][1] = bilinear(corners[0][1], corners[1][1], corners[2][1], corners[3][1], fx, fy);

    for (let cy = 0; cy < yc; cy++) {
      for (let cx = 0; cx < xc; cx++) {
        if (cx > 0) {
          crosses[cx][cy][0] = crosses[cx - 1][cy][0] + rightx;
          crosses[cx][cy][1] = crosses[cx - 1][cy][1] + righty;
        } else if (cy > 0) {
          crosses[cx][cy][0] = crosses[cx][cy - 1][0] + downx;
          crosses[cx][cy][1] = crosses[cx][cy - 1][1] + downy;
        }
        resyncCross(gray, W, H, v, globalCut, crosses[cx][cy]);
        cutlevels[cx][cy] = crossStats(gray, W, H, v, globalCut,
                                        crosses[cx][cy][0], crosses[cx][cy][1]);
      }
    }
    return { crosses, cutlevels };
  }

  function bitCoord(crosses, cutlevels, xb, yb, geom, out) {
    let cx = xb < CHALF ? 0 : ((xb - CHALF) / CPITCH) | 0;
    let cy = yb < CHALF ? 0 : ((yb - CHALF) / CPITCH) | 0;
    if (cx > geom.xcrosses - 2) cx = geom.xcrosses - 2;
    if (cy > geom.ycrosses - 2) cy = geom.ycrosses - 2;
    const rx = xb - (cx * CPITCH + CHALF);
    const ry = yb - (cy * CPITCH + CHALF);
    const xrem = (rx + 0.5) / CPITCH;
    const yrem = (ry + 0.5) / CPITCH;
    const c00 = crosses[cx][cy], c10 = crosses[cx + 1][cy];
    const c01 = crosses[cx][cy + 1], c11 = crosses[cx + 1][cy + 1];
    out[0] = bilinear(c00[0], c10[0], c01[0], c11[0], xrem, yrem) - 0.5;
    out[1] = bilinear(c00[1], c10[1], c01[1], c11[1], xrem, yrem) - 0.5;
    out[2] = bilinear(cutlevels[cx][cy], cutlevels[cx + 1][cy],
                      cutlevels[cx][cy + 1], cutlevels[cx + 1][cy + 1],
                      xrem, yrem);
  }

  // decodeImageData: decode a single page.
  //
  // For multi-page payloads where `NETBITS` isn't a multiple of 8 (any
  // non-default XCROSSES/YCROSSES will hit this), bits straddling page
  // boundaries would be lost between calls. Pass `opts.state = { payloadAccu: 1 }`
  // to thread the byte accumulator across pages — `bytes` then contains
  // exactly what this page emitted (variable length), and the caller
  // concatenates per-page outputs.
  function decodeImageData(imgData, opts) {
    const xcrosses = (opts && opts.xcrosses) || 65;
    const ycrosses = (opts && opts.ycrosses) || 93;
    // Derive colorMode and fecOrder, cross-defaulting each from the other.
    let colorMode = (opts && opts.colorMode) || 'mono';
    let fecOrder  = (opts && opts.fecOrder !== undefined) ? opts.fecOrder : FEC_ORDER;
    if (fecOrder === 12)              colorMode = '5color';
    if (fecOrder === 13)              colorMode = '5color-cmyk';
    if (colorMode === '5color')       fecOrder  = 12;
    if (colorMode === '5color-cmyk')  fecOrder  = 13;
    const useColor = (colorMode === '5color' || colorMode === '5color-cmyk');
    const useCRC   = (fecOrder === 11 || fecOrder === 12 || fecOrder === 13);
    const geom = makeGeometry(xcrosses, ycrosses, colorMode);
    const userSlots = useCRC ? geom.FEC_SYMS - 1 : geom.FEC_SYMS;

    const W = imgData.width;
    const H = imgData.height;
    const gray = imageDataToGray(imgData);

    const globalCut = analyzeCutlevel(gray);
    const corners   = findCorners(gray, W, H, globalCut);
    const vectors   = computeVectors(corners, geom);
    const sync      = syncCrosses(gray, W, H, corners, vectors, geom, globalCut);
    const crosses   = sync.crosses;
    const cutlevels = sync.cutlevels;

    // 5-color: pre-extract RGB channels and read calibration patch centroids.
    let chanR, chanG, chanB, centroids;
    if (useColor) {
      chanR     = imageDataToChannel(imgData, 0);
      chanG     = imageDataToChannel(imgData, 1);
      chanB     = imageDataToChannel(imgData, 2);
      centroids = readPatchCentroids(imgData, geom, corners);
    }

    const errorStats = [0, 0, 0, 0, 0];
    let chunkErrors  = 0;
    const out = new Uint8Array(Math.ceil((geom.NETBITS + 7) / 8));
    let outIndex = 0;
    const state = (opts && opts.state) || null;
    let payloadAccu = state ? state.payloadAccu : 1;
    const xy   = [0, 0];
    const xyc  = [0, 0, 0];
    const crc  = useCRC ? makeBitwiseCrc32() : null;

    // Color mode: random-access bit reader via a lazy chunk cache.
    // The encoder writes BCH bit at stream position `seq = slot + b*FEC_SYMS`
    // into chunk `floor(seq / COLOR_CHUNK_BITS)` at bit offset `seq % COLOR_CHUNK_BITS`.
    // We cache decoded chunks so each is classified only once per page.
    const colorChunkCache = useColor ? new Int32Array(
      Math.ceil(geom.FEC_SYMS * BCH_N / COLOR_CHUNK_BITS) + 1).fill(-1) : null;

    function getDecodedChunk(chunkIdx) {
      if (colorChunkCache[chunkIdx] >= 0) return colorChunkCache[chunkIdx];
      let N = 0;
      for (let di = COLOR_CHUNK_CELLS - 1; di >= 0; di--) {
        const cellSeq = chunkIdx * COLOR_CHUNK_CELLS + di;
        seq2xyInto(geom, cellSeq, xy);
        bitCoord(crosses, cutlevels, xy[0], xy[1], geom, xyc);
        const rs = getPixelInterp(chanR, W, H, xyc[0], xyc[1]);
        const gs = getPixelInterp(chanG, W, H, xyc[0], xyc[1]);
        const bs = getPixelInterp(chanB, W, H, xyc[0], xyc[1]);
        let bestClass = 0, bestDist = Infinity;
        for (let k = 0; k < 5; k++) {
          const dr = rs - centroids[k][0];
          const dg = gs - centroids[k][1];
          const db = bs - centroids[k][2];
          const dist = dr * dr + dg * dg + db * db;
          if (dist < bestDist) { bestDist = dist; bestClass = k; }
        }
        N = N * 5 + bestClass;
      }
      if (N >= (1 << COLOR_CHUNK_BITS)) { N &= (1 << COLOR_CHUNK_BITS) - 1; chunkErrors++; }
      colorChunkCache[chunkIdx] = N;
      return N;
    }

    function getColorBit(seq) {
      const chunkIdx = (seq / COLOR_CHUNK_BITS) | 0;
      const bitPos   = seq % COLOR_CHUNK_BITS;              // 0 = MSB
      const chunk    = getDecodedChunk(chunkIdx);
      return (chunk >> (COLOR_CHUNK_BITS - 1 - bitPos)) & 1;
    }

    function readCodeword(slot) {
      let received = 0n;
      if (useColor) {
        for (let bit = 0; bit < BCH_N; bit++) {
          const seq = slot + bit * geom.FEC_SYMS;
          received = (received << 1n) | BigInt(getColorBit(seq));
        }
      } else {
        for (let bit = 0; bit < BCH_N; bit++) {
          const seq = slot + bit * geom.FEC_SYMS;
          seq2xyInto(geom, seq, xy);
          bitCoord(crosses, cutlevels, xy[0], xy[1], geom, xyc);
          const sample = getPixelInterp(gray, W, H, xyc[0], xyc[1]);
          received = (received << 1n) | (sample < xyc[2] ? 1n : 0n);
        }
      }
      return bchDecode(received);
    }

    // User-data slots: emit decoded bits to the byte stream (state-threaded)
    // and feed them into the CRC accumulator.
    for (let sym = 0; sym < userSlots; sym++) {
      const dec = readCodeword(sym);
      errorStats[dec.reparable ? Math.min(3, dec.errors) : 4]++;
      const dataBig = BigInt(dec.data);
      for (let shift = BCH_K - 1; shift >= 0; shift--) {
        const b = Number((dataBig >> BigInt(shift)) & 1n);
        if (useCRC) crc.consumeBit(b);
        payloadAccu = ((payloadAccu << 1) | b) & 0x1ff;
        if (payloadAccu & 0x100) {
          out[outIndex++] = payloadAccu & 0xff;
          payloadAccu = 1;
        }
      }
    }
    if (state) state.payloadAccu = payloadAccu;

    let crcOk = null, storedCRC = null, computedCRC = null;
    if (useCRC) {
      computedCRC = crc.finalize();
      const crcDec = readCodeword(geom.FEC_SYMS - 1);
      errorStats[crcDec.reparable ? Math.min(3, crcDec.errors) : 4]++;
      // Stored CRC sits in the low 32 bits of the codeword's 45-bit data.
      storedCRC = Number(BigInt(crcDec.data) & 0xFFFFFFFFn);
      crcOk = storedCRC === computedCRC;
    }

    return {
      geom, bytes: out.subarray(0, outIndex),
      stats: { errors: errorStats, crcOk, storedCRC, computedCRC, chunkErrors },
      fecOrder, colorMode, corners, crosses, globalCut, centroids: centroids || null,
    };
  }

  // ==========================================================================
  // Per-file payload header.
  //
  // OPTR (legacy, uncompressed):
  //   "OPTR"     4 B  magic
  //   sha256    32 B  digest of file-data
  //   filename   n B  UTF-8
  //   NUL        1 B  filename terminator
  //   file-data  …    bytes; trailing zero-byte FEC padding stripped at
  //                   decode time and verified against the SHA-256.
  //
  // OPTZ (gzipped, explicit length — preferred when it shrinks the payload):
  //   "OPTZ"     4 B  magic
  //   sha256    32 B  digest of the *uncompressed* file-data
  //   filename   n B  UTF-8
  //   NUL        1 B  filename terminator
  //   bodylen    4 B  uint32 LE length of the gzip stream that follows
  //   gzip-data  …    raw gzip stream of length `bodylen`; any bytes after
  //                   it (BCH-page zero padding) are ignored. The explicit
  //                   length avoids the OPTR trim-trailing-zeros hazard,
  //                   since gzip's ISIZE trailer often ends in 0x00.
  // ==========================================================================
  async function sha256Bytes(bytes) {
    if (typeof crypto !== 'undefined' && crypto.subtle && crypto.subtle.digest) {
      const buf = await crypto.subtle.digest('SHA-256', bytes);
      return new Uint8Array(buf);
    }
    if (typeof require === 'function') {
      const { createHash } = require('crypto');
      return new Uint8Array(createHash('sha256').update(bytes).digest());
    }
    throw new Error('no SHA-256 implementation available in this environment');
  }

  function hexBytes(u8) {
    let s = '';
    for (let i = 0; i < u8.length; i++) s += u8[i].toString(16).padStart(2, '0');
    return s;
  }

  // gzipBytes / gunzipBytes — browser CompressionStream first, Node zlib fallback.
  async function gzipBytes(bytes) {
    if (typeof CompressionStream !== 'undefined') {
      const cs = new CompressionStream('gzip');
      const writer = cs.writable.getWriter();
      writer.write(bytes);
      writer.close();
      const reader = cs.readable.getReader();
      const chunks = [];
      let total = 0;
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        chunks.push(value);
        total += value.length;
      }
      const out = new Uint8Array(total);
      let off = 0;
      for (const c of chunks) { out.set(c, off); off += c.length; }
      return out;
    }
    if (typeof require === 'function') {
      const { gzipSync } = require('zlib');
      return new Uint8Array(gzipSync(bytes));
    }
    throw new Error('no gzip implementation available');
  }

  async function gunzipBytes(bytes) {
    if (typeof DecompressionStream !== 'undefined') {
      const ds = new DecompressionStream('gzip');
      const writer = ds.writable.getWriter();
      writer.write(bytes);
      writer.close();
      const reader = ds.readable.getReader();
      const chunks = [];
      let total = 0;
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        chunks.push(value);
        total += value.length;
      }
      const out = new Uint8Array(total);
      let off = 0;
      for (const c of chunks) { out.set(c, off); off += c.length; }
      return out;
    }
    if (typeof require === 'function') {
      const { gunzipSync } = require('zlib');
      return new Uint8Array(gunzipSync(bytes));
    }
    throw new Error('no gunzip implementation available');
  }

  async function wrapWithHeader(fileBytes, filename) {
    const nameUtf8 = new TextEncoder().encode(filename || '');
    for (let i = 0; i < nameUtf8.length; i++) {
      if (nameUtf8[i] === 0) throw new Error('filename cannot contain a NUL byte');
    }
    const digest = await sha256Bytes(fileBytes);
    const compressed = await gzipBytes(fileBytes);

    // Use OPTZ only when gzip actually shrinks the payload (after accounting
    // for the 4-byte length prefix). Already-compressed inputs (JPEG, MP4,
    // .gz) fall back to OPTR so we don't waste page capacity.
    const optzCost = 4 /* length field */ + compressed.length;
    if (optzCost < fileBytes.length) {
      const out = new Uint8Array(4 + 32 + nameUtf8.length + 1 + 4 + compressed.length);
      let p = 0;
      for (let i = 0; i < 4; i++) out[p++] = SLOPTAR_HEADER_MAGIC_Z[i];
      out.set(digest, p);   p += 32;
      out.set(nameUtf8, p); p += nameUtf8.length;
      out[p++] = 0;
      const L = compressed.length;
      out[p++] =  L        & 0xff;
      out[p++] = (L >>> 8)  & 0xff;
      out[p++] = (L >>> 16) & 0xff;
      out[p++] = (L >>> 24) & 0xff;
      out.set(compressed, p);
      return out;
    }
    const out = new Uint8Array(4 + 32 + nameUtf8.length + 1 + fileBytes.length);
    let p = 0;
    for (let i = 0; i < 4; i++) out[p++] = SLOPTAR_HEADER_MAGIC[i];
    out.set(digest, p);   p += 32;
    out.set(nameUtf8, p); p += nameUtf8.length;
    out[p++] = 0;
    out.set(fileBytes, p);
    return out;
  }

  async function unwrapHeader(decodedBytes) {
    const minSize = 4 + 32 + 1;
    if (decodedBytes.length < minSize) return { hasHeader: false, body: decodedBytes };

    let isGzip = false;
    let magicOk = true;
    for (let i = 0; i < 4; i++) {
      if (decodedBytes[i] !== SLOPTAR_HEADER_MAGIC[i]) { magicOk = false; break; }
    }
    if (!magicOk) {
      magicOk = true;
      for (let i = 0; i < 4; i++) {
        if (decodedBytes[i] !== SLOPTAR_HEADER_MAGIC_Z[i]) { magicOk = false; break; }
      }
      if (magicOk) isGzip = true;
    }
    if (!magicOk) return { hasHeader: false, body: decodedBytes };

    const sha = decodedBytes.subarray(4, 36);
    let nameEnd = 36;
    while (nameEnd < decodedBytes.length && decodedBytes[nameEnd] !== 0) nameEnd++;
    if (nameEnd >= decodedBytes.length) {
      return { hasHeader: true, error: 'filename has no NUL terminator',
               body: new Uint8Array(0) };
    }
    const filename = new TextDecoder('utf-8', { fatal: false })
      .decode(decodedBytes.subarray(36, nameEnd));
    const dataStart = nameEnd + 1;

    let body;
    if (isGzip) {
      if (dataStart + 4 > decodedBytes.length) {
        return { hasHeader: true, filename, sha256: hexBytes(sha),
                 error: 'truncated OPTZ length prefix',
                 body: new Uint8Array(0), hashOk: false };
      }
      const L = (decodedBytes[dataStart]            ) |
                (decodedBytes[dataStart + 1] <<  8  ) |
                (decodedBytes[dataStart + 2] << 16  ) |
                (decodedBytes[dataStart + 3] << 24  );
      const lengthU = L >>> 0;
      const bodyStart = dataStart + 4;
      const bodyEnd   = bodyStart + lengthU;
      if (bodyEnd > decodedBytes.length) {
        return { hasHeader: true, filename, sha256: hexBytes(sha),
                 error: 'truncated OPTZ body (declared ' + lengthU + ' bytes)',
                 body: new Uint8Array(0), hashOk: false };
      }
      const compressed = decodedBytes.subarray(bodyStart, bodyEnd);
      try {
        body = await gunzipBytes(compressed);
      } catch (e) {
        return { hasHeader: true, filename, sha256: hexBytes(sha),
                 error: 'gunzip failed: ' + (e && e.message),
                 body: new Uint8Array(0), hashOk: false };
      }
    } else {
      let dataEnd = decodedBytes.length;
      while (dataEnd > dataStart && decodedBytes[dataEnd - 1] === 0) dataEnd--;
      body = decodedBytes.subarray(dataStart, dataEnd);
    }

    const computed = await sha256Bytes(body);
    let hashOk = true;
    for (let i = 0; i < 32; i++) if (computed[i] !== sha[i]) { hashOk = false; break; }
    return { hasHeader: true, filename, sha256: hexBytes(sha), body, hashOk,
             compressed: isGzip };
  }

  // ==========================================================================
  // Format-string utilities.
  // ==========================================================================
  function buildFormatString(geom, pageNumber, totalPages, label) {
    const fo = (geom && geom.fecOrder != null) ? geom.fecOrder : FEC_ORDER;
    const core = `0-${geom.xcrosses}-${geom.ycrosses}-${CPITCH}-${CHALF}-${fo}-${BORDER}-${TEXT_HEIGHT}`;
    return `${core} ${pageNumber}/${totalPages} ${label || ''}`.trim();
  }

  function parseFormatString(s) {
    const head = s.trim().split(/\s+/)[0] || '';
    const parts = head.split('-');
    if (parts.length >= 8) {
      const xcrosses = parseInt(parts[1], 10);
      const ycrosses = parseInt(parts[2], 10);
      const fecOrder = parseInt(parts[5], 10);
      if (Number.isFinite(xcrosses) && Number.isFinite(ycrosses)) {
        return {
          xcrosses, ycrosses,
          fecOrder: Number.isFinite(fecOrder) ? fecOrder : FEC_ORDER,
        };
      }
    }
    return null;
  }

  // ==========================================================================
  // Frame-stitching for streaming-mode video decode.
  // Pure: takes plain {width,height,data} ImageData-shaped frames.
  // ==========================================================================
  // stitchFrames — two passes:
  //   1. Standalone-decode each frame, hash the bytes, dedup, accept-or-reject.
  //   2. Re-decode the unique frames in order with payloadAccu state threaded
  //      across them; concat the per-page outputs. Threading is needed for
  //      configurations where NETBITS isn't a multiple of 8 (any non-default
  //      XCROSSES/YCROSSES); for byte-aligned configs the result is identical
  //      to single-pass concat.
  async function stitchFrames(frames, opts) {
    const xcrosses  = (opts && opts.xcrosses) || 65;
    const ycrosses  = (opts && opts.ycrosses) || 93;
    const fecOrder  = (opts && opts.fecOrder !== undefined) ? opts.fecOrder : FEC_ORDER;
    const colorMode = (opts && opts.colorMode) || (fecOrder === 12 ? '5color' : fecOrder === 13 ? '5color-cmyk' : 'mono');
    const onProgress = opts && opts.onProgress;

    const seen = new Set();
    const uniqueFrames = [];
    let unique = 0, dupes = 0, failed = 0;

    for (let f = 0; f < frames.length; f++) {
      if (onProgress) onProgress(f, frames.length);
      let dec;
      try {
        dec = decodeImageData(frames[f], { xcrosses, ycrosses, fecOrder, colorMode });
      } catch (_) { failed++; continue; }

      const e = dec.stats.errors;
      const totalSyms = e[0] + e[1] + e[2] + e[3] + e[4];
      const nonzero  = totalSyms - e[0];
      if (e[4] > totalSyms * 0.05 || nonzero > totalSyms * 0.5) {
        failed++; continue;
      }
      // CRC mode? If the page's CRC32 doesn't match, the BCH must have
      // miscorrected somewhere — drop the frame outright.
      if (dec.stats.crcOk === false) { failed++; continue; }
      const distinct = new Set();
      const probeLen = Math.min(dec.bytes.length, 1024);
      for (let i = 0; i < probeLen; i++) {
        distinct.add(dec.bytes[i]);
        if (distinct.size >= 32) break;
      }
      if (distinct.size < 12) { failed++; continue; }

      const hashBuf = await sha256Bytes(dec.bytes);
      const hashHex = hexBytes(hashBuf);
      if (seen.has(hashHex)) { dupes++; continue; }
      seen.add(hashHex);
      uniqueFrames.push(frames[f]);
      unique++;
    }
    if (onProgress) onProgress(frames.length, frames.length);

    // State-threaded concat. For byte-aligned NETBITS this is a no-op.
    const state = { payloadAccu: 1 };
    const aggStats = [0, 0, 0, 0, 0];
    let crcPagesOk = 0, crcPagesFail = 0;
    const chunks = [];
    let total = 0;
    for (const frame of uniqueFrames) {
      const dec = decodeImageData(frame, { xcrosses, ycrosses, fecOrder, colorMode, state });
      for (let k = 0; k < 5; k++) aggStats[k] += dec.stats.errors[k];
      if      (dec.stats.crcOk === true)  crcPagesOk++;
      else if (dec.stats.crcOk === false) crcPagesFail++;
      chunks.push(dec.bytes);
      total += dec.bytes.length;
    }
    const merged = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) { merged.set(c, off); off += c.length; }

    return {
      bytes: merged,
      stats: { errors: aggStats, crcPagesOk, crcPagesFail },
      unique, dupes, failed,
      framesIn: frames.length,
    };
  }

  // ==========================================================================
  // Public API.
  // ==========================================================================
  return {
    // Constants
    BORDER, CHALF, CPITCH, TEXT_HEIGHT, FEC_LARGEBITS, FEC_SMALLBITS, FEC_ORDER,
    DEFAULT_SCALE,
    BCH_M, BCH_N, BCH_K, BCH_T, BCH_PARITY, BCH_GEN,
    SLOPTAR_HEADER_MAGIC, SLOPTAR_HEADER_MAGIC_Z,
    // 5-color constants
    PALETTE_5COLOR, PALETTE_5COLOR_RGB, PALETTE_5COLOR_CMYK, paletteFor,
    COLOR_CHUNK_BITS, COLOR_CHUNK_CELLS, PATCH_W, PATCH_H,
    // Geometry
    makeGeometry, seq2xy, seq2xyInto,
    // BCH
    bchEncode, bchDecode, bchSyndromes, bchGfMul, bchGfDiv,
    BCH_GF_EXP, BCH_GF_LOG,
    // CRC32
    crc32, makeBitwiseCrc32,
    // Interleave
    interleaveBits, deinterleaveBits,
    // Page rendering (pure cells array — no canvas)
    createBlankPage, drawCross,
    // Decoder helpers
    imageDataToGray, imageDataToChannel, readPatchCentroids,
    // Pipelines
    encodeBytes, decodeImageData,
    // Header
    sha256Bytes, hexBytes, gzipBytes, gunzipBytes, wrapWithHeader, unwrapHeader,
    // Format string
    buildFormatString, parseFormatString,
    // Streaming-mode stitch
    stitchFrames,
  };
}));
