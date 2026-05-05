// Node-direct codec test: requires optar-codec.js as a CommonJS module and
// proves the codec works without any browser, canvas, or DOM at all. The
// decoder takes a structurally-typed ImageData ({width, height, data}); we
// build one by hand from the encoder's page-cells array, no image library
// needed.
'use strict';

const path = require('path');
const crypto = require('crypto');
const optar = require(path.resolve(__dirname, '..', 'browser', 'optar-codec.js'));

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }
function assertEqual(a, b, msg) {
  if (a !== b) throw new Error(`${msg || ''}\n  expected: ${b}\n    actual: ${a}`);
}

// Render page cells to a fake ImageData. Routes by geom.colorMode:
//   mono: cells hold 0x00/0xff → R=G=B=cell
//   5color: cells hold palette ids 0..4 → map via PALETTE_5COLOR
function cellsToImageData(cells, geom) {
  const W = geom.WIDTH, H = geom.HEIGHT;
  const data = new Uint8ClampedArray(W * H * 4);
  if (geom.colorMode === '5color') {
    const PAL = [[255,255,255],[255,0,0],[0,255,0],[0,0,255],[0,0,0]];
    for (let i = 0, j = 0; i < W * H; i++, j += 4) {
      const [r, g, b] = PAL[cells[i]];
      data[j] = r; data[j + 1] = g; data[j + 2] = b; data[j + 3] = 255;
    }
  } else {
    for (let i = 0, j = 0; i < cells.length; i++, j += 4) {
      const v = cells[i];
      data[j] = v; data[j + 1] = v; data[j + 2] = v; data[j + 3] = 255;
    }
  }
  return { width: W, height: H, data };
}

// ----------------------------------------------------------------------------
test('codec loads as a CommonJS module', () => {
  // Spot-check the public surface — no DOM was used to load this.
  for (const k of [
    'makeGeometry', 'encodeBytes', 'decodeImageData',
    'wrapWithHeader', 'unwrapHeader', 'stitchFrames',
    'bchEncode', 'bchDecode', 'buildFormatString', 'parseFormatString',
    'BCH_N', 'BCH_K', 'FEC_ORDER',
  ]) {
    assert(k in optar, `optar.${k} must be exported`);
  }
  assertEqual(optar.BCH_N, 63);
  assertEqual(optar.BCH_K, 45);
  assertEqual(optar.FEC_ORDER, 11);
});

test('BCH round-trip: 1000 random 45-bit data words decode cleanly', () => {
  for (let i = 0; i < 1000; i++) {
    const hi = Math.floor(Math.random() * (1 << 13));
    const lo = Math.floor(Math.random() * 0x100000000);
    const data = (BigInt(hi) << 32n) | BigInt(lo >>> 0);
    const code = optar.bchEncode(data);
    const dec = optar.bchDecode(code);
    if (BigInt(dec.data) !== data || dec.errors !== 0) {
      throw new Error(`BCH round-trip failed at i=${i}: data=${data}, decoded=${dec.data}, errors=${dec.errors}`);
    }
  }
});

test('header wrap + unwrap round-trips bytes & filename in Node', async () => {
  const input = crypto.randomBytes(1024);
  // Force last byte non-zero so the trim-trailing-zeros body extraction
  // doesn't eat it (documented limitation of the OPTR format).
  if (input[input.length - 1] === 0) input[input.length - 1] = 0xff;
  const wrapped = await optar.wrapWithHeader(input, 'node-test.bin');
  const u = await optar.unwrapHeader(wrapped);
  assert(u.hasHeader);
  assertEqual(u.filename, 'node-test.bin');
  assert(u.hashOk, 'SHA-256 must verify in Node');
  assertEqual(Buffer.compare(Buffer.from(u.body), input), 0);
  // Random bytes are incompressible — encoder falls back to OPTR.
  assertEqual(u.compressed, false, 'random input must take the OPTR path');
});

test('gzipBytes / gunzipBytes round-trip in Node', async () => {
  const input = Buffer.from('hello world '.repeat(200));
  const z = await optar.gzipBytes(input);
  assert(z.length < input.length, 'compressible text must shrink');
  const back = await optar.gunzipBytes(z);
  assertEqual(Buffer.compare(Buffer.from(back), input), 0);
});

