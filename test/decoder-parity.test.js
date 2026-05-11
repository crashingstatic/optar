// Decoder-parity stress tests: prove the JS decoder handles
// distorted/dirty/translated input the way the C/Java reference does.
//
// Each test renders a clean page, applies a synthetic distortion (rotation,
// translation+padding, brightness gradient, additive noise), and verifies
// the decoded bytes match the input exactly.

'use strict';

const path = require('path');
const fs = require('fs');
const puppeteer = require('puppeteer');

const HTML_PATH = path.resolve(__dirname, '..', 'browser', 'sloptar.html');

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
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
  });
  const page = await browser.newPage();
  page.on('pageerror', e => console.error('[pageerror]', e.message));
  await page.goto('file://' + HTML_PATH, { waitUntil: 'load' });
  await page.waitForFunction('window.SLOPTAR_READY === true', { timeout: 10000 });

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

// ---------- helpers (run inside the page) ----------

const HELPERS = `
function makeInput(N) {
  const a = new Uint8Array(N);
  let seed = 1;
  for (let i = 0; i < N; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    a[i] = seed & 0xff;
  }
  return a;
}
function encodeAtScale(input, scale, settings) {
  settings = settings || { xcrosses: 33, ycrosses: 47 }; // smaller page = faster test
  const enc = SLOPTAR.encodeBytes(input, settings);
  const canvas = SLOPTAR_RENDER.renderPageToCanvas(enc.pages[0], enc.geom, scale, { label: 'parity' });
  return { enc, canvas };
}
function compare(decBytes, input) {
  let mm = 0;
  for (let i = 0; i < input.length; i++) if (decBytes[i] !== input[i]) mm++;
  return mm;
}
function applyTransform(srcCanvas, opts) {
  // Render srcCanvas into a new canvas with translation/rotation/padding/etc.
  const padW = opts.padW || 0;
  const padH = opts.padH || 0;
  const dst = document.createElement('canvas');
  dst.width  = srcCanvas.width  + 2 * padW;
  dst.height = srcCanvas.height + 2 * padH;
  const ctx = dst.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  // White background (acts as scanner margin).
  ctx.fillStyle = 'white';
  ctx.fillRect(0, 0, dst.width, dst.height);
  ctx.translate(dst.width / 2, dst.height / 2);
  if (opts.rotate)  ctx.rotate(opts.rotate * Math.PI / 180);
  ctx.imageSmoothingEnabled = !!opts.smooth;
  ctx.drawImage(srcCanvas, -srcCanvas.width / 2, -srcCanvas.height / 2);
  return dst;
}
function injectGradient(imgData, frac) {
  // frac=0.5 → bottom of image is 50% as dark as the top.
  const W = imgData.width, H = imgData.height, d = imgData.data;
  for (let y = 0; y < H; y++) {
    const k = 1 - (1 - frac) * (y / (H - 1));
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      d[i]     = Math.min(255, Math.round(d[i]     * k + 255 * (1 - k)));
      d[i + 1] = Math.min(255, Math.round(d[i + 1] * k + 255 * (1 - k)));
      d[i + 2] = Math.min(255, Math.round(d[i + 2] * k + 255 * (1 - k)));
    }
  }
}
function injectGaussianNoise(imgData, sigma) {
  const d = imgData.data;
  for (let i = 0; i < d.length; i += 4) {
    const r = sigma * Math.sqrt(-2 * Math.log(Math.random() + 1e-9)) *
              Math.cos(2 * Math.PI * Math.random());
    const v = Math.max(0, Math.min(255, d[i] + r));
    d[i] = v; d[i + 1] = v; d[i + 2] = v;
  }
}
// Separable Gaussian blur in place. Operates on the R channel and copies to
// G/B for grayscale-equivalent output.
function injectGaussianBlur(imgData, sigma) {
  if (sigma <= 0) return;
  const W = imgData.width, H = imgData.height, d = imgData.data;
  const radius = Math.max(1, Math.ceil(sigma * 3));
  const kernel = [];
  let ksum = 0;
  for (let i = -radius; i <= radius; i++) {
    const v = Math.exp(-(i * i) / (2 * sigma * sigma));
    kernel.push(v);
    ksum += v;
  }
  for (let i = 0; i < kernel.length; i++) kernel[i] /= ksum;
  // Horizontal pass into a scratch buffer.
  const tmp = new Float32Array(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let acc = 0;
      for (let i = -radius; i <= radius; i++) {
        const xi = x + i < 0 ? 0 : (x + i >= W ? W - 1 : x + i);
        acc += d[(y * W + xi) * 4] * kernel[i + radius];
      }
      tmp[y * W + x] = acc;
    }
  }
  // Vertical pass back into the imageData.
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let acc = 0;
      for (let i = -radius; i <= radius; i++) {
        const yi = y + i < 0 ? 0 : (y + i >= H ? H - 1 : y + i);
        acc += tmp[yi * W + x] * kernel[i + radius];
      }
      const idx = (y * W + x) * 4;
      const v = Math.round(acc);
      d[idx] = v; d[idx + 1] = v; d[idx + 2] = v;
    }
  }
}
// Moiré: a low-frequency sinusoidal intensity ripple, simulating the beat
// pattern between the camera's Bayer grid and the monitor's pixel matrix.
function injectMoire(imgData, wavelengthPx, amplitude) {
  const W = imgData.width, H = imgData.height, d = imgData.data;
  const k     = (2 * Math.PI) / wavelengthPx;
  const angle = 0.27; // slight tilt so the bands aren't axis-aligned
  const cs = Math.cos(angle), sn = Math.sin(angle);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const phase = k * (x * cs + y * sn);
      const delta = amplitude * Math.sin(phase);
      const i = (y * W + x) * 4;
      const v = Math.max(0, Math.min(255, d[i] + delta));
      d[i] = v; d[i + 1] = v; d[i + 2] = v;
    }
  }
}
// Affine skew, approximating a perspective tilt for small angles. Real
// perspective is non-affine, but our decoder uses bilinear interpolation
// between crosses, which is exact for affine and a close approximation
// over the small cell-spacing distance for true perspective.
function applyAffineSkew(srcCanvas, tiltDegrees) {
  const W = srcCanvas.width, H = srcCanvas.height;
  const dst = document.createElement('canvas');
  dst.width = W;
  dst.height = H;
  const ctx = dst.getContext('2d');
  ctx.fillStyle = 'white';
  ctx.fillRect(0, 0, W, H);
  ctx.imageSmoothingEnabled = true;
  const skew = Math.tan(tiltDegrees * Math.PI / 180);
  // Skew x linearly with y so the top edge shifts right by skew*H/2 px.
  ctx.transform(1, 0, skew, 1, -skew * H / 2, 0);
  ctx.drawImage(srcCanvas, 0, 0);
  return dst;
}
`;

