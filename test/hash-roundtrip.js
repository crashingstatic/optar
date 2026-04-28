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

function sha256(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }

(async () => {
  if (!fs.existsSync(FIXTURES)) fs.mkdirSync(FIXTURES, { recursive: true });

  // 1) random bytes → disk → hash
  const original = crypto.randomBytes(SIZE);
  const inputPath = path.join(FIXTURES, 'input.bin');
  fs.writeFileSync(inputPath, original);
  const inputHash = sha256(original);
  console.log(`generated  ${SIZE} bytes → ${inputPath}`);
  console.log(`           sha256 = ${inputHash}`);

  // 2) encode in page → PNG files on disk
  const browser = await puppeteer.launch({
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium',
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
  });
  const page = await browser.newPage();
  page.on('pageerror', err => console.error('[page error]', err.message));
  await page.goto('file://' + HTML_PATH, { waitUntil: 'load' });
  await page.waitForFunction('window.OPTAR_READY === true', { timeout: 10000 });

  const t0 = Date.now();
  const enc = await page.evaluate(async (bytesArr) => {
    const input = new Uint8Array(bytesArr);
    const wrapped = await OPTAR.wrapWithHeader(input, 'input.bin');
    const result = OPTAR.encodeBytes(wrapped, { xcrosses: 65, ycrosses: 93 });
    const pngs = [];
    for (let i = 0; i < result.pages.length; i++) {
      const canvas = OPTAR_RENDER.renderPageToCanvas(
        result.pages[i], result.geom, 1,
        { label: OPTAR.buildFormatString(result.geom, i + 1, result.pages.length, 'hash-test') }
      );
      pngs.push(canvas.toDataURL('image/png'));
    }
    return {
      nPages: result.pages.length, pngs,
      bytesPerPage: result.geom.NETBITS / 8,
      headerOverhead: wrapped.length - input.length,
    };
  }, Array.from(original));
  console.log(`encoded    ${enc.nPages} page(s) in ${Date.now() - t0} ms ` +
              `(capacity ${enc.bytesPerPage} B/page, header ${enc.headerOverhead} B)`);

  const pngPaths = [];
  for (let i = 0; i < enc.pngs.length; i++) {
    const b64 = enc.pngs[i].replace(/^data:image\/png;base64,/, '');
    const p = path.join(FIXTURES, `page_${String(i + 1).padStart(4, '0')}.png`);
    fs.writeFileSync(p, Buffer.from(b64, 'base64'));
    pngPaths.push(p);
  }
  console.log(`           wrote PNGs: ${pngPaths.map(p => path.basename(p)).join(', ')}`);

  // 3) re-load PNGs from disk → decode in page → unwrap header
  const t1 = Date.now();
  const dec = await page.evaluate(async (pngB64s) => {
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
      const decoded = OPTAR.decodeImageData(id, { xcrosses: 65, ycrosses: 93 });
      for (let k = 0; k < 5; k++) aggStats[k] += decoded.stats.errors[k];
      for (let i = 0; i < decoded.bytes.length; i++) merged.push(decoded.bytes[i]);
    }
    const u8 = new Uint8Array(merged);
    const unwrapped = await OPTAR.unwrapHeader(u8);
    const body = unwrapped.hasHeader ? unwrapped.body : u8;
    let bin = '';
    for (let i = 0; i < body.length; i++) bin += String.fromCharCode(body[i]);
    return {
      bytes: btoa(bin), stats: aggStats,
      filename: unwrapped.filename || null,
      sha256: unwrapped.sha256 || null,
      hashOk: unwrapped.hashOk,
      hasHeader: unwrapped.hasHeader,
    };
  }, pngPaths.map(p => fs.readFileSync(p).toString('base64')));
  console.log(`decoded    in ${Date.now() - t1} ms`);
  console.log(`           bch stats: 0-err=${dec.stats[0]} ` +
              `1-err=${dec.stats[1]} 2-err=${dec.stats[2]} ` +
              `3-err=${dec.stats[3]} irreparable=${dec.stats[4]}`);
  if (dec.hasHeader) {
    console.log(`           header: filename="${dec.filename}", sha256=${dec.sha256.slice(0,16)}…, hashOk=${dec.hashOk}`);
  } else {
    console.log(`           header: (none — raw mode)`);
  }

  await browser.close();

  // 4) trim, write, hash, compare
  const decodedAll = Buffer.from(dec.bytes, 'base64');
  const decodedTrimmed = decodedAll.subarray(0, SIZE);
  const outputPath = path.join(FIXTURES, 'output.bin');
  fs.writeFileSync(outputPath, decodedTrimmed);
  const outputHash = sha256(decodedTrimmed);
  console.log(`recovered  ${decodedTrimmed.length} bytes → ${outputPath}`);
  console.log(`           sha256 = ${outputHash}`);

  if (inputHash === outputHash) {
    console.log('\n✓ HASH MATCH — round-trip is byte-exact');
    process.exit(0);
  }
  let firstDiff = -1;
  for (let i = 0; i < SIZE; i++) {
    if (original[i] !== decodedTrimmed[i]) { firstDiff = i; break; }
  }
  console.log(`\n✗ HASH MISMATCH — first diff at offset ${firstDiff}`);
  process.exit(1);
})().catch(err => { console.error(err); process.exit(1); });