test('OPTZ wrap takes compressible payloads through the gzip path', async () => {
  // Highly compressible: 4096 zeros (also ends in 0 — would historically
  // bait the OPTR trim-trailing-zeros bug, here irrelevant since OPTZ
  // uses an explicit length prefix).
  const input = Buffer.alloc(4096, 0);
  const wrapped = await optar.wrapWithHeader(input, 'zeros.bin');
  const u = await optar.unwrapHeader(wrapped);
  assert(u.hasHeader);
  assertEqual(u.compressed, true, 'all-zeros payload must use OPTZ');
  assert(wrapped.length < input.length, 'OPTZ payload must be smaller than the input');
  assert(u.hashOk, 'SHA-256 (over uncompressed) must verify');
  assertEqual(u.filename, 'zeros.bin');
  assertEqual(u.body.length, input.length);
  assertEqual(Buffer.compare(Buffer.from(u.body), input), 0);
});

test('OPTZ survives BCH-padding zeros after the explicit length', async () => {
  // Build a wrapped OPTZ payload, then append 200 zero bytes (mimicking
  // the per-page zero pad the BCH layer prepends to incomplete pages).
  // unwrapHeader must ignore them via the explicit length prefix.
  const input = Buffer.from('the quick brown fox '.repeat(50));
  const wrapped = await optar.wrapWithHeader(input, 'pad.txt');
  const padded = Buffer.concat([Buffer.from(wrapped), Buffer.alloc(200, 0)]);
  const u = await optar.unwrapHeader(new Uint8Array(padded));
  assert(u.compressed === true);
  assert(u.hashOk, 'SHA-256 must verify even with trailing zero padding');
  assertEqual(Buffer.compare(Buffer.from(u.body), input), 0);
});

test('OPTR (legacy) payloads still decode after the OPTZ feature lands', async () => {
  // Hand-craft an OPTR-formatted payload — older optar prints/files must
  // still round-trip through the new unwrapHeader.
  const fileBytes = Buffer.from('legacy bytes — OPTR forever\n');
  const digest = await optar.sha256Bytes(fileBytes);
  const name = Buffer.from('legacy.txt');
  const optr = Buffer.concat([
    Buffer.from(optar.OPTAR_HEADER_MAGIC),
    Buffer.from(digest),
    name,
    Buffer.from([0]),
    fileBytes,
  ]);
  const u = await optar.unwrapHeader(new Uint8Array(optr));
  assert(u.hasHeader);
  assertEqual(u.compressed, false);
  assert(u.hashOk);
  assertEqual(u.filename, 'legacy.txt');
  assertEqual(Buffer.compare(Buffer.from(u.body), fileBytes), 0);
});

test('end-to-end encode→decode in Node (no canvas, no browser)', async () => {
  const settings = { xcrosses: 33, ycrosses: 47 };
  const N = 4096;
  const input = crypto.randomBytes(N);
  if (input[N - 1] === 0) input[N - 1] = 0xff;

  const wrapped = await optar.wrapWithHeader(input, 'node-roundtrip.bin');
  const enc = optar.encodeBytes(wrapped, settings);
  assertEqual(enc.pages.length, 1);

  // Hand-built ImageData from page cells — no canvas dependency.
  const imgData = cellsToImageData(enc.pages[0], enc.geom);
  const dec = optar.decodeImageData(imgData, settings);

  // No errors on a clean self-rendered page.
  assertEqual(dec.stats.errors[4], 0, 'irreparable count must be zero');

  const unwrapped = await optar.unwrapHeader(dec.bytes);
  assert(unwrapped.hasHeader, 'OPTR header must survive the round-trip');
  assert(unwrapped.hashOk, 'SHA-256 must verify');
  assertEqual(unwrapped.filename, 'node-roundtrip.bin');
  assertEqual(Buffer.compare(Buffer.from(unwrapped.body), input), 0,
    'recovered body must equal input bytes');
});

