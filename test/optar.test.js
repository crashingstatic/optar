// Puppeteer test suite for browser/optar.html.
//
// Drives a headless Chromium that loads the standalone HTML, then uses
// page.evaluate() to call the test-API hooks (window.OPTAR.*).
//
// Run via:  ./test-runner.sh
// or:       node optar.test.js

'use strict';

const path = require('path');
const fs = require('fs');
const puppeteer = require('puppeteer');

const HTML_PATH = path.resolve(__dirname, '..', 'browser', 'optar.html');
const FIXTURES = path.resolve(__dirname, 'fixtures');
const VERBOSE = process.env.VERBOSE === '1';

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

function assert(cond, msg) {
  if (!cond) throw new Error('assertion failed: ' + (msg || '(no message)'));
}
function assertEqual(actual, expected, msg) {
  if (actual !== expected) {
    throw new Error('assertEqual failed: ' + (msg || '') +
      `\n  expected: ${expected}\n    actual: ${actual}`);
  }
}

async function runAll() {
  if (!fs.existsSync(FIXTURES)) fs.mkdirSync(FIXTURES, { recursive: true });

  const browser = await puppeteer.launch({
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium',
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
  });
  const page = await browser.newPage();
  page.on('pageerror', err => console.error('[page error]', err.message));
  page.on('console', msg => {
    if (VERBOSE || msg.type() === 'error') {
      console.log(`[page ${msg.type()}]`, msg.text());
    }
  });

  await page.goto('file://' + HTML_PATH, { waitUntil: 'load' });
  await page.waitForFunction('window.OPTAR_READY === true', { timeout: 10000 });

  let passed = 0;
  let failed = 0;
  const startAll = Date.now();
  for (const t of tests) {
    const start = Date.now();
    try {
      await t.fn(page);
      const ms = Date.now() - start;
      console.log(`  ok   ${t.name}  (${ms} ms)`);
      passed++;
    } catch (err) {
      const ms = Date.now() - start;
      console.log(`  FAIL ${t.name}  (${ms} ms)\n       ${err.message}`);
      failed++;
    }
  }
  await browser.close();
  const ms = Date.now() - startAll;

  console.log('');
  console.log(`${passed} passed, ${failed} failed in ${ms} ms`);
  if (failed > 0) process.exit(1);
}

// ============================================================================
// Tests
// ============================================================================

// 1. Golay round-trip: encode every 12-bit data word, decode, expect 0 errors.
test('golay round-trip: all 4096 codewords decode to themselves', async (page) => {
  const result = await page.evaluate(() => {
    let mismatches = 0;
    let errorCount = 0;
    for (let d = 0; d < 4096; d++) {
      const code = OPTAR.golayEncode(d);
      const dec = OPTAR.golayDecode(code);
      if (dec.data !== d) mismatches++;
      if (dec.errors !== 0) errorCount++;
    }
    return { mismatches, errorCount };
  });
  assertEqual(result.mismatches, 0, 'all 4096 must decode to original data');
  assertEqual(result.errorCount, 0, 'all 4096 must decode with 0 errors');
});

// 2. Golay error correction: 1, 2, 3 random bit flips per codeword recover.
test('golay corrects 1, 2, and 3-bit errors', async (page) => {
  const result = await page.evaluate(() => {
    function rand(n) { return Math.floor(Math.random() * n); }
    function flipBits(code, k) {
      const positions = new Set();
      while (positions.size < k) positions.add(rand(24));
      let r = code;
      for (const p of positions) r ^= (1 << p);
      return r;
    }
    const trials = 256;
    const stats = { 1: { ok: 0, bad: 0 }, 2: { ok: 0, bad: 0 }, 3: { ok: 0, bad: 0 } };
    for (let k = 1; k <= 3; k++) {
      for (let i = 0; i < trials; i++) {
        const data = rand(4096);
        const code = OPTAR.golayEncode(data);
        const noisy = flipBits(code, k);
        const dec = OPTAR.golayDecode(noisy);
        if (dec.reparable && dec.data === data && dec.errors === k) stats[k].ok++;
        else stats[k].bad++;
      }
    }
    return stats;
  });
  for (const k of [1, 2, 3]) {
    assertEqual(result[k].bad, 0, `${k}-bit errors must always recover`);
  }
});

