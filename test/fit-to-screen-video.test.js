// Fit-to-screen video round-trip stress test.
//
// Samples random XCROSSES/YCROSSES in the range fit-to-screen would pick,
// encodes each test file in test/test_files/, records a video via
// recordPagesToVideo (the same API the UI's "Download as video" button
// uses), extracts frames, stitches, unwraps, and compares SHA-256 against
// the SHAs file shipped alongside the test inputs.
//
// Regression test for FTODO #1. Original failure mode: with a plain
// page-after-page render, MediaRecorder's H.264/VP8/VP9 encoder
// inter-frame-predicts each page from the previous one. The single-pixel
// BCH cells are too high-frequency to survive the codec's motion-estimation
// chain past the first keyframe, so most pages decoded as miscorrected
// garbage and SHA-256 mismatched even when per-page CRC passed.
//
// Fix in recordPagesToVideo: insert an alternating black/white flash
// sequence between every page (4 cycles × 50 ms by default). The flashes
// are visually distinct enough that VP8's scene-cut detector emits a fresh
// keyframe for each page, breaking the cross-page reference chain. VP8 is
// preferred over H.264 because H.264 still smears even with flashes.
// Default cadence dropped to 1 page/sec to give each page a clean hold
// window in the recorded video.
//
// Run from /workspace/test:
//   PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium ITERS=2 node fit-to-screen-video.test.js
//
// Env knobs: ITERS (per-file, default 2), FPS (pps, default 1),
// MIME, BPS (override mimeType / bitsPerSecond on the recorder).

'use strict';

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const puppeteer = require('puppeteer');

const HTML_PATH = path.resolve(__dirname, '..', 'browser', 'sloptar.html');
const FILES_DIR = path.resolve(__dirname, 'test_files');
const SHAS_PATH = path.join(FILES_DIR, 'SHAs');