test('multi-page round-trip in Node (state-threaded across pages)', async () => {
  const settings = { xcrosses: 33, ycrosses: 47 };
  // Force at least 3 pages. NETBITS at 33×47 is 573,750 bits — not a
  // multiple of 8, so per-page decode bytes don't byte-align without
  // state threading. Exercises the corner case the codec API was widened
  // to handle.
  const geom = optar.makeGeometry(settings.xcrosses, settings.ycrosses);
  const N = Math.floor(2 * geom.NETBITS / 8) + 100;
  const input = crypto.randomBytes(N);
  if (input[N - 1] === 0) input[N - 1] = 0xff;

  const wrapped = await optar.wrapWithHeader(input, 'multi.bin');
  const enc = optar.encodeBytes(wrapped, settings);
  assert(enc.pages.length >= 3, `expected >= 3 pages, got ${enc.pages.length}`);

  // Decode each page with a shared state object, concat per-page bytes.
  const state = { payloadAccu: 1 };
  const merged = [];
  for (const cells of enc.pages) {
    const dec = optar.decodeImageData(cellsToImageData(cells, enc.geom),
      { ...settings, state });
    assertEqual(dec.stats.errors[4], 0);
    for (let i = 0; i < dec.bytes.length; i++) merged.push(dec.bytes[i]);
  }
  const unwrapped = await optar.unwrapHeader(new Uint8Array(merged));
  assert(unwrapped.hashOk, 'SHA-256 must verify across pages');
  assertEqual(unwrapped.filename, 'multi.bin');
  assertEqual(Buffer.compare(Buffer.from(unwrapped.body), input), 0);
});

test('CRC pass on clean encode→decode round-trip', async () => {
  const settings = { xcrosses: 65, ycrosses: 93 };  // default A4
  const N = 1024;
  const input = crypto.randomBytes(N);
  if (input[N - 1] === 0) input[N - 1] = 0xff;

  const wrapped = await optar.wrapWithHeader(input, 'crc-test.bin');
  const enc = optar.encodeBytes(wrapped, settings);
  assertEqual(enc.fecOrder, 11, 'encoder should default to FEC_ORDER=11 (CRC)');

  const dec = optar.decodeImageData(cellsToImageData(enc.pages[0], enc.geom), settings);
  assertEqual(dec.fecOrder, 11);
  assertEqual(dec.stats.crcOk, true, 'CRC must verify on a clean encode');
  assertEqual(dec.stats.errors[4], 0);
  // sanity: stored CRC matches computed
  assertEqual(typeof dec.stats.storedCRC, 'number');
  assertEqual(dec.stats.storedCRC, dec.stats.computedCRC);
});

test('CRC fails when a data codeword is flipped', async () => {
  const settings = { xcrosses: 65, ycrosses: 93 };
  const N = 1024;
  const input = crypto.randomBytes(N);
  if (input[N - 1] === 0) input[N - 1] = 0xff;

  const wrapped = await optar.wrapWithHeader(input, 'corrupt.bin');
  const enc = optar.encodeBytes(wrapped, settings);
  // Flip enough bits inside one user codeword's channel positions to push it
  // into BCH miscorrection territory. We aim at the cells of codeword 0:
  // bit b of codeword 0 lives at seq = b * FEC_SYMS, mapped via seq2xy.
  const cells = enc.pages[0];
  // Flip 4 channel bits of codeword 0 — exceeds BCH t=3 so the decoder
  // miscorrects to a *different* valid codeword. CRC catches it.
  for (let b = 0; b < 4; b++) {
    const seq = 0 + b * enc.geom.FEC_SYMS;
    const xy = optar.seq2xy(enc.geom, seq);
    const px = xy[0] + optar.BORDER;
    const py = xy[1] + optar.BORDER;
    cells[px + py * enc.geom.WIDTH] ^= 0xff;
  }

  const dec = optar.decodeImageData(cellsToImageData(cells, enc.geom), settings);
  assertEqual(dec.stats.crcOk, false, 'CRC must catch the miscorrection');
});

test('legacy FEC_ORDER=10 round-trip (no CRC) still works', async () => {
  const settings = { xcrosses: 65, ycrosses: 93, fecOrder: 10 };
  const N = 256;
  const input = crypto.randomBytes(N);
  if (input[N - 1] === 0) input[N - 1] = 0xff;

  const wrapped = await optar.wrapWithHeader(input, 'legacy.bin');
  const enc = optar.encodeBytes(wrapped, settings);
  assertEqual(enc.fecOrder, 10);

  const dec = optar.decodeImageData(cellsToImageData(enc.pages[0], enc.geom), settings);
  assertEqual(dec.fecOrder, 10);
  assertEqual(dec.stats.crcOk, null, 'legacy mode reports no CRC verdict');
  assertEqual(dec.stats.errors[4], 0);

  const u = await optar.unwrapHeader(dec.bytes);
  assert(u.hashOk, 'legacy mode still verifies the OPTR SHA-256');
  assertEqual(Buffer.compare(Buffer.from(u.body), input), 0);
});