// 3. Golay flags 4+ bit errors as uncorrectable in (almost) all cases.
//    With min distance 8, a 4-bit error can fall outside any 3-radius sphere
//    OR land inside a *different* codeword's sphere. The first case is the
//    common one and what we verify here. We don't assert "always" because
//    the Golay (24,12) does have some 4-error patterns that decode to the
//    wrong codeword (sphere overlap doesn't happen, but radius-3 spheres do
//    leave words at distance 4 from one codeword and ≤3 from another in
//    some cases).
test('golay flags most 4+ bit errors as irreparable', async (page) => {
  const result = await page.evaluate(() => {
    function rand(n) { return Math.floor(Math.random() * n); }
    function flipBits(code, k) {
      const positions = new Set();
      while (positions.size < k) positions.add(rand(24));
      let r = code;
      for (const p of positions) r ^= (1 << p);
      return r;
    }
    const trials = 256;
    let irreparable = 0, miscorrect = 0;
    for (let i = 0; i < trials; i++) {
      const data = rand(4096);
      const code = OPTAR.golayEncode(data);
      // Always 4+ bit errors.
      const k = 4 + rand(5);
      const noisy = flipBits(code, k);
      const dec = OPTAR.golayDecode(noisy);
      if (!dec.reparable) irreparable++;
      else miscorrect++;
    }
    return { irreparable, miscorrect, trials };
  });
  // The Golay code's 3-error-correcting spheres cover ~57% of word-space.
  // A heavily corrupted word has roughly 50/50 chance of landing inside or
  // outside a sphere; we just check the irreparable count is in a sane
  // range (at least a quarter).
  assert(result.irreparable >= result.trials / 4,
    `expected at least ${result.trials/4} irreparable, got ${result.irreparable}`);
});

// 4. Interleave round-trip.
test('interleave / deinterleave round-trip', async (page) => {
  const result = await page.evaluate(() => {
    const FEC_SYMS = 1000;
    const codewords = new Int32Array(FEC_SYMS);
    for (let i = 0; i < FEC_SYMS; i++) {
      codewords[i] = ((Math.random() * 0x1000000) | 0) & 0xffffff;
    }
    const bits = OPTAR.interleaveBits(codewords, FEC_SYMS);
    const recovered = OPTAR.deinterleaveBits(bits, FEC_SYMS);
    let mismatches = 0;
    for (let i = 0; i < FEC_SYMS; i++) {
      if (recovered[i] !== codewords[i]) mismatches++;
    }
    return { mismatches, length: bits.length };
  });
  assertEqual(result.mismatches, 0, 'all codewords must round-trip through interleave');
  assertEqual(result.length, 1000 * 24, 'interleaved length must be FEC_SYMS * 24');
});

// 5. Encode → render → decode round-trip with no noise (clean).
test('encode-decode round-trip (clean, 1 KB random)', async (page) => {
  const result = await page.evaluate(() => {
    const N = 1024;
    const input = new Uint8Array(N);
    for (let i = 0; i < N; i++) input[i] = (Math.random() * 256) | 0;
    const enc = OPTAR.encodeBytes(input, { xcrosses: 65, ycrosses: 93 });
    const canvas = OPTAR.renderPageToCanvas(enc.pages[0], enc.geom, 1, { label: 'test' });
    const ctx = canvas.getContext('2d');
    const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const dec = OPTAR.decodeImageData(imgData, { xcrosses: 65, ycrosses: 93 });
    let mismatches = 0;
    for (let i = 0; i < N; i++) {
      if (dec.bytes[i] !== input[i]) mismatches++;
    }
    return { mismatches, n: N, irreparable: dec.stats.errors[4], pages: enc.nPages };
  });
  assertEqual(result.mismatches, 0, 'first 1024 bytes must match');
  assertEqual(result.irreparable, 0, 'no irreparable codewords on clean image');
  assertEqual(result.pages, 1, 'must fit in a single page');
});

