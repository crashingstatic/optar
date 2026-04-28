// Streaming-mode tests:
//  1. stitchFrames: dedup duplicate captures + concatenate unique pages.
//  2. End-to-end via WebM: render pages → MediaRecorder canvas-capture →
//     extract frames from the resulting Blob → stitch → unwrap → verify.
'use strict';

const path = require('path');
const puppeteer = require('puppeteer');

const HTML_PATH = path.resolve(__dirname, '..', 'browser', 'optar.html');

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }
function assertEqual(a, b, msg) {
  if (a !== b) throw new Error(`${msg || ''}\n  expected: ${b}\n    actual: ${a}`);
}

async function runAll() {
  const browser = await puppeteer.launch({
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium',
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
           '--autoplay-policy=no-user-gesture-required'],
  });
  const page = await browser.newPage();
  page.on('pageerror', e => console.error('[pageerror]', e.message));
  await page.goto('file://' + HTML_PATH, { waitUntil: 'load' });
  await page.waitForFunction('window.OPTAR_READY === true', { timeout: 10000 });

  let passed = 0, failed = 0;
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
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

// ---------- 1. Synthetic stitch test ----------

test('streaming: dedup + stitch from duplicated frame captures', async (page) => {
  const r = await page.evaluate(`(async () => {
    // 3-page payload (small page geometry to keep the test fast).
    const settings = { xcrosses: 33, ycrosses: 47 };
    const N = 3 * 1024;
    const input = new Uint8Array(N);
    let seed = 1;
    for (let i = 0; i < N; i++) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      input[i] = seed & 0xff;
    }
    // Force last byte non-zero so the trim-trailing-zeros unwrap doesn't
    // eat it (documented limitation of zero-terminated body framing).
    if (input[N - 1] === 0) input[N - 1] = 0xff;
    const wrapped = await OPTAR.wrapWithHeader(input, 'streaming-test.bin');
    const enc = OPTAR.encodeBytes(wrapped, settings);

    // Simulate 6 captured frames per page (mimics screen recording at ~60 fps
    // catching a 100 ms display).
    const FRAMES_PER_PAGE = 6;
    const frames = [];
    for (let p = 0; p < enc.pages.length; p++) {
      const canvas = OPTAR.renderPageToCanvas(enc.pages[p], enc.geom, 1, { label: 'stream' });
      const id = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height);
      for (let f = 0; f < FRAMES_PER_PAGE; f++) frames.push(id);
    }

    const stitched = await OPTAR.stitchFrames(frames, settings);
    const unwrapped = await OPTAR.unwrapHeader(stitched.bytes);
    let mm = 0;
    for (let i = 0; i < N; i++) if (unwrapped.body[i] !== input[i]) mm++;
    return {
      mm, hashOk: unwrapped.hashOk, filename: unwrapped.filename,
      framesIn: stitched.framesIn, unique: stitched.unique,
      dupes: stitched.dupes, failed: stitched.failed,
      pageCount: enc.pages.length,
    };
  })()`);
  assertEqual(r.mm, 0, 'stitched bytes must equal input');
  assert(r.hashOk, 'OPTR header SHA-256 must verify after stitch');
  assertEqual(r.filename, 'streaming-test.bin');
  assertEqual(r.unique, r.pageCount, 'one unique result per source page');
  assertEqual(r.dupes, r.framesIn - r.pageCount, 'remaining frames must be deduped');
  assertEqual(r.failed, 0);
});

// ---------- 2. Stitch tolerates noisy / non-identical duplicate frames ----------