test('stitchFrames works in Node without a browser', async () => {
  const settings = { xcrosses: 33, ycrosses: 47 };
  const N = 1024;
  const input = crypto.randomBytes(N);
  if (input[N - 1] === 0) input[N - 1] = 0xff;
  const wrapped = await optar.wrapWithHeader(input, 'stitched.bin');
  const enc = optar.encodeBytes(wrapped, settings);

  // Five identical captures per page, like a screen recording would produce.
  const frames = [];
  for (const cells of enc.pages) {
    const id = cellsToImageData(cells, enc.geom);
    for (let f = 0; f < 5; f++) frames.push(id);
  }
  const stitched = await optar.stitchFrames(frames, settings);
  assertEqual(stitched.unique, enc.pages.length, 'one unique page per source');
  assertEqual(stitched.failed, 0);

  const unwrapped = await optar.unwrapHeader(stitched.bytes);
  assert(unwrapped.hashOk);
  assertEqual(Buffer.compare(Buffer.from(unwrapped.body), input), 0);
});

test('5-color: single-page encode→decode round-trip in Node', async () => {
  const settings = { xcrosses: 33, ycrosses: 47, colorMode: '5color' };
  const geom = optar.makeGeometry(settings.xcrosses, settings.ycrosses, settings.colorMode);
  // userBitsPerPage = (FEC_SYMS-1)*45 (CRC slot reserved). Leave 100 bytes
  // of margin for the OPTR header (~46 B) and BCH-K flush padding.
  const N = Math.floor((geom.FEC_SYMS - 1) * 45 / 8) - 100;
  const input = crypto.randomBytes(N);
  if (input[N - 1] === 0) input[N - 1] = 0xff;

  const wrapped = await optar.wrapWithHeader(input, 'color-roundtrip.bin');
  const enc = optar.encodeBytes(wrapped, settings);
  assertEqual(enc.fecOrder, 12, 'encoder must set fecOrder=12 for 5color');
  assertEqual(enc.colorMode, '5color');
  assertEqual(enc.pages.length, 1);

  const imgData = cellsToImageData(enc.pages[0], enc.geom);
  const dec = optar.decodeImageData(imgData, settings);
  assertEqual(dec.stats.errors[4], 0, 'no irreparable errors on clean encode');
  assertEqual(dec.stats.crcOk, true, 'CRC must pass');
  assertEqual(dec.fecOrder, 12);
  assertEqual(dec.colorMode, '5color');

  const unwrapped = await optar.unwrapHeader(dec.bytes);
  assert(unwrapped.hasHeader, 'OPTR header must survive round-trip');
  assert(unwrapped.hashOk, 'SHA-256 must verify');
  assertEqual(Buffer.compare(Buffer.from(unwrapped.body), input), 0,
    'recovered body must equal input');
});

test('5-color: multi-page round-trip with state threading', async () => {
  const settings = { xcrosses: 33, ycrosses: 47, colorMode: '5color' };
  const geom = optar.makeGeometry(settings.xcrosses, settings.ycrosses, settings.colorMode);
  // Force >= 3 pages.
  const N = Math.floor(2.5 * geom.NETBITS / 8) + 50;
  const input = crypto.randomBytes(N);
  if (input[N - 1] === 0) input[N - 1] = 0xff;

  const wrapped = await optar.wrapWithHeader(input, 'color-multi.bin');
  const enc = optar.encodeBytes(wrapped, settings);
  assert(enc.pages.length >= 2, `expected >= 2 color pages, got ${enc.pages.length}`);

  const state = { payloadAccu: 1 };
  const merged = [];
  for (const cells of enc.pages) {
    const dec = optar.decodeImageData(cellsToImageData(cells, enc.geom),
      { ...settings, state });
    assertEqual(dec.stats.errors[4], 0, 'no irreparable errors per page');
    for (let i = 0; i < dec.bytes.length; i++) merged.push(dec.bytes[i]);
  }
  const unwrapped = await optar.unwrapHeader(new Uint8Array(merged));
  assert(unwrapped.hashOk, 'SHA-256 must verify across pages');
  assertEqual(Buffer.compare(Buffer.from(unwrapped.body), input), 0);
});

