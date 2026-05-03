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

## 2. Center encoding box on page when printing

Currently when attempting to print A4 or US-Letter, the box is aligned with the top-left corner which would make scanning the image back in difficult. Center the box left-right as well as top-down on the page when printing.

---