// ---------- tests ----------

test('decoder: white-margin padding (translated, no rotation)', async (page) => {
  const r = await page.evaluate(`
    (() => {
      ${HELPERS}
      const N = 256;
      const input = makeInput(N);
      const { enc, canvas } = encodeAtScale(input, 3);
      const padded = applyTransform(canvas, { padW: 80, padH: 80 });
      const id = padded.getContext('2d').getImageData(0, 0, padded.width, padded.height);
      const dec = SLOPTAR.decodeImageData(id, { xcrosses: 33, ycrosses: 47 });
      return { mm: compare(dec.bytes, input), irreparable: dec.stats.errors[4] };
    })()
  `);
  assertEqual(r.mm, 0, 'translated input must decode exactly');
  assertEqual(r.irreparable, 0);
});

test('decoder: small rotation (1°)', async (page) => {
  const r = await page.evaluate(`
    (() => {
      ${HELPERS}
      const N = 256;
      const input = makeInput(N);
      const { enc, canvas } = encodeAtScale(input, 4);
      const rotated = applyTransform(canvas, { rotate: 1, padW: 60, padH: 60, smooth: true });
      const id = rotated.getContext('2d').getImageData(0, 0, rotated.width, rotated.height);
      const dec = SLOPTAR.decodeImageData(id, { xcrosses: 33, ycrosses: 47 });
      return { mm: compare(dec.bytes, input), irreparable: dec.stats.errors[4],
               errors: dec.stats.errors };
    })()
  `);
  assertEqual(r.mm, 0,
    `1° rotation must decode exactly (irrep=${r.irreparable}, stats=${JSON.stringify(r.errors)})`);
});

test('decoder: 2° rotation with padding', async (page) => {
  const r = await page.evaluate(`
    (() => {
      ${HELPERS}
      const N = 256;
      const input = makeInput(N);
      const { enc, canvas } = encodeAtScale(input, 4);
      const rotated = applyTransform(canvas, { rotate: 2, padW: 80, padH: 80, smooth: true });
      const id = rotated.getContext('2d').getImageData(0, 0, rotated.width, rotated.height);
      const dec = SLOPTAR.decodeImageData(id, { xcrosses: 33, ycrosses: 47 });
      return { mm: compare(dec.bytes, input), irreparable: dec.stats.errors[4],
               errors: dec.stats.errors };
    })()
  `);
  assertEqual(r.mm, 0,
    `2° rotation must decode exactly (irrep=${r.irreparable}, stats=${JSON.stringify(r.errors)})`);
});

