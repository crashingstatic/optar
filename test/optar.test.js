// Puppeteer test suite for browser/optar.html (BCH(63, 45, t=3) only).

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

// ---------- BCH unit tests ----------

test('bch round-trip: 1000 random 45-bit data words', async (page) => {
  const result = await page.evaluate(() => {
    const N = 1000;
    let mismatches = 0;
    for (let i = 0; i < N; i++) {
      const hi = Math.floor(Math.random() * (1 << 13));
      const lo = Math.floor(Math.random() * 0x100000000);
      const data = (BigInt(hi) << 32n) | BigInt(lo >>> 0);
      const code = OPTAR.bchEncode(data);
      const dec = OPTAR.bchDecode(code);
      if (BigInt(dec.data) !== data || dec.errors !== 0) mismatches++;
    }
    return mismatches;
  });
  assertEqual(result, 0, 'all BCH round-trips must decode with 0 errors');
});

test('bch corrects 1, 2, and 3-bit errors', async (page) => {
  const result = await page.evaluate(() => {
    const trials = 128;
    const stats = { 1: 0, 2: 0, 3: 0 };
    function rand(n) { return Math.floor(Math.random() * n); }
    function flip(code, k) {
      const pos = new Set();
      while (pos.size < k) pos.add(rand(63));
      let r = code;
      for (const p of pos) r ^= (1n << BigInt(p));
      return r;
    }
    for (let k = 1; k <= 3; k++) {
      let bad = 0;
      for (let i = 0; i < trials; i++) {
        const hi = Math.floor(Math.random() * (1 << 13));
        const lo = Math.floor(Math.random() * 0x100000000);
        const data = (BigInt(hi) << 32n) | BigInt(lo >>> 0);
        const code = OPTAR.bchEncode(data);
        const dec = OPTAR.bchDecode(flip(code, k));
        if (!dec.reparable || BigInt(dec.data) !== data || dec.errors !== k) bad++;
      }
      stats[k] = bad;
    }
    return stats;
  });
  for (const k of [1, 2, 3]) assertEqual(result[k], 0, `${k}-bit errors must always recover`);
});

test('bch flags many 4+ bit errors as irreparable', async (page) => {
  const result = await page.evaluate(() => {
    function rand(n) { return Math.floor(Math.random() * n); }
    function flip(code, k) {
      const pos = new Set();
      while (pos.size < k) pos.add(rand(63));
      let r = code;
      for (const p of pos) r ^= (1n << BigInt(p));
      return r;
    }
    const trials = 256;
    let irreparable = 0;
    for (let i = 0; i < trials; i++) {
      const hi = Math.floor(Math.random() * (1 << 13));
      const lo = Math.floor(Math.random() * 0x100000000);
      const data = (BigInt(hi) << 32n) | BigInt(lo >>> 0);
      const dec = OPTAR.bchDecode(flip(OPTAR.bchEncode(data), 4 + rand(8)));
      if (!dec.reparable) irreparable++;
    }
    return { irreparable, trials };
  });
  assert(result.irreparable >= result.trials / 3,
    `expected at least ${result.trials/3} irreparable, got ${result.irreparable}`);
});

test('interleave / deinterleave round-trip', async (page) => {
  const result = await page.evaluate(() => {
    const FEC_SYMS = 1000;
    const codewords = [];
    for (let i = 0; i < FEC_SYMS; i++) {
      // 63-bit positive BigInt: 31 bits high half, 32 bits low half.
      const hi = Math.floor(Math.random() * 0x80000000);
      const lo = Math.floor(Math.random() * 0x100000000);
      codewords.push((BigInt(hi) << 32n) | BigInt(lo >>> 0));
    }
    const bits = OPTAR.interleaveBits(codewords, FEC_SYMS);
    const recovered = OPTAR.deinterleaveBits(bits, FEC_SYMS);
    let mm = 0;
    for (let i = 0; i < FEC_SYMS; i++) if (recovered[i] !== codewords[i]) mm++;
    return { mm, length: bits.length };
  });
  assertEqual(result.mm, 0);
  assertEqual(result.length, 1000 * 63);
});

// ---------- end-to-end pipeline tests ----------

test('encode-decode round-trip (clean, 1 KB random)', async (page) => {
  const result = await page.evaluate(() => {
    const N = 1024;
    const input = new Uint8Array(N);
    for (let i = 0; i < N; i++) input[i] = (Math.random() * 256) | 0;
    const enc = OPTAR.encodeBytes(input);
    const canvas = OPTAR.renderPageToCanvas(enc.pages[0], enc.geom, 1, { label: 'test' });
    const ctx = canvas.getContext('2d');
    const id = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const dec = OPTAR.decodeImageData(id);
    let mm = 0;
    for (let i = 0; i < N; i++) if (dec.bytes[i] !== input[i]) mm++;
    return { mm, irreparable: dec.stats.errors[4], pages: enc.nPages };
  });
  assertEqual(result.mm, 0);
  assertEqual(result.irreparable, 0);
  assertEqual(result.pages, 1);
});

