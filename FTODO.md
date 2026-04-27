# Optar — deferred features (FTODO)

These are features the user has approved for later implementation. Not yet
started. Pick one when ready.

---

## 1. Streaming mode (encode display + video decode)

**Encode side** — opt-in toggle in the Settings tab:

- After clicking "Encode", show a 3-second countdown.
- Then display each rendered page full-screen at **10 pages/sec** (100 ms/page).
- User screen-records during playback (OS-native, OBS, QuickTime, etc.).
- Pages cycle once and stop. Optional loop toggle for re-recording.

Implementation notes:
- Likely a new "Stream" output mode alongside "Print" / "Download PNG".
- Use `requestAnimationFrame` rather than `setTimeout` for frame-accurate cadence.
- Hide all browser chrome — `Element.requestFullscreen()`.
- Black background between pages so the decoder can detect frame boundaries.
- Print the page sequence number prominently so a partial recording can be repaired.

**Decode side** — accept MP4 in the Decode tab:

- File input accepts `video/mp4` in addition to images.
- Use `<video>` + `requestVideoFrameCallback` (Chromium) or sample at fixed
  rate via `currentTime` stepping to extract frames.
- Each frame: detect "is this an Optar page?" (border bbox + cross sample).
  Skip transition/black frames.
- Deduplicate: the same page shows for multiple frames at 60 fps capture vs
  10 fps display, so we get ~6 frames per page. Pick the sharpest, or
  decode all and majority-vote per codeword.
- Stitch decoded pages back in sequence-number order.

Open questions:
- Frame sync: should we emit a small per-frame counter (visible in the
  format-string region) so the decoder doesn't have to guess?
- What MP4 codec to assume? H.264 baseline works in `<video>`.
- Memory: a 30s 1080p video is hundreds of MB to decode in-browser. Stream
  through `MediaSource` or `WebCodecs` (`VideoDecoder`) instead of loading
  whole file.

References:
- `requestVideoFrameCallback`: <https://web.dev/articles/requestvideoframecallback-rvfc>
- `WebCodecs` `VideoDecoder`: <https://developer.mozilla.org/en-US/docs/Web/API/WebCodecs_API>

---

## 2. Color encoding (additional option)

Independent R/G/B channel encoding for **3× density** at the cost of needing
a color printer + color scanner.

- New page-size / encoding option: "Color (3× density)".
- Encoder splits the bit stream into 3 sub-streams; each is BCH-encoded and
  rendered into its own channel of the canvas:
  - Red bits → red channel (0 or 255), green and blue stay 0/255 too —
    wait, simpler: each cell gets RGB = (R, G, B) where each is 0 or 255
    independently from its own sub-stream.
- Decoder splits the imageData back into 3 single-channel images, runs the
  existing decode path on each, concatenates.
- Per-channel cutlevels (printer ink densities differ per channel).
- Format string flag: append `-c` or new FEC_ORDER like 11 = BCH-color.

Open questions:
- Color crosses: should crosses be black on all channels (to keep
  monochrome cross detection working) or per-channel? Probably all-black
  crosses + per-channel data.
- Reliability validation: a quick "is this scanner/printer color-accurate
  enough?" calibration page (encode a known pattern, decode, report
  per-channel error rate).

---

## 3. Per-page CRC

- Reserve a fixed number of bytes (e.g. 4-byte CRC32 = ~5.6 BCH codewords) at
  the **end** of each page's payload region.
- CRC32 is computed over the page's net data bytes (after BCH decode).
- Decoder reports per-page CRC pass/fail. If a page fails CRC, mark that
  page's decoded bytes as suspect — useful when combined with the planned
  cross-page erasure code (then the decoder can erase a bad page and
  recover from parity).
- Pure overhead, but small (~0.001% at 199 KB/page).
- Implementation: trivial CRC32 table + 4-byte header in the per-page byte
  stream.

---

## 4. Drag-and-drop file input + progress bar

Two related UX improvements:

**Drag-and-drop:**
- Encode tab: dashed border on the panel when a file is dragged over.
- On drop, populate the file input.
- Same on the Decode tab for multi-image drops.

**Progress bar:**
- Encoding a 200 KB file currently freezes the tab for ~2s. Multi-page
  encodes (1 MB+) freeze for 10+ seconds.
- Move the encode loop into a `Web Worker`. Yield page-by-page progress to
  the main thread; render the progress bar.
- Same for decode (worker per page, parallel-safe since each page is
  independent).
- Bonus: show a live preview of the page being encoded.

Implementation hints:
- `OffscreenCanvas` lets the worker render directly without postMessage'ing
  raw pixel data back.
- The codec functions are already pure; porting them into a worker is a
  matter of wrapping the script in a `Blob` URL or splitting the file.