test('decoder: 15% brightness gradient (uneven scanner light)', async (page) => {
  const r = await page.evaluate(`
    (() => {
      ${HELPERS}
      const N = 256;
      const input = makeInput(N);
      const { enc, canvas } = encodeAtScale(input, 3);
      const padded = applyTransform(canvas, { padW: 40, padH: 40 });
      const id = padded.getContext('2d').getImageData(0, 0, padded.width, padded.height);
      // Bottom ≈ 85% as dark as the top — typical mid-range flatbed falloff.
      // Decoder relies on per-cross local cutlevels to handle this.
      injectGradient(id, 0.85);
      padded.getContext('2d').putImageData(id, 0, 0);
      const id2 = padded.getContext('2d').getImageData(0, 0, padded.width, padded.height);
      const dec = SLOPTAR.decodeImageData(id2, { xcrosses: 33, ycrosses: 47 });
      return { mm: compare(dec.bytes, input), irreparable: dec.stats.errors[4],
               errors: dec.stats.errors };
    })()
  `);
  assertEqual(r.mm, 0,
    `gradient must be handled by per-cross cutlevels (irrep=${r.irreparable})`);
});

test('decoder: gaussian noise σ=10 (typical scan grain)', async (page) => {
  const r = await page.evaluate(`
    (() => {
      ${HELPERS}
      const N = 256;
      const input = makeInput(N);
      const { enc, canvas } = encodeAtScale(input, 3);
      const id = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height);
      injectGaussianNoise(id, 10);
      canvas.getContext('2d').putImageData(id, 0, 0);
      const id2 = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height);
      const dec = SLOPTAR.decodeImageData(id2, { xcrosses: 33, ycrosses: 47 });
      return { mm: compare(dec.bytes, input), irreparable: dec.stats.errors[4],
               errors: dec.stats.errors };
    })()
  `);
  assertEqual(r.mm, 0, `gaussian noise σ=10 must decode (errors=${JSON.stringify(r.errors)})`);
});

// "Phone of monitor" — combines the realistic impairments of a handheld
// shot of a screen: framing rotation, perspective tilt, defocus blur,
// moiré beat between camera and monitor pixels, and sensor noise. None of
// these alone matches a Gaussian-σ noise model; together they're the
// closest we get to a synthetic capture of a real phone photo.
test('decoder: phone-of-monitor (rot + skew + defocus + moiré + noise)', async (page) => {
  const r = await page.evaluate(`
    (() => {
      ${HELPERS}
      const N = 256;
      const input = makeInput(N);
      const { enc, canvas } = encodeAtScale(input, 4); // scale=4 keeps cells
                                                       //  large enough to survive blur
      // Step 1: rotation and white-margin framing (handheld shot).
      let cv = applyTransform(canvas, { rotate: 1, padW: 60, padH: 60, smooth: true });
      // Step 2: affine skew approximating a 2° perspective tilt.
      cv = applyAffineSkew(cv, 2);
      // Step 3 onwards: defocus, moiré, noise. Modify in place via getImageData.
      const id = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height);
      injectGaussianBlur(id, 0.5);   // sub-pixel defocus, just-noticeable softness
      injectMoire(id, 17, 10);       // 17 px wavelength, ±10 grayscale ripple
      injectGaussianNoise(id, 6);    // σ=6 sensor noise (decent indoor light)
      cv.getContext('2d').putImageData(id, 0, 0);
      const id2 = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height);

      const dec = SLOPTAR.decodeImageData(id2, { xcrosses: 33, ycrosses: 47 });
      let mm = 0;
      for (let i = 0; i < N; i++) if (dec.bytes[i] !== input[i]) mm++;
      return {
        mm, errors: dec.stats.errors, irreparable: dec.stats.errors[4],
        canvasW: cv.width, canvasH: cv.height,
      };
    })()
  `);
  assertEqual(r.mm, 0,
    `phone-of-monitor must decode (irrep=${r.irreparable}, stats=${JSON.stringify(r.errors)})`);
});

test('decoder: rotation + padding + noise (combined)', async (page) => {
  const r = await page.evaluate(`
    (() => {
      ${HELPERS}
      const N = 200;
      const input = makeInput(N);
      const { enc, canvas } = encodeAtScale(input, 4);
      const rotated = applyTransform(canvas, { rotate: 1.5, padW: 60, padH: 60, smooth: true });
      const id = rotated.getContext('2d').getImageData(0, 0, rotated.width, rotated.height);
      injectGaussianNoise(id, 10);
      rotated.getContext('2d').putImageData(id, 0, 0);
      const id2 = rotated.getContext('2d').getImageData(0, 0, rotated.width, rotated.height);
      const dec = SLOPTAR.decodeImageData(id2, { xcrosses: 33, ycrosses: 47 });
      return { mm: compare(dec.bytes, input), irreparable: dec.stats.errors[4],
               errors: dec.stats.errors };
    })()
  `);
  assertEqual(r.mm, 0,
    `combined distortion must decode (irrep=${r.irreparable}, stats=${JSON.stringify(r.errors)})`);
});

runAll().catch(err => { console.error(err); process.exit(1); });
