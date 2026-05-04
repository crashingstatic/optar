# Optar — deferred features (FTODO)

These are features the user has approved for later implementation. Pick one
when ready.

---

## 1. BUG: MP4 encoding/decoding gets corrupted
I have only tried using fit-to-screen (the main use case for video output), but the number of frames do not match the number of encoded pages (98 frames versus 92 pages). Unsurprisingly, the round-trip test failed.

**Repro:** [test/fit-to-screen-video.test.js](test/fit-to-screen-video.test.js)
samples random fit-to-screen geometries and round-trips
test/test_files/test-*.bin through encode → recordPagesToVideo →
extractVideoFrames → stitch → unwrap. Every run currently fails.

**Root cause:** `recordPagesToVideo` uses `MediaRecorder`, which emits
H.264 / VP9 with default keyframe spacing (~1 s). Pages that fall between
keyframes are P-frames whose motion-estimation drift smears the
single-pixel BCH cells beyond what the BCH(63,45,t=3) code can correct;
only the keyframe-aligned page of each GOP decodes cleanly. The decoder
then sees `unique << nPages` and silently produces a truncated payload
with all pages CRC-OK but the wrong SHA.

**Fix sketch:** replace the `MediaRecorder` pipeline with a
`WebCodecs VideoEncoder` that emits `{ keyFrame: true }` for every page,
plus a minimal WebM/EBML muxer to write the resulting VP8/VP9 chunks to
a playable file. Confirmed during diagnosis that
`VideoEncoder({codec:'vp8'}) + keyFrame:true` round-trips the bits
cleanly; the only remaining work is muxing into a container.

---

## 2. Gzip compression
Add gzip compression to files before encoding and uncompress before decoding. This should be accomplished using only native javascript in the browser.

---

## 3. Color encoding (additional option)

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