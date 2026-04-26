# Optar Browser Edition — How-To Guide

## What is Optar?

Optar (OPTical ARchiver) encodes any file as a pattern of dots on paper.
Print the pattern with a laser printer. To recover the file later, scan the
paper and decode. Each A4/Letter page holds approximately 200 KB. Error
correction (Golay code) makes it resilient to paper folding, dust, and minor
damage.

Optar Browser Edition is a single, dependency-free HTML file. Open it in any
modern browser (Edge, Chrome, Firefox) on Windows, macOS, or Linux. No
installation, no internet, no Node.js, no npm.

## Encoding (File → Paper)

**Step 1: Open the application.**
Open `optar.html` in your browser. No internet connection required.

**Step 2: Select the Encode tab.**

**Step 3: Choose your file.**
Click "Choose File" and select any file you want to archive. The display will
show the file name, size, and how many pages will be needed.

**Step 4: Adjust settings (optional).**
Go to the Settings tab if you need to change paper size (A4 vs US Letter) or
grid density. Default settings work for most 600 DPI laser printers.

**Step 5: Click "Encode".**
The application will generate one or more page images. This may take a few
seconds for large files.

**Step 6: Print or download each page.**
- Click "Print" to send a page directly to your printer. Use your laser
  printer at 600 DPI or higher. Inkjet printers are NOT recommended.
- Click "Download PNG" to save the page image for later printing.

**Step 7: Record the format string.**
The format string (e.g. `0-65-93-24-3-1-2-24`) is printed at the bottom of
each page. You will need this for decoding. The first number is a literal
zero; the rest are layout parameters.

### Important notes

- The file is zero-padded to fill the last page. If your file format is
  sensitive to trailing zeros (e.g. plain text), wrap it in a tar or zip
  archive first.
- Print on white paper with a laser printer. Inkjet bleeds reduce
  reliability.
- Keep pages flat and clean. Folding is OK (Optar is designed to survive it)
  but avoid getting them wet.

## Decoding (Paper → File)

**Step 1: Scan your pages.**
Use a flatbed scanner at 600 DPI (1200 DPI is slightly better). Settings:

- **Format:** PNG (NOT JPEG — compression artifacts destroy data)
- **Color mode:** Grayscale
- **Gamma correction:** Off (set to 1.0)
- **Resolution:** 600 DPI minimum

Pro tip: Clean the scanner glass with rubbing alcohol first. Place a heavy
book on the scanner lid to press the paper flat.

**Step 2: Name your scan files.**
Name them so they sort in page order, e.g. `scan_0001.png`,
`scan_0002.png`, etc.

**Step 3: Open the application.**
Open `optar.html` in your browser. Select the **Decode** tab.

**Step 4: Upload scans.**
Click "Choose Files" and select all your scanned page images. They will be
processed in filename sort order.

**Step 5: Enter the format string.**
Type the format string from the bottom of any page into the format field
(e.g. `0-65-93-24-3-1-2-24`). The page sequence number doesn't matter; the
decoder uses XCROSSES and YCROSSES from the string.

**Step 6: Click "Decode".**
The decoder processes each page and displays Golay error statistics:

- **0 errors:** perfect readout (most codewords should be here)
- **1–3 errors:** corrected automatically by the Golay code
- **Uncorrectable:** data damage detected; those 12-bit symbols are
  unreliable

**Step 7: Download the decoded file.**
Click "Download decoded file" to save the recovered data.

## Troubleshooting

| Problem | Solution |
|---------|----------|
| High uncorrectable error count | Re-scan at higher DPI, clean scanner glass, press paper flatter |
| Decoder can't find corners | Ensure the entire page including borders is within the scan area |
| Pages out of order | Rename files to sort correctly; check page sequence numbers |
| File has trailing garbage | The original file was zero-padded; strip trailing zeros or unwrap from tar/zip |
| Blank output | Check that you entered the correct format string |

## Format string reference

The format string follows the Twibright Optar convention:

```
0-XCROSSES-YCROSSES-CPITCH-CHALF-FEC_ORDER-BORDER-TEXT_HEIGHT
```

For the default A4 layout this is `0-65-93-24-3-1-2-24`. The browser
implementation reads `XCROSSES` and `YCROSSES` from this string; the other
parameters are fixed at compile-time defaults that match the original C
implementation.