function sha256Hex(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function loadExpectedShas() {
  const out = {};
  const text = fs.readFileSync(SHAS_PATH, 'utf8');
  for (const line of text.split('\n')) {
    const m = line.trim().match(/^([0-9a-f]+)\s+(.+)$/);
    if (m) out[m[2]] = m[1];
  }
  return out;
}

// Random integer in [lo, hi], inclusive. Seed is mixed in via Math.random;
// we don't need cryptographic randomness here — failures should be
// reproducible by loosening the range, not by replay.
function randInt(lo, hi) { return lo + Math.floor(Math.random() * (hi - lo + 1)); }

const ITERATIONS_PER_FILE = parseInt(process.env.ITERS || '2', 10);
const FILES = [
  'test-125.bin',
  'test-250.bin',
  'test-375.bin',
  'test-500.bin',
  'test-750.bin',
  'test-1000.bin',
];

(async () => {
  // test_files/ is .gitignored — these are user-supplied pseudorandom
  // fixtures. Skip gracefully if a CI checkout doesn't have them.
  if (!fs.existsSync(SHAS_PATH)) {
    console.log(`skip: ${SHAS_PATH} not found — drop test files into ` +
                `test/test_files/ to enable this test`);
    return;
  }
  const expectedShas = loadExpectedShas();
  for (const f of FILES) {
    if (!expectedShas[f]) throw new Error(`no expected SHA for ${f}`);
    const onDisk = sha256Hex(fs.readFileSync(path.join(FILES_DIR, f)));
    if (onDisk !== expectedShas[f]) {
      throw new Error(`SHAs file mismatches on-disk for ${f}: ${onDisk} vs ${expectedShas[f]}`);
    }
  }

  const browser = await puppeteer.launch({
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium',
    headless: 'new',
    // 1 MB test file at fit-to-screen geometry yields 50+ pages; at 1 pps
    // that's a ~50 s recording plus ~1500 frames to extract and decode in
    // a single page.evaluate. Default 30 s protocolTimeout times out.
    protocolTimeout: 600_000,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
           '--autoplay-policy=no-user-gesture-required'],
  });
  const page = await browser.newPage();
  page.on('pageerror', e => console.error('[pageerror]', e.message));
  page.on('console', msg => {
    if (process.env.VERBOSE === '1') console.log('[page]', msg.text());
  });
  await page.goto('file://' + HTML_PATH, { waitUntil: 'load' });
  await page.waitForFunction('window.SLOPTAR_READY === true', { timeout: 10000 });

  // Push the test files into the browser context once; we'll reference
  // them by name in each round-trip.
  const filesPayload = {};
  for (const f of FILES) {
    filesPayload[f] = Array.from(fs.readFileSync(path.join(FILES_DIR, f)));
  }
  await page.evaluate((files, mime, bps) => {
    window.__TEST_FILES = {};
    for (const [name, arr] of Object.entries(files)) {
      window.__TEST_FILES[name] = new Uint8Array(arr);
    }
    if (mime) window.__FORCE_MIME = mime;
    if (bps)  window.__FORCE_BPS  = bps;
  }, filesPayload, process.env.MIME || '', parseInt(process.env.BPS || '0', 10) || 0);

  let runs = 0, ok = 0, fail = 0;
  const failures = [];

  for (const fname of FILES) {
    for (let iter = 0; iter < ITERATIONS_PER_FILE; iter++) {
      // Sample geometry in a range typical of fit-to-screen on common
      // viewports (laptop / desktop / phone). Keeps each page small so
      // the test files always span >=2 pages.
      const xcrosses = randInt(20, 50);
      const ycrosses = randInt(15, 50);
      const fps = parseInt(process.env.FPS || '10', 10);
      runs++;

      const start = Date.now();
      const r = await page.evaluate(async (args) => {
        const { fname, xcrosses, ycrosses, fps } = args;
        const settings = { xcrosses, ycrosses, scale: 1 };
        const fileBytes = window.__TEST_FILES[fname];

        const wrapped = await SLOPTAR.wrapWithHeader(fileBytes, fname);
        const enc = SLOPTAR.encodeBytes(wrapped, settings);
        const canvases = enc.pages.map((cells, i) =>
          SLOPTAR_RENDER.renderPageToCanvas(cells, enc.geom, 1, {
            label: SLOPTAR.buildFormatString(enc.geom, i + 1, enc.nPages, 'fit-vid'),
          }));

        const recOpts = { fps };
        if (window.__FORCE_MIME) recOpts.mimeType = window.__FORCE_MIME;
        if (window.__FORCE_BPS)  recOpts.bitsPerSecond = window.__FORCE_BPS;
        const { blob, mimeType } = await SLOPTAR_RENDER.recordPagesToVideo(canvases, recOpts);
        const file = new File([blob], 'roundtrip.' + (mimeType.includes('mp4') ? 'mp4' : 'webm'),
                              { type: mimeType });

        const { frames } = await SLOPTAR_RENDER.extractVideoFrames(file, { sampleFps: 30 });
        const stitched = await SLOPTAR.stitchFrames(frames, settings);
        const unwrapped = await SLOPTAR.unwrapHeader(stitched.bytes);

        // Hash the recovered body for the test runner to compare against
        // the on-disk SHA, in addition to the in-payload SHA verdict.
        let bodyHashHex = '';
        if (unwrapped.body && unwrapped.body.length) {
          const h = await crypto.subtle.digest('SHA-256', unwrapped.body);
          bodyHashHex = Array.from(new Uint8Array(h))
            .map((b) => b.toString(16).padStart(2, '0')).join('');
        }

        return {
          mimeType,
          nPages: enc.nPages,
          framesIn: stitched.framesIn,
          unique: stitched.unique,
          dupes: stitched.dupes,
          failed: stitched.failed,
          aggErrors: stitched.stats.errors,
          crcPagesOk: stitched.stats.crcPagesOk,
          crcPagesFail: stitched.stats.crcPagesFail,
          hasHeader: unwrapped.hasHeader,
          headerHashOk: unwrapped.hashOk === true,
          recoveredFilename: unwrapped.filename,
          recoveredBytes: unwrapped.body ? unwrapped.body.length : 0,
          bodyHashHex,
        };
      }, { fname, xcrosses, ycrosses, fps });
      const elapsed = Date.now() - start;

      const expected = expectedShas[fname];
      const passes = r.hasHeader && r.headerHashOk && r.bodyHashHex === expected
                     && r.recoveredFilename === fname;
      const tag = passes ? 'ok  ' : 'FAIL';
      console.log(
        `  ${tag} ${fname.padEnd(14)} X=${String(xcrosses).padStart(2)} Y=${String(ycrosses).padStart(2)} ` +
        `${r.mimeType.replace(/;.*/, '').padEnd(11)} ` +
        `pages=${r.nPages} frames=${r.framesIn} uniq=${r.unique} dup=${r.dupes} fail=${r.failed} ` +
        `CRC=${r.crcPagesOk}/${r.crcPagesOk + r.crcPagesFail} ` +
        `bytes=${r.recoveredBytes} (${elapsed} ms)`
      );
      if (passes) {
        ok++;
      } else {
        fail++;
        failures.push({
          fname, xcrosses, ycrosses, expected, got: r.bodyHashHex,
          headerHashOk: r.headerHashOk, hasHeader: r.hasHeader,
          recoveredFilename: r.recoveredFilename,
          recoveredBytes: r.recoveredBytes,
          aggErrors: r.aggErrors, crcPagesOk: r.crcPagesOk,
          crcPagesFail: r.crcPagesFail, unique: r.unique, nPages: r.nPages,
        });
      }
    }
  }

  await browser.close();

  console.log(`\n${ok} passed, ${fail} failed of ${runs} runs`);
  if (fail) {
    console.log('\nfailures:');
    for (const f of failures) {
      console.log(`  ${f.fname} X=${f.xcrosses} Y=${f.ycrosses}: ` +
        `header=${f.hasHeader} hashOk=${f.headerHashOk} ` +
        `unique/pages=${f.unique}/${f.nPages} CRC=${f.crcPagesOk}ok/${f.crcPagesFail}fail ` +
        `recovered=${f.recoveredBytes}B name=${f.recoveredFilename}`);
      console.log(`    expected=${f.expected}`);
      console.log(`    got     =${f.got}`);
    }
    process.exit(1);
  }
})().catch(err => {
  console.error(err);
  process.exit(1);
});
