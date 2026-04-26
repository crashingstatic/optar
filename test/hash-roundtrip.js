// End-to-end hash round-trip:
//   1. Generate random bytes, write to disk, hash.
//   2. Drive optar.html in headless Chromium to encode → PNG files on disk.
//   3. Re-load those PNG files into the browser, decode, write decoded bytes.
//   4. Trim to original length, hash, compare.
//
// Run:  node hash-roundtrip.js [byte-count]
'use strict';

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const puppeteer = require('puppeteer');

const HTML_PATH = path.resolve(__dirname, '..', 'browser', 'optar.html');
const FIXTURES = path.resolve(__dirname, 'fixtures');
const SIZE = parseInt(process.argv[2], 10) || 50 * 1024;

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

(async () => {
  if (!fs.existsSync(FIXTURES)) fs.mkdirSync(FIXTURES, { recursive: true });

  // --- step 1: random bytes → disk → hash
  const original = crypto.randomBytes(SIZE);
  const inputPath = path.join(FIXTURES, 'input.bin');
  fs.writeFileSync(inputPath, original);
  const inputHash = sha256(original);
  console.log(`generated  ${SIZE} bytes → ${inputPath}`);
  console.log(`           sha256 = ${inputHash}`);

  // --- step 2-3: encode → PNGs → decode in headless Chromium
  const browser = await puppeteer.launch({
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium',
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
  });
  const page = await browser.newPage();
  page.on('pageerror', err => console.error('[page error]', err.message));
  await page.goto('file://' + HTML_PATH, { waitUntil: 'load' });
  await page.waitForFunction('window.OPTAR_READY === true', { timeout: 10000 });

  // Encode in the page; serialise each rendered canvas as a PNG data-URL
  // so we can write it to disk just like a "Download PNG" click would.
  const t0 = Date.now();
  const encResult = await page.evaluate((bytesArr) => {
    const input = new Uint8Array(bytesArr);
    const enc = OPTAR.encodeBytes(input, { xcrosses: 65, ycrosses: 93 });
    const pngs = [];
    for (let i = 0; i < enc.pages.length; i++) {
      const canvas = OPTAR.renderPageToCanvas(
        enc.pages[i], enc.geom, 1,
        { label: OPTAR.buildFormatString(enc.geom, i + 1, enc.pages.length, 'hash-test') }
      );
      pngs.push(canvas.toDataURL('image/png'));
    }
    return { nPages: enc.pages.length, pngs };
  }, Array.from(original));
  const tEnc = Date.now() - t0;
  console.log(`encoded    ${encResult.nPages} page(s) in ${tEnc} ms`);

  // Persist the PNGs to disk.
  const pngPaths = [];
  for (let i = 0; i < encResult.pngs.length; i++) {
    const dataUrl = encResult.pngs[i];
    const b64 = dataUrl.replace(/^data:image\/png;base64,/, '');
    const p = path.join(FIXTURES, `page_${String(i + 1).padStart(4, '0')}.png`);
    fs.writeFileSync(p, Buffer.from(b64, 'base64'));
    pngPaths.push(p);
  }
  console.log(`           wrote PNGs: ${pngPaths.map(p => path.basename(p)).join(', ')}`);

  // Load each PNG back from disk, decode it.
  const t1 = Date.now();
  const decodedB64 = await page.evaluate(async (pngB64s) => {
    function loadImage(src) {
      return new Promise((res, rej) => {
        const img = new Image();
        img.onload = () => res(img);
        img.onerror = () => rej(new Error('image load failed'));
        img.src = src;
      });
    }
    const merged = [];
    const aggStats = [0, 0, 0, 0, 0];
    for (const b64 of pngB64s) {
      const img = await loadImage('data:image/png;base64,' + b64);
      const c = document.createElement('canvas');
      c.width = img.naturalWidth;
      c.height = img.naturalHeight;
      const cx = c.getContext('2d');
      cx.drawImage(img, 0, 0);
      const id = cx.getImageData(0, 0, c.width, c.height);
      const dec = OPTAR.decodeImageData(id, { xcrosses: 65, ycrosses: 93 });
      for (let k = 0; k < 5; k++) aggStats[k] += dec.stats.errors[k];
      for (let i = 0; i < dec.bytes.length; i++) merged.push(dec.bytes[i]);
    }
    // base64 encode in the page so we can ferry the bytes back over JSON cleanly.
    const u8 = new Uint8Array(merged);
    let bin = '';
    for (let i = 0; i < u8.length; i++) bin += String.fromCharCode(u8[i]);
    return { bytes: btoa(bin), stats: aggStats };
  }, pngPaths.map(p => fs.readFileSync(p).toString('base64')));
  const tDec = Date.now() - t1;
  console.log(`decoded    in ${tDec} ms`);
  console.log(`           golay stats: 0-err=${decodedB64.stats[0]} ` +
              `1-err=${decodedB64.stats[1]} 2-err=${decodedB64.stats[2]} ` +
              `3-err=${decodedB64.stats[3]} irreparable=${decodedB64.stats[4]}`);

  await browser.close();

  // --- step 4: trim, write, hash, compare
  const decodedAll = Buffer.from(decodedB64.bytes, 'base64');
  const decodedTrimmed = decodedAll.subarray(0, SIZE);
  const outputPath = path.join(FIXTURES, 'output.bin');
  fs.writeFileSync(outputPath, decodedTrimmed);
  const outputHash = sha256(decodedTrimmed);
  console.log(`recovered  ${decodedTrimmed.length} bytes → ${outputPath}`);
  console.log(`           sha256 = ${outputHash}`);

  if (inputHash === outputHash) {
    console.log('\n✓ HASH MATCH — round-trip is byte-exact');
    process.exit(0);
  } else {
    let firstDiff = -1;
    for (let i = 0; i < SIZE; i++) {
      if (original[i] !== decodedTrimmed[i]) { firstDiff = i; break; }
    }
    console.log(`\n✗ HASH MISMATCH — first diff at offset ${firstDiff}`);
    process.exit(1);
  }
})().catch(err => {
  console.error(err);
  process.exit(1);
});
