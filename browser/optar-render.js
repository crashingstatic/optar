// optar-render.js — browser-only DOM/canvas helpers for Optar.
//
// Depends on window.OPTAR (load optar-codec.js first). Provides:
//   renderPageToCanvas(cells, geom, scale, opts)   — cells → HTMLCanvasElement
//   readFileAsBytes(file)                          — File/Blob → Uint8Array
//   readFileAsImageData(file)                      — image File → ImageData
//   extractVideoFrames(file, opts)                 — video File → ImageData[]
//   recordPagesToVideo(canvases, opts)             — page canvases → MP4/WebM Blob
//
// Pure UI / I/O glue; no FEC or geometry logic beyond what it pulls from
// the codec module.

(function () {
  'use strict';

  if (typeof window === 'undefined' || !window.OPTAR) {
    throw new Error('optar-render.js requires window.OPTAR (load optar-codec.js first)');
  }
  const { BORDER, CHALF, TEXT_HEIGHT } = window.OPTAR;

  // --------------------------------------------------------------------------
  // Render a page-cells Uint8Array (1 byte/cell, 0=black, 0xff=white) to a
  // fresh HTMLCanvasElement at `scale` pixels per cell. Optionally paints a
  // human-readable label over the bottom text strip.
  // --------------------------------------------------------------------------
  function renderPageToCanvas(cells, geom, scale, opts) {
    scale = scale | 0;
    if (scale < 1) scale = 1;
    const W = geom.WIDTH * scale;
    const H = geom.HEIGHT * scale;

    // Draw cells at logical resolution into a small canvas.
    const small = document.createElement('canvas');
    small.width = geom.WIDTH;
    small.height = geom.HEIGHT;
    const sctx = small.getContext('2d');
    const img = sctx.createImageData(geom.WIDTH, geom.HEIGHT);
    const d = img.data;
    for (let i = 0, j = 0; i < cells.length; i++, j += 4) {
      const v = cells[i];
      d[j] = v; d[j + 1] = v; d[j + 2] = v; d[j + 3] = 255;
    }
    sctx.putImageData(img, 0, 0);

    // Scale up into the full-size canvas with smoothing disabled.
    const big = document.createElement('canvas');
    big.width = W;
    big.height = H;
    const bctx = big.getContext('2d');
    bctx.imageSmoothingEnabled = false;
    bctx.drawImage(small, 0, 0, W, H);

    if (opts && opts.label) {
      const stripTop = (BORDER + geom.DATA_HEIGHT) * scale;
      const stripH   = TEXT_HEIGHT * scale;
      bctx.fillStyle = 'white';
      const fontPx = Math.max(8, Math.floor(stripH * 0.7));
      bctx.font = `${fontPx}px monospace`;
      bctx.textBaseline = 'middle';
      bctx.textAlign = 'left';
      bctx.fillText(opts.label, (BORDER + 4) * scale, stripTop + stripH / 2);
    }
    return big;
  }

  // --------------------------------------------------------------------------
  // File / Blob → Uint8Array.
  // --------------------------------------------------------------------------
  function readFileAsBytes(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(new Uint8Array(reader.result));
      reader.onerror = () => reject(reader.error);
      reader.readAsArrayBuffer(file);
    });
  }

  // --------------------------------------------------------------------------
  // Image File/Blob → ImageData (via offscreen canvas).
  // --------------------------------------------------------------------------
  function readFileAsImageData(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const img = new Image();
        img.onload = () => {
          const c = document.createElement('canvas');
          c.width = img.naturalWidth;
          c.height = img.naturalHeight;
          const cx = c.getContext('2d');
          cx.drawImage(img, 0, 0);
          resolve(cx.getImageData(0, 0, c.width, c.height));
        };
        img.onerror = () => reject(new Error('image decode failed'));
        img.src = reader.result;
      };
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(file);
    });
  }

  // --------------------------------------------------------------------------
  // Video File/Blob → ImageData[]. Uses seek-based extraction when the
  // container has duration metadata, with a play+rVFC fallback for
  // MediaRecorder blobs and other no-duration sources.
  // --------------------------------------------------------------------------
  async function extractVideoFrames(file, opts) {
    const sampleFps   = (opts && opts.sampleFps) || 30;
    const onProgress  = opts && opts.onProgress;
    const url = URL.createObjectURL(file);
    try {
      const video = document.createElement('video');
      video.src = url;
      video.muted = true;
      video.playsInline = true;
      video.preload = 'auto';
      await new Promise((res, rej) => {
        video.onloadedmetadata = () => res();
        video.onerror = () => rej(new Error('cannot load video (unsupported codec?)'));
      });
      const W = video.videoWidth;
      const H = video.videoHeight;
      let duration = video.duration;

      // Recover duration when the container header lacks it.
      if (!Number.isFinite(duration) || duration <= 0) {
        try {
          await new Promise((res, rej) => {
            video.onseeked = () => res();
            video.onerror  = () => rej(new Error('probe seek failed'));
            video.currentTime = 1e9;
          });
          duration = video.duration;
          if ((!Number.isFinite(duration) || duration <= 0) && video.seekable.length > 0) {
            duration = video.seekable.end(video.seekable.length - 1);
          }
        } catch (_) { /* fall through to playback path */ }
      }

      const canvas = document.createElement('canvas');
      canvas.width = W;
      canvas.height = H;
      const ctx = canvas.getContext('2d');

      if (Number.isFinite(duration) && duration > 0 && video.seekable.length > 0) {
        try {
          await new Promise((res) => { video.onseeked = () => res(); video.currentTime = 0; });
        } catch (_) {}
        const frames = [];
        const total = Math.max(1, Math.floor(duration * sampleFps));
        for (let i = 0; i < total; i++) {
          const t = (i + 0.5) / sampleFps;
          if (t >= duration) break;
          await new Promise((res, rej) => {
            video.onseeked = () => res();
            video.onerror  = () => rej(new Error('seek failed'));
            video.currentTime = t;
          });
          ctx.drawImage(video, 0, 0);
          frames.push(ctx.getImageData(0, 0, W, H));
          if (onProgress) onProgress(i + 1, total);
        }
        return { frames, width: W, height: H, duration };
      }

      // Playback fallback for un-seekable / no-duration containers.
      if (!video.requestVideoFrameCallback) {
        throw new Error('video has no duration metadata and rVFC is unavailable');
      }
      const frames = [];
      let lastFrameT = 0;
      await new Promise((resolve, reject) => {
        function onFrame(_, metadata) {
          ctx.drawImage(video, 0, 0);
          frames.push(ctx.getImageData(0, 0, W, H));
          lastFrameT = metadata.mediaTime;
          if (onProgress) onProgress(frames.length, -1);
          if (video.ended) { resolve(); return; }
          video.requestVideoFrameCallback(onFrame);
        }
        video.addEventListener('ended', () => resolve());
        video.addEventListener('error', () => reject(new Error('playback error')));
        video.requestVideoFrameCallback(onFrame);
        video.play().catch(reject);
      });
      return { frames, width: W, height: H, duration: lastFrameT };
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  // --------------------------------------------------------------------------
  // Record a sequence of page canvases into a video Blob (MP4 if supported,
  // else WebM). The output plays in any modern browser / native player; the
  // decoder ingests it via extractVideoFrames + OPTAR.stitchFrames.
  // --------------------------------------------------------------------------
  async function recordPagesToVideo(canvases, opts) {
    if (!canvases.length) throw new Error('no pages to record');
    if (typeof MediaRecorder === 'undefined') {
      throw new Error('MediaRecorder is not available in this browser');
    }
    const fps = (opts && opts.fps) || 10;
    const onProgress = opts && opts.onProgress;
    const intervalMs = 1000 / fps;

    // A playback canvas sized to the first page (all pages share dimensions
    // because they come from the same encode).
    const W = canvases[0].width;
    const H = canvases[0].height;
    const playback = document.createElement('canvas');
    playback.width = W;
    playback.height = H;
    const ctx = playback.getContext('2d');
    ctx.fillStyle = 'white';
    ctx.fillRect(0, 0, W, H);

    // Prefer MP4 (carries proper duration metadata so the decoder's seek-based
    // path works); fall back to WebM.
    const candidates = [
      'video/mp4;codecs=avc1.42E01E',
      'video/mp4',
      'video/webm;codecs=vp9',
      'video/webm;codecs=vp8',
      'video/webm',
    ];
    let mimeType = (opts && opts.mimeType) || '';
    if (!mimeType) {
      for (const m of candidates) {
        if (MediaRecorder.isTypeSupported(m)) { mimeType = m; break; }
      }
    }
    if (!mimeType) throw new Error('no supported MediaRecorder MIME type');

    const stream = playback.captureStream(fps * 2);
    const recorder = new MediaRecorder(stream, {
      mimeType,
      videoBitsPerSecond: (opts && opts.bitsPerSecond) || 8_000_000,
    });
    const chunks = [];
    recorder.ondataavailable = (ev) => { if (ev.data && ev.data.size) chunks.push(ev.data); };
    const stopped = new Promise((res) => { recorder.onstop = () => res(); });

    recorder.start(100); // emit chunks every 100 ms so a long recording streams
    for (let i = 0; i < canvases.length; i++) {
      ctx.fillStyle = 'white';
      ctx.fillRect(0, 0, W, H);
      ctx.drawImage(canvases[i], 0, 0);
      if (onProgress) onProgress(i + 1, canvases.length);
      await new Promise((res) => setTimeout(res, intervalMs));
    }
    // Trailing hold so the recorder catches the final page.
    await new Promise((res) => setTimeout(res, intervalMs * 2));
    recorder.stop();
    stream.getTracks().forEach((t) => t.stop());
    await stopped;

    return { blob: new Blob(chunks, { type: mimeType }), mimeType, durationS: canvases.length / fps };
  }

  window.OPTAR_RENDER = {
    renderPageToCanvas,
    readFileAsBytes,
    readFileAsImageData,
    extractVideoFrames,
    recordPagesToVideo,
  };
})();
