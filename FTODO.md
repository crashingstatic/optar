# Optar — deferred features (FTODO)

These are features the user has approved for later implementation. Pick one
when ready.

---

## 1. Color encoding (additional option)

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
- Format string flag: append `-c` or new FEC_ORDER like 12 = BCH-color.

Open questions:
- Color crosses: should crosses be black on all channels (to keep
  monochrome cross detection working) or per-channel? Probably all-black
  crosses + per-channel data.
- Reliability validation: a quick "is this scanner/printer color-accurate
  enough?" calibration page (encode a known pattern, decode, report
  per-channel error rate).

---

## 2. Drag-and-drop file input + progress bar

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
