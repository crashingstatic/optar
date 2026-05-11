// Puppeteer test suite for sloptar-lite/sloptar-lite.html — WCMYK decode only.
//
// Strategy: load sloptar-lite.html (which defines decodePage, unwrapHeader, etc.
// in page scope), then inject the full sloptar-codec.js + sloptar-render.js so
// tests can encode and render WCMYK pages without reimplementing that logic.
//
// All encode → render → decode sequences happen inside a single page.evaluate()
// call.  The only values that cross the boundary are small result objects.

'use strict';

const path = require('path');
const puppeteer = require('puppeteer');

const LITE_PATH   = path.resolve(__dirname, '..', 'sloptar-lite', 'sloptar-lite.html');
const CODEC_PATH  = path.resolve(__dirname, '..', 'browser', 'sloptar-codec.js');
const RENDER_PATH = path.resolve(__dirname, '..', 'browser', 'sloptar-render.js');
const VERBOSE     = process.env.VERBOSE === '1';

// ── Test harness ──────────────────────────────────────────────────────────────
const tests = [];
function test(name, fn) { tests.push({ name, fn }); }
function assert(cond, msg) { if (!cond) throw new Error('assertion failed: ' + (msg || '')); }
function assertEqual(actual, expected, msg) {
  if (actual !== expected)
    throw new Error(`assertEqual: ${msg || ''}\n  expected: ${expected}\n  actual:   ${actual}`);
}

async function runAll() {
  const browser = await puppeteer.launch({
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium',
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });
  const page = await browser.newPage();
  page.setDefaultTimeout(90000);   // WCMYK decodes are heavy; allow up to 90s per evaluate
  page.on('pageerror', err => console.error('[page error]', err.message));
  page.on('console', msg => {
    if (VERBOSE || msg.type() === 'error') console.log(`[page ${msg.type()}]`, msg.text());
  });

  await page.goto('file://' + LITE_PATH, { waitUntil: 'load' });
  await page.waitForFunction('window.SLOPTAR_LITE_READY === true', { timeout: 10000 });

  // Inject the full codec+renderer so tests can encode/render without reimplementing.
  await page.addScriptTag({ path: CODEC_PATH });
  await page.addScriptTag({ path: RENDER_PATH });

  let passed = 0, failed = 0;
  const startAll = Date.now();
  for (const t of tests) {
    const start = Date.now();
    try {
      await t.fn(page);
      console.log(`  ok   ${t.name}  (${Date.now() - start} ms)`);
      passed++;
    } catch (err) {
      console.log(`  FAIL ${t.name}  (${Date.now() - start} ms)\n       ${err.message}`);
      failed++;
    }
  }
  await browser.close();
  console.log('');
  console.log(`${passed} passed, ${failed} failed in ${Date.now() - startAll} ms`);
  if (failed > 0) process.exit(1);
}

// ── In-page helper: encode → render → decode → unwrap, all in one evaluate call.
// Returns { crcOk, errors[5], hasHeader, hashOk, bodyLen, fname }.
async function roundTrip(page, inputExpr, opts = {}) {
  const { scale = 1, filename = 'test.bin' } = opts;
  return page.evaluate(async (inputJs, fname, sc) => {
    // eslint-disable-next-line no-eval
    const input   = eval(inputJs);
    const wrapped = await SLOPTAR.wrapWithHeader(input, fname);
    const enc     = SLOPTAR.encodeBytes(wrapped,
      { xcrosses: 67, ycrosses: 87, colorMode: '5color-cmyk' });

    const combined = [];
    const state = { accu: 1 };
    const pageStats = [];

    for (const pageArr of enc.pages) {
      const canvas = SLOPTAR_RENDER.renderPageToCanvas(pageArr, enc.geom, sc, { label: 'test' });
      const ctx    = canvas.getContext('2d');
      const id     = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const dec    = decodePage(id, state);
      for (const b of dec.bytes) combined.push(b);
      pageStats.push({ crcOk: dec.crcOk, errors: Array.from(dec.errors) });
    }

    const uw = await unwrapHeader(new Uint8Array(combined));
    return {
      nPages:    enc.nPages,
      pageStats,
      hasHeader: uw.hasHeader,
      hashOk:    uw.hashOk,
      bodyLen:   uw.body ? uw.body.length : 0,
      fname:     uw.fname,
      error:     uw.error || null,
    };
  }, inputExpr, filename, scale);
}

// ── BCH unit tests (test lite's own bchDec, not SLOPTAR.bchDecode) ────────────

test('bchDec: decodes codewords produced by SLOPTAR.bchEncode', async (page) => {
  const mismatches = await page.evaluate(() => {
    let n = 0;
    for (let i = 0; i < 500; i++) {
      const hi   = Math.floor(Math.random() * (1 << 13));
      const lo   = Math.floor(Math.random() * 0x100000000);
      const data = (BigInt(hi) << 32n) | BigInt(lo >>> 0);
      const code = SLOPTAR.bchEncode(data);
      const dec  = bchDec(code);   // lite's own decoder
      if (BigInt(dec.data) !== data || dec.errors !== 0 || !dec.reparable) n++;
    }
    return n;
  });
  assertEqual(mismatches, 0, 'lite bchDec must agree with full encoder on all 500 words');
});

