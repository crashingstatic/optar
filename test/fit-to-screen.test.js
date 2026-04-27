// Verify the "Fit to screen" preset:
//  - Picks XCROSSES/YCROSSES that fit the viewport at the chosen scale.
//  - Round-trips a hash through encode → screenshot-style canvas → decode.
'use strict';

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const puppeteer = require('puppeteer');

const HTML_PATH = path.resolve(__dirname, '..', 'browser', 'optar.html');

const VIEWPORTS = [
  { name: '4K',       width: 3840, height: 2160, scale: 3 },
  { name: '1440p',    width: 2560, height: 1440, scale: 3 },
  { name: '1080p',    width: 1920, height: 1080, scale: 3 },
  { name: '1366x768', width: 1366, height: 768,  scale: 2 },
  { name: 'small',    width: 1024, height: 768,  scale: 2 },
];

(async () => {
  const browser = await puppeteer.launch({
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium',
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
  });

  let passed = 0, failed = 0;
  for (const v of VIEWPORTS) {
    const page = await browser.newPage();
    await page.setViewport({ width: v.width, height: v.height });
    page.on('pageerror', e => console.error(`[${v.name} pageerror]`, e.message));

    await page.goto('file://' + HTML_PATH, { waitUntil: 'load' });
    await page.waitForFunction('window.OPTAR_READY === true', { timeout: 10000 });

    // Set scale, switch to Fit to screen, read computed dimensions.
    const fit = await page.evaluate((scale) => {
      document.getElementById('set-scale').value = String(scale);
      document.getElementById('set-scale').dispatchEvent(new Event('input'));
      const sel = document.getElementById('set-paper');
      sel.value = 'Fit';
      sel.dispatchEvent(new Event('change'));
      const x = parseInt(document.getElementById('set-xcrosses').value, 10);
      const y = parseInt(document.getElementById('set-ycrosses').value, 10);
      const geom = OPTAR.makeGeometry(x, y);
      return {
        x, y,
        canvasW: geom.WIDTH * scale,
        canvasH: geom.HEIGHT * scale,
        netBytes: geom.NETBITS / 8,
      };
    }, v.scale);

    // Sanity: canvas must fit viewport with chrome reserved (~110 px tall).
    const fitsW = fit.canvasW <= v.width;
    const fitsH = fit.canvasH <= v.height - 110;
    const okFit = fitsW && fitsH;

    // Hash round-trip at this page size to prove the pipeline still works.
    const N = Math.min(fit.netBytes, 4096);
    const original = crypto.randomBytes(N);
    const expectedHash = crypto.createHash('sha256').update(original).digest('hex');
    const got = await page.evaluate((bytesArr, scale) => {
      const input = new Uint8Array(bytesArr);
      const xc = parseInt(document.getElementById('set-xcrosses').value, 10);
      const yc = parseInt(document.getElementById('set-ycrosses').value, 10);
      const enc = OPTAR.encodeBytes(input, { xcrosses: xc, ycrosses: yc });
      const canvas = OPTAR.renderPageToCanvas(enc.pages[0], enc.geom, scale, { label: 'fit' });
      const id = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height);
      const dec = OPTAR.decodeImageData(id, { xcrosses: xc, ycrosses: yc });
      const out = dec.bytes.subarray(0, input.length);
      // Cheap sha256 in browser via SubtleCrypto
      return crypto.subtle.digest('SHA-256', out).then(h => {
        const v = new Uint8Array(h);
        let s = '';
        for (let i = 0; i < v.length; i++) s += v[i].toString(16).padStart(2, '0');
        return { hash: s, irreparable: dec.stats.errors[4] };
      });
    }, Array.from(original), v.scale);

    const hashOk = (got.hash === expectedHash) && got.irreparable === 0;
    const ok = okFit && hashOk;
    const tag = ok ? '✓' : '✗';
    console.log(
      `${tag} ${v.name.padEnd(9)} (${v.width}×${v.height}, scale=${v.scale}): ` +
      `picked X=${fit.x}, Y=${fit.y} → canvas ${fit.canvasW}×${fit.canvasH} ` +
      `(${fitsW ? '✓W' : '✗W'} ${fitsH ? '✓H' : '✗H'}), ` +
      `${(fit.netBytes / 1024).toFixed(1)} KB/page, ` +
      `hash ${hashOk ? 'MATCH' : 'MISMATCH'}`
    );
    if (ok) passed++; else failed++;
    await page.close();
  }
  await browser.close();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
})().catch(err => { console.error(err); process.exit(1); });
