package com.twibright.optar;

import java.io.BufferedWriter;
import java.io.IOException;
import java.io.Writer;
import java.nio.file.Files;
import java.nio.file.Path;

/**
 * PostScript writer: replaces the shell {@code pgm2ps} + ImageMagick pipeline.
 *
 * Each PGM pixel is 0x00 or 0xff (optar never writes grayscale), so we emit a
 * 1-bit-per-pixel PostScript image. Each pixel prints as a 3x3 block of 600 DPI
 * printer dots, matching the original pipeline's geometry.
 *
 * Page layouts (all dimensions in PostScript points = 1/72 inch):
 *   A4:     595 x 842,  image 556.56 x 807.12 at (19.22, 17.44)
 *   Letter: 612 x 792,  image 573.84 x 755.28 at (19.08, 18.36)
 *
 * CLI: pgm2ps [-a4|-letter] &lt;file.pgm&gt; [more.pgm ...]
 */
public final class Pgm2Ps {

    enum Paper {
        A4     (595, 842, 19.22, 17.44, 556.56, 807.12),
        LETTER (612, 792, 19.08, 18.36, 573.84, 755.28);
        final double pageW, pageH, imgX, imgY, imgW, imgH;
        Paper(double pw, double ph, double ix, double iy, double iw, double ih) {
            pageW = pw; pageH = ph; imgX = ix; imgY = iy; imgW = iw; imgH = ih;
        }
    }

    public static void main(String[] args) throws IOException {
        Paper paper = Paper.A4;
        int i = 0;
        while (i < args.length && args[i].startsWith("-")) {
            switch (args[i]) {
                case "-a4":     paper = Paper.A4;     break;
                case "-letter": paper = Paper.LETTER; break;
                case "-h": case "--help":
                    usage(); return;
                default:
                    System.err.println("pgm2ps: unknown flag " + args[i]);
                    usage();
                    System.exit(1);
            }
            i++;
        }
        if (i >= args.length) { usage(); System.exit(1); }

        for (; i < args.length; i++) {
            Path in = Path.of(args[i]);
            String name = in.getFileName().toString();
            String outName = name.endsWith(".pgm")
                ? name.substring(0, name.length() - 4) + ".ps"
                : name + ".ps";
            Path out = in.resolveSibling(outName);
            System.out.println("Converting " + in + " to " + out);
            Pgm.Image img = Pgm.read(in);
            writePs(img, out, paper);
        }
    }

    private static void usage() {
        System.err.println(
            "usage: pgm2ps [-a4|-letter] <file.pgm> [...]\n" +
            "Converts each input PGM to a PostScript file with the same base name."
        );
    }

    static void writePs(Pgm.Image img, Path out, Paper paper) throws IOException {
        int w = img.width, h = img.height;
        int rowBytes = (w + 7) >>> 3;

        try (Writer wr = new BufferedWriter(Files.newBufferedWriter(out))) {
            wr.write("%!PS-Adobe-3.0\n");
            wr.write("%%Creator: optar (Java)\n");
            wr.write("%%Title: " + out.getFileName() + "\n");
            wr.write("%%BoundingBox: 0 0 " + (int) paper.pageW + " " + (int) paper.pageH + "\n");
            wr.write("%%Pages: 1\n");
            wr.write("%%EndComments\n");
            wr.write("%%Page: 1 1\n");
            wr.write("/picstr " + rowBytes + " string def\n");
            wr.write("gsave\n");
            wr.write(paper.imgX + " " + paper.imgY + " translate\n");
            wr.write(paper.imgW + " " + paper.imgH + " scale\n");
            // Image operator: in PostScript bit value 1 = white, 0 = black. Invert
            // so our bitmap matches: "true" in imagemask would mean invert; for
            // 1-bit image() we just write 1 for white pixels.
            wr.write(w + " " + h + " 1\n");
            // Image matrix: flip Y so (0,0) is upper-left in the source.
            wr.write("[" + w + " 0 0 -" + h + " 0 " + h + "]\n");
            wr.write("{ currentfile picstr readhexstring pop }\n");
            wr.write("image\n");

            writeHexBitmap(wr, img.pixels, w, h, rowBytes);

            wr.write("\ngrestore\nshowpage\n");
            wr.write("%%EOF\n");
        }
    }

    private static void writeHexBitmap(Writer wr, byte[] pixels, int w, int h, int rowBytes)
            throws IOException {
        char[] hex = "0123456789abcdef".toCharArray();
        char[] line = new char[rowBytes * 2];
        byte[] row  = new byte[rowBytes];
        for (int y = 0; y < h; y++) {
            // pack to 1 bpp: bit=1 means white (pixel != 0).
            for (int b = 0; b < rowBytes; b++) row[b] = 0;
            int base = y * w;
            for (int x = 0; x < w; x++) {
                if ((pixels[base + x] & 0xff) != 0) {
                    row[x >>> 3] |= (byte) (0x80 >> (x & 7));
                }
            }
            for (int b = 0; b < rowBytes; b++) {
                int v = row[b] & 0xff;
                line[b * 2]     = hex[v >>> 4];
                line[b * 2 + 1] = hex[v & 0x0f];
            }
            wr.write(line);
            wr.write('\n');
        }
    }
}