test('5-color: format string carries fecOrder=12', async () => {
  const settings = { xcrosses: 33, ycrosses: 47, colorMode: '5color' };
  const wrapped = await optar.wrapWithHeader(Buffer.from('hello'), 'fmt-test.txt');
  const enc = optar.encodeBytes(wrapped, settings);
  const fmt = optar.buildFormatString(enc.geom, 1, enc.nPages, 'test');
  const parsed = optar.parseFormatString(fmt);
  assert(parsed !== null, 'format string must parse');
  assertEqual(parsed.fecOrder, 12, 'parsed fecOrder must be 12 for 5color');
});

test('5-color: yellowed-paper simulation still decodes (centroid calibration)', async () => {
  const settings = { xcrosses: 33, ycrosses: 47, colorMode: '5color' };
  const geom = optar.makeGeometry(settings.xcrosses, settings.ycrosses, settings.colorMode);
  // Leave comfortable headroom so the payload fits in one page after wrapping.
  const N = Math.floor((geom.FEC_SYMS - 1) * 45 / 8) - 100;
  const input = crypto.randomBytes(N);
  if (input[N - 1] === 0) input[N - 1] = 0xff;

  const wrapped = await optar.wrapWithHeader(input, 'yellow.bin');
  const enc = optar.encodeBytes(wrapped, settings);
  const imgData = cellsToImageData(enc.pages[0], enc.geom);

  // Simulate yellowing: reduce blue 30%, boost red 5%, green 2%.
  const yellowed = new Uint8ClampedArray(imgData.data.length);
  for (let i = 0; i < imgData.data.length; i += 4) {
    yellowed[i]     = Math.min(255, imgData.data[i]     * 1.05);  // R
    yellowed[i + 1] = Math.min(255, imgData.data[i + 1] * 1.02);  // G
    yellowed[i + 2] = Math.min(255, imgData.data[i + 2] * 0.70);  // B
    yellowed[i + 3] = 255;
  }
  const yellowedImg = { width: imgData.width, height: imgData.height, data: yellowed };

  const dec = optar.decodeImageData(yellowedImg, settings);
  assertEqual(dec.stats.errors[4], 0,
    'centroid calibration must absorb moderate yellow-shift without irreparable errors');
  assertEqual(dec.stats.crcOk, true, 'CRC must pass after yellow-shift');
  const unwrapped = await optar.unwrapHeader(dec.bytes);
  assert(unwrapped.hashOk, 'SHA-256 must verify after yellow-shift');
  assertEqual(Buffer.compare(Buffer.from(unwrapped.body), input), 0);
});

test('5-color: geom.colorMode is set and color mode is denser than mono', () => {
  const mono  = optar.makeGeometry(33, 47, 'mono');
  const color = optar.makeGeometry(33, 47, '5color');
  assertEqual(mono.colorMode,  'mono');
  assertEqual(color.colorMode, '5color');
  // 5-color packs ~2.286 bits/cell vs 1 bit/cell for mono.
  assert(color.NETBITS > mono.NETBITS * 1.5, 'color page must be denser than mono');
  assert(color.patchCellPositions !== null, 'color geom must have patch positions');
  assertEqual(color.patchCellPositions.length, 5);
});

// ----------------------------------------------------------------------------
(async () => {
  let passed = 0, failed = 0;
  const start = Date.now();
  for (const t of tests) {
    const tStart = Date.now();
    try {
      await t.fn();
      console.log(`  ok   ${t.name}  (${Date.now() - tStart} ms)`);
      passed++;
    } catch (err) {
      console.log(`  FAIL ${t.name}  (${Date.now() - tStart} ms)\n       ${err.message}`);
      failed++;
    }
  }
  console.log(`\n${passed} passed, ${failed} failed in ${Date.now() - start} ms`);
  process.exit(failed > 0 ? 1 : 0);
})();