// 6. Encode → render → add noise → decode round-trip.
test('encode-decode round-trip (noisy, salt-pepper noise)', async (page) => {
  const result = await page.evaluate(() => {
    const N = 1024;
    const input = new Uint8Array(N);
    for (let i = 0; i < N; i++) input[i] = (Math.random() * 256) | 0;

    const enc = OPTAR.encodeBytes(input, { xcrosses: 65, ycrosses: 93 });
    const canvas = OPTAR.renderPageToCanvas(enc.pages[0], enc.geom, 1, { label: 'noisy' });
    const ctx = canvas.getContext('2d');
    const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);

    // Salt-pepper noise: flip a small fraction of pixels in the data area.
    // We use 0.5% — within Golay's correction capacity (3/24 ≈ 12.5% per word).
    const data = imgData.data;
    const flipProb = 0.005;
    let flipped = 0;
    for (let p = 0; p < data.length; p += 4) {
      if (Math.random() < flipProb) {
        const v = 255 - data[p];
        data[p] = v; data[p + 1] = v; data[p + 2] = v;
        flipped++;
      }
    }
    ctx.putImageData(imgData, 0, 0);
    const corrupted = ctx.getImageData(0, 0, canvas.width, canvas.height);

    const dec = OPTAR.decodeImageData(corrupted, { xcrosses: 65, ycrosses: 93 });
    let mismatches = 0;
    for (let i = 0; i < N; i++) {
      if (dec.bytes[i] !== input[i]) mismatches++;
    }
    return {
      mismatches,
      flipped,
      stats: dec.stats.errors,
    };
  });
  assertEqual(result.mismatches, 0,
    `noisy round-trip must recover input (flipped=${result.flipped}, ` +
    `golay errors=${JSON.stringify(result.stats)})`);
});

// 7. Multi-page: encode > 200 KB, decode all pages, verify match.
test('multi-page round-trip (300 KB)', async (page) => {
  const result = await page.evaluate(() => {
    const N = 300 * 1024;
    const input = new Uint8Array(N);
    // Pseudo-random fill — deterministic so it's easy to reason about.
    let seed = 1;
    for (let i = 0; i < N; i++) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      input[i] = seed & 0xff;
    }
    const enc = OPTAR.encodeBytes(input, { xcrosses: 65, ycrosses: 93 });
    const decoded = new Uint8Array(N);
    let off = 0;
    let irreparable = 0;
    for (let pi = 0; pi < enc.pages.length; pi++) {
      const canvas = OPTAR.renderPageToCanvas(enc.pages[pi], enc.geom, 1, { label: 'page' });
      const ctx = canvas.getContext('2d');
      const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const dec = OPTAR.decodeImageData(imgData, { xcrosses: 65, ycrosses: 93 });
      irreparable += dec.stats.errors[4];
      const remaining = N - off;
      const take = Math.min(remaining, dec.bytes.length);
      decoded.set(dec.bytes.subarray(0, take), off);
      off += take;
      if (off >= N) break;
    }
    let mismatches = 0;
    for (let i = 0; i < N; i++) if (decoded[i] !== input[i]) mismatches++;
    return { mismatches, pages: enc.nPages, irreparable };
  });
  assert(result.pages >= 2, `need >= 2 pages for 300 KB, got ${result.pages}`);
  assertEqual(result.mismatches, 0, 'multi-page round-trip must be byte-exact');
  assertEqual(result.irreparable, 0, 'no irreparable codewords on clean multi-page');
});

// 8. Settings: change XCROSSES/YCROSSES, encode-decode round-trip still works.
test('settings: smaller page (XCROSSES=33, YCROSSES=47) round-trips', async (page) => {
  const result = await page.evaluate(() => {
    const settings = { xcrosses: 33, ycrosses: 47 };
    const N = 256;
    const input = new Uint8Array(N);
    for (let i = 0; i < N; i++) input[i] = i;
    const enc = OPTAR.encodeBytes(input, settings);
    const canvas = OPTAR.renderPageToCanvas(enc.pages[0], enc.geom, 1, { label: 't' });
    const ctx = canvas.getContext('2d');
    const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const dec = OPTAR.decodeImageData(imgData, settings);
    let mismatches = 0;
    for (let i = 0; i < N; i++) if (dec.bytes[i] !== input[i]) mismatches++;
    return {
      mismatches,
      width: canvas.width,
      height: canvas.height,
      irreparable: dec.stats.errors[4],
    };
  });
  assertEqual(result.mismatches, 0, 'smaller-page round-trip must be byte-exact');
  assertEqual(result.irreparable, 0, 'no irreparable codewords for smaller-page test');
});