test('encode-decode round-trip (noisy salt-pepper)', async (page) => {
  const result = await page.evaluate(() => {
    const N = 1024;
    const input = new Uint8Array(N);
    for (let i = 0; i < N; i++) input[i] = (Math.random() * 256) | 0;
    const enc = OPTAR.encodeBytes(input);
    const canvas = OPTAR.renderPageToCanvas(enc.pages[0], enc.geom, 1, { label: 'noisy' });
    const ctx = canvas.getContext('2d');
    const id = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const data = id.data;
    let flipped = 0;
    for (let p = 0; p < data.length; p += 4) {
      // 0.2% — well within BCH's t=3 per 63-bit codeword.
      if (Math.random() < 0.002) {
        const v = 255 - data[p];
        data[p] = v; data[p+1] = v; data[p+2] = v;
        flipped++;
      }
    }
    ctx.putImageData(id, 0, 0);
    const corrupted = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const dec = OPTAR.decodeImageData(corrupted);
    let mm = 0;
    for (let i = 0; i < N; i++) if (dec.bytes[i] !== input[i]) mm++;
    return { mm, flipped, stats: dec.stats.errors };
  });
  assertEqual(result.mm, 0,
    `noisy round-trip must recover input (flipped=${result.flipped}, stats=${JSON.stringify(result.stats)})`);
});

test('multi-page round-trip (400 KB)', async (page) => {
  const result = await page.evaluate(() => {
    const N = 400 * 1024;
    const input = new Uint8Array(N);
    let seed = 1;
    for (let i = 0; i < N; i++) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      input[i] = seed & 0xff;
    }
    const enc = OPTAR.encodeBytes(input);
    const decoded = new Uint8Array(N);
    let off = 0, irreparable = 0;
    for (const cells of enc.pages) {
      const canvas = OPTAR.renderPageToCanvas(cells, enc.geom, 1, { label: 'page' });
      const id = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height);
      const dec = OPTAR.decodeImageData(id);
      irreparable += dec.stats.errors[4];
      const take = Math.min(N - off, dec.bytes.length);
      decoded.set(dec.bytes.subarray(0, take), off);
      off += take;
      if (off >= N) break;
    }
    let mm = 0;
    for (let i = 0; i < N; i++) if (decoded[i] !== input[i]) mm++;
    return { mm, pages: enc.nPages, irreparable };
  });
  assert(result.pages >= 2, `expected >= 2 pages for 400 KB, got ${result.pages}`);
  assertEqual(result.mm, 0);
  assertEqual(result.irreparable, 0);
});

test('settings: smaller page (XCROSSES=33, YCROSSES=47)', async (page) => {
  const result = await page.evaluate(() => {
    const settings = { xcrosses: 33, ycrosses: 47 };
    const N = 256;
    const input = new Uint8Array(N);
    for (let i = 0; i < N; i++) input[i] = i;
    const enc = OPTAR.encodeBytes(input, settings);
    const canvas = OPTAR.renderPageToCanvas(enc.pages[0], enc.geom, 1, { label: 't' });
    const id = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height);
    const dec = OPTAR.decodeImageData(id, settings);
    let mm = 0;
    for (let i = 0; i < N; i++) if (dec.bytes[i] !== input[i]) mm++;
    return { mm, irreparable: dec.stats.errors[4] };
  });
  assertEqual(result.mm, 0);
  assertEqual(result.irreparable, 0);
});

test('edge case: empty file', async (page) => {
  const r = await page.evaluate(() =>
    ({ pages: OPTAR.encodeBytes(new Uint8Array(0)).nPages }));
  assertEqual(r.pages, 1);
});

test('edge case: 1-byte file', async (page) => {
  const r = await page.evaluate(() => {
    const input = new Uint8Array([0xa5]);
    const enc = OPTAR.encodeBytes(input);
    const canvas = OPTAR.renderPageToCanvas(enc.pages[0], enc.geom, 1, { label: 'x' });
    const id = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height);
    const dec = OPTAR.decodeImageData(id);
    return { first: dec.bytes[0], irreparable: dec.stats.errors[4] };
  });
  assertEqual(r.first, 0xa5);
  assertEqual(r.irreparable, 0);
});

test('edge case: file at exact page boundary', async (page) => {
  const r = await page.evaluate(() => {
    const geom = OPTAR.makeGeometry(65, 93);
    const N = geom.NETBITS / 8;
    const input = new Uint8Array(N);
    for (let i = 0; i < N; i++) input[i] = (i * 7) & 0xff;
    const enc = OPTAR.encodeBytes(input);
    return { pages: enc.nPages, n: N };
  });
  assertEqual(r.pages, 1, `${r.n}-byte file must use one page`);
});

test('edge case: one byte over page boundary spills to two pages', async (page) => {
  const r = await page.evaluate(() => {
    const geom = OPTAR.makeGeometry(65, 93);
    const input = new Uint8Array(geom.NETBITS / 8 + 1);
    input[input.length - 1] = 0xee;
    return { pages: OPTAR.encodeBytes(input).nPages };
  });
  assertEqual(r.pages, 2);
});