test('bchDec: corrects 1-, 2-, and 3-bit errors', async (page) => {
  const bad = await page.evaluate(() => {
    function flip(code, k) {
      const pos = new Set();
      while (pos.size < k) pos.add(Math.floor(Math.random() * 63));
      let r = code; for (const p of pos) r ^= 1n << BigInt(p); return r;
    }
    const counts = [0, 0, 0];
    for (let k = 1; k <= 3; k++) {
      for (let i = 0; i < 100; i++) {
        const hi   = Math.floor(Math.random() * (1 << 13));
        const lo   = Math.floor(Math.random() * 0x100000000);
        const data = (BigInt(hi) << 32n) | BigInt(lo >>> 0);
        const dec  = bchDec(flip(SLOPTAR.bchEncode(data), k));
        if (!dec.reparable || BigInt(dec.data) !== data) counts[k - 1]++;
      }
    }
    return counts;
  });
  for (let k = 1; k <= 3; k++)
    assertEqual(bad[k - 1], 0, `lite bchDec must correct all ${k}-bit errors`);
});

// ── Page decode tests ─────────────────────────────────────────────────────────

test('decodePage: CRC is OK on a clean render', async (page) => {
  const r = await roundTrip(page, 'new Uint8Array(256).fill(0xAB)');
  assert(r.pageStats[0].crcOk, 'CRC must be OK');
});

test('decodePage: no BCH corrections needed on a clean render', async (page) => {
  const r = await roundTrip(page, 'new Uint8Array(256).fill(0x55)');
  const e = r.pageStats[0].errors;
  assertEqual(e[1], 0, '1-bit correction count must be 0');
  assertEqual(e[2], 0, '2-bit correction count must be 0');
  assertEqual(e[3], 0, '3-bit correction count must be 0');
  assertEqual(e[4], 0, 'uncorrectable codeword count must be 0');
});

test('decodePage: single-page round-trip (1 KB random data)', async (page) => {
  const r = await roundTrip(page,
    'crypto.getRandomValues(new Uint8Array(1024))',
    { filename: 'random.bin' });
  assert(r.pageStats[0].crcOk, 'CRC must be OK');
  assert(r.hasHeader,           'must have OPTR/OPTZ header');
  assert(r.hashOk,              'SHA-256 must verify');
  assertEqual(r.bodyLen, 1024,  'recovered body must be 1024 bytes');
});

test('decodePage: empty file round-trip', async (page) => {
  const r = await roundTrip(page, 'new Uint8Array(0)', { filename: 'empty.bin' });
  assert(r.pageStats[0].crcOk, 'CRC must be OK');
  assert(r.hasHeader,           'must have header');
  assert(r.hashOk,              'SHA-256 must verify');
  assertEqual(r.bodyLen, 0,    'recovered body must be 0 bytes');
});

test('decodePage: 1-byte file round-trip', async (page) => {
  const r = await roundTrip(page, 'new Uint8Array([0xBE])', { filename: '1byte.bin' });
  assert(r.pageStats[0].crcOk, 'CRC must be OK');
  assert(r.hashOk,              'SHA-256 must verify');
  assertEqual(r.bodyLen, 1,     'recovered body must be 1 byte');
});

// ── Header / unwrap tests ─────────────────────────────────────────────────────

test('unwrapHeader: filename is preserved through encode/decode', async (page) => {
  const r = await roundTrip(page,
    'new Uint8Array(128).fill(7)',
    { filename: 'hello_world.bin' });
  assert(r.hashOk,                       'SHA-256 must verify');
  assertEqual(r.fname, 'hello_world.bin', 'filename must round-trip');
});

test('unwrapHeader: OPTZ (gzip) path with compressible payload', async (page) => {
  // Highly compressible data → wrapWithHeader chooses OPTZ.
  const r = await page.evaluate(async () => {
    const input   = new Uint8Array(8192).fill(0x42);    // all same byte
    const wrapped = await SLOPTAR.wrapWithHeader(input, 'zeros.bin');
    const isOptz  = wrapped[3] === 0x5a;                // "OPTZ" magic 4th byte is 'Z'

    const enc = SLOPTAR.encodeBytes(wrapped,
      { xcrosses: 67, ycrosses: 87, colorMode: '5color-cmyk' });
    const combined = []; const state = { accu: 1 };
    for (const pageArr of enc.pages) {
      const canvas = SLOPTAR_RENDER.renderPageToCanvas(pageArr, enc.geom, 1, { label: 'z' });
      const ctx = canvas.getContext('2d');
      const id  = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const dec = decodePage(id, state);
      for (const b of dec.bytes) combined.push(b);
    }
    const uw = await unwrapHeader(new Uint8Array(combined));
    return { isOptz, hasHeader: uw.hasHeader, hashOk: uw.hashOk,
             bodyLen: uw.body ? uw.body.length : 0 };
  });
  assert(r.isOptz,            'wrapWithHeader must choose OPTZ for compressible data');
  assert(r.hasHeader,         'must detect OPTZ header');
  assert(r.hashOk,            'SHA-256 must verify after gunzip');
  assertEqual(r.bodyLen, 8192, 'decompressed body must match original size');
});

test('unwrapHeader: raw bytes without header return hasHeader=false', async (page) => {
  const result = await page.evaluate(async () => {
    const raw = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    const uw  = await unwrapHeader(raw);
    return { hasHeader: uw.hasHeader };
  });
  assert(!result.hasHeader, 'raw bytes with no magic must return hasHeader=false');
});

// ── Run ───────────────────────────────────────────────────────────────────────
runAll().catch(err => { console.error(err); process.exit(1); });