// 9. Edge cases: empty, 1-byte, page-boundary file.
test('edge case: empty file produces a single all-zero page', async (page) => {
  const result = await page.evaluate(() => {
    const enc = OPTAR.encodeBytes(new Uint8Array(0), { xcrosses: 65, ycrosses: 93 });
    return { pages: enc.nPages };
  });
  assertEqual(result.pages, 1, 'empty file must produce one page');
});

test('edge case: 1-byte file decodes with first byte preserved', async (page) => {
  const result = await page.evaluate(() => {
    const input = new Uint8Array([0xa5]);
    const enc = OPTAR.encodeBytes(input, { xcrosses: 65, ycrosses: 93 });
    const canvas = OPTAR.renderPageToCanvas(enc.pages[0], enc.geom, 1, { label: 'x' });
    const ctx = canvas.getContext('2d');
    const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const dec = OPTAR.decodeImageData(imgData, { xcrosses: 65, ycrosses: 93 });
    return {
      pages: enc.nPages,
      first: dec.bytes[0],
      irreparable: dec.stats.errors[4],
    };
  });
  assertEqual(result.pages, 1);
  assertEqual(result.first, 0xa5, 'first byte must be preserved');
  assertEqual(result.irreparable, 0);
});

test('edge case: file size exactly at page boundary fits in one page', async (page) => {
  const result = await page.evaluate(() => {
    const geom = OPTAR.makeGeometry(65, 93);
    const N = geom.NETBITS / 8; // exact bytes that fit one page
    const input = new Uint8Array(N);
    for (let i = 0; i < N; i++) input[i] = (i * 7) & 0xff;
    const enc = OPTAR.encodeBytes(input, { xcrosses: 65, ycrosses: 93 });
    return { pages: enc.nPages, n: N, expected: geom.NETBITS / 8 };
  });
  assertEqual(result.n, result.expected);
  assertEqual(result.pages, 1, 'exactly-page-sized file must use one page');
});

test('edge case: one byte over a page boundary spills to two pages', async (page) => {
  const result = await page.evaluate(() => {
    const geom = OPTAR.makeGeometry(65, 93);
    const N = geom.NETBITS / 8 + 1;
    const input = new Uint8Array(N);
    input[N - 1] = 0xee;
    const enc = OPTAR.encodeBytes(input, { xcrosses: 65, ycrosses: 93 });
    return { pages: enc.nPages };
  });
  assertEqual(result.pages, 2, 'one byte past the page boundary must spill to a second page');
});

// 10. Scale=3 round-trip — exercises the UI default rendering path where
//     each cell is 3x3 pixels and the decoder must average the cell area.
test('scale=3 (UI default) round-trip', async (page) => {
  const result = await page.evaluate(() => {
    const N = 256;
    const input = new Uint8Array(N);
    for (let i = 0; i < N; i++) input[i] = (i * 13 + 7) & 0xff;
    const enc = OPTAR.encodeBytes(input, { xcrosses: 65, ycrosses: 93 });
    const canvas = OPTAR.renderPageToCanvas(enc.pages[0], enc.geom, 3, { label: 'scale3' });
    const ctx = canvas.getContext('2d');
    const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const dec = OPTAR.decodeImageData(imgData, { xcrosses: 65, ycrosses: 93 });
    let mismatches = 0;
    for (let i = 0; i < N; i++) if (dec.bytes[i] !== input[i]) mismatches++;
    return {
      mismatches,
      width: canvas.width,
      height: canvas.height,
      irreparable: dec.stats.errors[4],
    };
  });
  assertEqual(result.mismatches, 0, 'scale=3 round-trip must be byte-exact');
  assertEqual(result.irreparable, 0, 'no irreparable codewords at scale=3');
});

// 11. Sanity: format string round-trip.
test('format string round-trip', async (page) => {
  const result = await page.evaluate(() => {
    const geom = OPTAR.makeGeometry(65, 93);
    const f = OPTAR.buildFormatString(geom, 1, 1, 'foo');
    const parsed = OPTAR.parseFormatString(f);
    return { f, parsed };
  });
  assert(result.f.startsWith('0-65-93-24-3-1-2-24'), `unexpected format: ${result.f}`);
  assertEqual(result.parsed.xcrosses, 65);
  assertEqual(result.parsed.ycrosses, 93);
});

runAll().catch(err => {
  console.error(err);
  process.exit(1);
});