test('scale=3 round-trip (UI default)', async (page) => {
  const r = await page.evaluate(() => {
    const N = 256;
    const input = new Uint8Array(N);
    for (let i = 0; i < N; i++) input[i] = (i * 13 + 7) & 0xff;
    const enc = OPTAR.encodeBytes(input);
    const canvas = OPTAR.renderPageToCanvas(enc.pages[0], enc.geom, 3, { label: 'scale3' });
    const id = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height);
    const dec = OPTAR.decodeImageData(id);
    let mm = 0;
    for (let i = 0; i < N; i++) if (dec.bytes[i] !== input[i]) mm++;
    return { mm, irreparable: dec.stats.errors[4] };
  });
  assertEqual(r.mm, 0);
  assertEqual(r.irreparable, 0);
});

// ---------- header wrap/unwrap tests ----------

test('header: wrap/unwrap round-trip preserves bytes + filename + hash', async (page) => {
  const r = await page.evaluate(async () => {
    const N = 1024;
    const input = new Uint8Array(N);
    for (let i = 0; i < N; i++) input[i] = (i * 13 + 7) & 0xff;
    const wrapped = await OPTAR.wrapWithHeader(input, 'hello.bin');
    const u = await OPTAR.unwrapHeader(wrapped);
    let bodyMatch = u.body.length === N;
    for (let i = 0; bodyMatch && i < N; i++) if (u.body[i] !== input[i]) bodyMatch = false;
    return {
      hasHeader: u.hasHeader,
      filename: u.filename,
      hashOk: u.hashOk,
      bodyMatch,
      headerOverhead: wrapped.length - input.length,
    };
  });
  assert(r.hasHeader, 'unwrap must detect the magic');
  assertEqual(r.filename, 'hello.bin');
  assert(r.hashOk, 'embedded SHA-256 must verify');
  assert(r.bodyMatch, 'unwrapped body must match the input bytes');
  // 4 magic + 32 sha + 9 ("hello.bin") + 1 NUL = 46
  assertEqual(r.headerOverhead, 46);
});

test('header: unwrap on raw bytes (no magic) → hasHeader=false', async (page) => {
  const r = await page.evaluate(async () => {
    const raw = new Uint8Array([1, 2, 3, 4, 5]);
    const u = await OPTAR.unwrapHeader(raw);
    return { hasHeader: u.hasHeader, bodyLen: u.body.length };
  });
  assertEqual(r.hasHeader, false);
  assertEqual(r.bodyLen, 5);
});

test('header: tampered body fails hash check', async (page) => {
  const r = await page.evaluate(async () => {
    const input = new Uint8Array([1, 2, 3, 4]);
    const wrapped = await OPTAR.wrapWithHeader(input, 'a');
    // Flip one body byte (after the header).
    wrapped[wrapped.length - 1] ^= 0x01;
    const u = await OPTAR.unwrapHeader(wrapped);
    return { hasHeader: u.hasHeader, hashOk: u.hashOk };
  });
  assert(r.hasHeader);
  assertEqual(r.hashOk, false, 'tampered body must fail hash verification');
});

test('header: end-to-end via encode/decode preserves filename + hash', async (page) => {
  const r = await page.evaluate(async () => {
    const N = 256;
    const input = new Uint8Array(N);
    for (let i = 0; i < N; i++) input[i] = (Math.random() * 256) | 0;
    const wrapped = await OPTAR.wrapWithHeader(input, 'recovered.png');
    const enc = OPTAR.encodeBytes(wrapped);
    const canvas = OPTAR.renderPageToCanvas(enc.pages[0], enc.geom, 1, { label: 'h' });
    const id = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height);
    const dec = OPTAR.decodeImageData(id);
    const u = await OPTAR.unwrapHeader(dec.bytes);
    let match = u.body && u.body.length >= N;
    for (let i = 0; match && i < N; i++) if (u.body[i] !== input[i]) match = false;
    return { filename: u.filename, hashOk: u.hashOk, match };
  });
  assertEqual(r.filename, 'recovered.png');
  assert(r.hashOk, 'sha256 must verify after encode/decode');
  assert(r.match, 'decoded body must equal input');
});

test('format string round-trip', async (page) => {
  const r = await page.evaluate(() => {
    const geom = OPTAR.makeGeometry(65, 93);
    const f = OPTAR.buildFormatString(geom, 1, 1, 'foo');
    return { f, parsed: OPTAR.parseFormatString(f) };
  });
  assert(r.f.startsWith('0-65-93-24-3-10-2-24'), `unexpected format: ${r.f}`);
  assertEqual(r.parsed.xcrosses, 65);
  assertEqual(r.parsed.ycrosses, 93);
});

test('page capacity matches BCH(63, 45) at A4 default', async (page) => {
  const r = await page.evaluate(() => {
    const geom = OPTAR.makeGeometry(65, 93);
    return { fecSyms: geom.FEC_SYMS, netBytes: geom.NETBITS / 8 };
  });
  // FEC_SYMS = TOTALBITS / 63 = 50736; NETBITS = 50736 * 45 = 2,283,120 bits = 285,390 B.
  assertEqual(r.fecSyms, 50736);
  assertEqual(r.netBytes, 285390);
});

runAll().catch(err => { console.error(err); process.exit(1); });
