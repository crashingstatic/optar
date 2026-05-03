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

// Render page cells (1 byte per cell) to a fake ImageData. The decoder
// only reads {width, height, data: Uint8Array-like RGBA}, so we synthesise
// that here without any browser API.
function cellsToImageData(cells, geom) {
  const W = geom.WIDTH, H = geom.HEIGHT;
  const data = new Uint8ClampedArray(W * H * 4);
  for (let i = 0, j = 0; i < cells.length; i++, j += 4) {
    const v = cells[i];
    data[j] = v; data[j + 1] = v; data[j + 2] = v; data[j + 3] = 255;
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