// Real screen recordings produce frames that differ by a few pixels per page
// repetition (codec quantisation, capture timing). The stitcher needs to
// recognise these as the same page anyway. We model that by adding a tiny
// amount of pixel noise to each captured frame before decoding.
test('streaming: stitch handles noisy duplicate captures', async (page) => {
  const r = await page.evaluate(`(async () => {
    const settings = { xcrosses: 33, ycrosses: 47 };
    const N = 2 * 1024;
    const input = new Uint8Array(N);
    let seed = 1;
    for (let i = 0; i < N; i++) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      input[i] = seed & 0xff;
    }
    if (input[N - 1] === 0) input[N - 1] = 0xff;
    const wrapped = await OPTAR.wrapWithHeader(input, 'noisy-stream.bin');
    const enc = OPTAR.encodeBytes(wrapped, settings);

    function noisyImageData(canvas, sigma) {
      const ctx = canvas.getContext('2d');
      const id = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const d = id.data;
      for (let i = 0; i < d.length; i += 4) {
        const r = sigma * Math.sqrt(-2 * Math.log(Math.random() + 1e-9)) *
                  Math.cos(2 * Math.PI * Math.random());
        const v = Math.max(0, Math.min(255, d[i] + r));
        d[i] = v; d[i+1] = v; d[i+2] = v;
      }
      return id;
    }

    // Each page captured 5 times with independent low-σ noise per frame.
    const FRAMES_PER_PAGE = 5;
    const frames = [];
    for (let p = 0; p < enc.pages.length; p++) {
      const canvas = OPTAR.renderPageToCanvas(enc.pages[p], enc.geom, 1, { label: 'stream' });
      for (let f = 0; f < FRAMES_PER_PAGE; f++) {
        frames.push(noisyImageData(canvas, 4));
      }
    }

    const stitched = await OPTAR.stitchFrames(frames, settings);
    const unwrapped = await OPTAR.unwrapHeader(stitched.bytes);
    let mm = 0;
    for (let i = 0; i < N; i++) if (unwrapped.body[i] !== input[i]) mm++;
    return {
      mm, hashOk: unwrapped.hashOk,
      framesIn: stitched.framesIn, unique: stitched.unique,
      dupes: stitched.dupes, failed: stitched.failed,
      pageCount: enc.pages.length,
    };
  })()`);
  assertEqual(r.mm, 0, 'noisy duplicates must still stitch byte-exact');
  assert(r.hashOk, 'header SHA-256 must verify');
  assertEqual(r.unique, r.pageCount,
    `expected ${r.pageCount} unique pages, got ${r.unique} (dupes=${r.dupes}, failed=${r.failed})`);
});

// ---------- 3. Stitch ignores frames that decode to garbage ----------

// Mid-transition frames (where the playback canvas was caught between two
// pages) decode as junk with a high irreparable count. The stitcher should
// reject them via its irreparable-fraction threshold.
test('streaming: stitch rejects garbage / mid-transition frames', async (page) => {
  const r = await page.evaluate(`(async () => {
    const settings = { xcrosses: 33, ycrosses: 47 };
    const N = 1024;
    const input = new Uint8Array(N);
    for (let i = 0; i < N; i++) input[i] = ((i * 97) ^ 0xa5) & 0xff;
    if (input[N - 1] === 0) input[N - 1] = 0xff;
    const wrapped = await OPTAR.wrapWithHeader(input, 'mixed.bin');
    const enc = OPTAR.encodeBytes(wrapped, settings);

    // Build a synthetic frame sequence: a few good captures of page 1, a
    // garbage frame (random pixels), more good captures, garbage, etc.
    const goodCanvas = OPTAR.renderPageToCanvas(enc.pages[0], enc.geom, 1, { label: 'g' });
    const goodId = goodCanvas.getContext('2d').getImageData(0, 0, goodCanvas.width, goodCanvas.height);
    function garbageId(seed) {
      // Deterministic LCG so the test isn't subject to Math.random flakiness.
      let s = seed >>> 0;
      const c = document.createElement('canvas');
      c.width = goodCanvas.width;
      c.height = goodCanvas.height;
      const cx = c.getContext('2d');
      const id = cx.createImageData(c.width, c.height);
      for (let i = 0; i < id.data.length; i += 4) {
        s = (Math.imul(s, 1103515245) + 12345) >>> 0;
        const v = s & 0xff;
        id.data[i] = v; id.data[i+1] = v; id.data[i+2] = v; id.data[i+3] = 255;
      }
      return id;
    }

    const frames = [
      garbageId(1), garbageId(2),  // pre-roll
      goodId, goodId, goodId,      // page 1, several captures
      garbageId(3),                // mid-transition junk
      goodId, goodId,              // more good captures of page 1
      garbageId(4), garbageId(5),  // post-roll
    ];

    const stitched = await OPTAR.stitchFrames(frames, settings);
    const unwrapped = await OPTAR.unwrapHeader(stitched.bytes);
    let mm = 0;
    for (let i = 0; i < N; i++) if (unwrapped.body[i] !== input[i]) mm++;
    return {
      mm, hashOk: unwrapped.hashOk,
      unique: stitched.unique, dupes: stitched.dupes, failed: stitched.failed,
    };
  })()`);
  assertEqual(r.mm, 0, 'garbage frames must not corrupt the recovered bytes');
  assert(r.hashOk, 'header SHA-256 must still verify');
  assertEqual(r.unique, 1, 'exactly one unique page should be recovered');
  assert(r.failed >= 4, `at least 4 garbage frames must be rejected (got ${r.failed})`);
});

runAll().catch(err => { console.error(err); process.exit(1); });
