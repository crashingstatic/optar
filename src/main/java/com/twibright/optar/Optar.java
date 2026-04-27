package com.twibright.optar;

import java.io.BufferedInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Arrays;

/**
 * Optar encoder. Produces one or more P5 PGM pages per input file.
 *
 * CLI: optar &lt;input file&gt; [filename base]
 * Produces {base}_0001.pgm ... {base}_NNNN.pgm where base defaults to "optar_out"
 * and also becomes the human-readable file label at the bottom of every page.
 */
public final class Optar {

    private static final int WIDTH       = Common.WIDTH;
    private static final int DATA_WIDTH  = Common.DATA_WIDTH;
    private static final int DATA_HEIGHT = Common.DATA_HEIGHT;
    private static final int TEXT_WIDTH  = Common.TEXT_WIDTH;
    private static final int TEXT_HEIGHT = Common.TEXT_HEIGHT;
    private static final int BORDER      = Common.BORDER;
    private static final int CHALF       = Common.CHALF;
    private static final int CPITCH      = Common.CPITCH;
    private static final int HEIGHT      = 2 * BORDER + DATA_HEIGHT + TEXT_HEIGHT;

    private final byte[] ary = new byte[WIDTH * HEIGHT];
    private final int[]  xy  = new int[2];

    private final String base;
    private final String label;
    private final int    nPages;

    private int pageNumber;
    // BCH(63,45) needs a 46-bit accumulator (45 data bits + sentinel) — long.
    private long payloadAccu = 1L;
    private int  symbolIndex;

    private Optar(String base, String label, int nPages) {
        this.base   = base;
        this.label  = label;
        this.nPages = nPages;
    }

    public static void main(String[] args) throws IOException {
        if (args.length < 1) {
            System.err.println(
                "Usage: optar <input file> [filename base]\n\n" +
                "Encodes <input file> as a series of P5 PGM pages named\n" +
                "<base>_0001.pgm ... (base defaults to \"optar_out\"). Print the PGMs\n" +
                "on a 600+ DPI laser printer (use pgm2ps to convert to PostScript first)."
            );
            System.exit(1);
        }
        Path input = Path.of(args[0]);
        String base = args.length >= 2 ? args[1] : "optar_out";

        long size = Files.size(input);
        int nPages = (int) (((size * 8L) + Common.NETBITS - 1) / Common.NETBITS);
        if (nPages < 1) nPages = 1;
        if (nPages > 9999) {
            System.err.println("optar: too many pages - 10,000 or more");
            System.exit(1);
        }

        Optar enc = new Optar(base, base, nPages);
        try (InputStream in = new BufferedInputStream(Files.newInputStream(input))) {
            enc.encode(in);
        }
    }

    private void encode(InputStream in) throws IOException {
        newPage();
        int b;
        while ((b = in.read()) >= 0) {
            writeByte(b);
        }
        for (int i = Common.FEC_SMALLBITS - 1; i > 0; i--) {
            writePayloadBit(0);
        }
        flushPage();
    }

    private void writeByte(int b) {
        for (int bit = 7; bit >= 0; bit--) {
            writePayloadBit((b >> bit) & 1);
        }
    }

    private void writePayloadBit(int bit) {
        payloadAccu = (payloadAccu << 1) | (bit & 1L);
        if ((payloadAccu & (1L << Common.FEC_SMALLBITS)) != 0) {
            long data = payloadAccu & ((1L << Common.FEC_SMALLBITS) - 1);
            long code = Bch.encode(data);
            if (symbolIndex >= Common.FEC_SYMS) {
                newPage();
                symbolIndex = 0;
            }
            for (int shift = Common.FEC_LARGEBITS - 1; shift >= 0; shift--) {
                long seq = symbolIndex + (long) (Common.FEC_LARGEBITS - 1 - shift) * Common.FEC_SYMS;
                writeChannelBit((int) ((code >> shift) & 1L), seq);
            }
            payloadAccu = 1L;
            symbolIndex++;
        }
    }

    private void writeChannelBit(int bit, long seq) {
        byte value = (byte) ((bit & 1) != 0 ? 0x00 : 0xff); // 1 = black, 0 = white
        Common.seq2xy(xy, seq);
        int x = xy[0] + BORDER;
        int y = xy[1] + BORDER;
        ary[x + y * WIDTH] = value;
    }

    private void newPage() {
        if (pageNumber > 0) flushPage();
        if (pageNumber >= 9999) {
            throw new IllegalStateException("too many pages");
        }
        pageNumber++;
        formatPage();
    }

    private void flushPage() {
        String out = String.format("%s_%04d.pgm", base, pageNumber);
        try {
            Pgm.write(Path.of(out), ary, WIDTH, HEIGHT);
        } catch (IOException e) {
            throw new RuntimeException("cannot write " + out + ": " + e, e);
        }
    }

    private void formatPage() {
        Arrays.fill(ary, (byte) 0xff);
        drawBorder();
        drawCrosses();
        drawLabel();
    }

    private void drawBorder() {
        // Top border rows.
        for (int y = 0; y < BORDER; y++) {
            Arrays.fill(ary, y * WIDTH, y * WIDTH + WIDTH, (byte) 0);
        }
        // Left/right columns of the data area.
        for (int y = BORDER; y < BORDER + DATA_HEIGHT; y++) {
            int row = y * WIDTH;
            Arrays.fill(ary, row, row + BORDER, (byte) 0);
            Arrays.fill(ary, row + WIDTH - BORDER, row + WIDTH, (byte) 0);
        }
        // The text strip region gets cleared to black then overwritten by label(); the
        // final BORDER rows stay black.
        int textStart = (BORDER + DATA_HEIGHT) * WIDTH;
        Arrays.fill(ary, textStart, textStart + TEXT_HEIGHT * WIDTH, (byte) 0);
        int bottom = (BORDER + DATA_HEIGHT + TEXT_HEIGHT) * WIDTH;
        Arrays.fill(ary, bottom, bottom + BORDER * WIDTH, (byte) 0);
    }

    private void drawCrosses() {
        int maxY = HEIGHT - TEXT_HEIGHT - BORDER - 2 * CHALF;
        int maxX = WIDTH  - BORDER - 2 * CHALF;
        for (int y = BORDER; y <= maxY; y += CPITCH) {
            for (int x = BORDER; x <= maxX; x += CPITCH) {
                drawCross(x, y);
            }
        }
    }

    private void drawCross(int x, int y) {
        // A cross is a 2*CHALF square: upper-left + lower-right are black (0),
        // upper-right + lower-left are white (0xff).
        for (int r = 0; r < CHALF; r++) {
            int row = (y + r) * WIDTH + x;
            Arrays.fill(ary, row,         row + CHALF,        (byte) 0x00);
            Arrays.fill(ary, row + CHALF, row + 2 * CHALF,    (byte) 0xff);
            int row2 = row + CHALF * WIDTH;
            Arrays.fill(ary, row2,         row2 + CHALF,      (byte) 0xff);
            Arrays.fill(ary, row2 + CHALF, row2 + 2 * CHALF,  (byte) 0x00);
        }
    }

    private void drawLabel() {
        String txt = String.format("  0-%d-%d-%d-%d-%d-%d-%d %d/%d %s",
            Common.XCROSSES, Common.YCROSSES, Common.CPITCH, Common.CHALF,
            Common.FEC_ORDER, Common.BORDER, Common.TEXT_HEIGHT,
            pageNumber, nPages, label);

        // Prefix block: the right-most (font_width - TEXT_WIDTH*(127-' ')) pixels of the
        // font strip, copied to destX=0.
        int prefix = Font.WIDTH - TEXT_WIDTH * (127 - ' ');
        int destX = 0;
        drawFontBlock(destX, TEXT_WIDTH * (127 - ' '), prefix);
        destX = prefix;

        // Label text.
        for (int i = 0; i < txt.length(); i++) {
            char ch = txt.charAt(i);
            if (ch >= ' ' && ch <= 127) {
                drawFontBlock(destX, TEXT_WIDTH * (ch - ' '), TEXT_WIDTH);
                destX += TEXT_WIDTH;
            }
        }
    }

    private void drawFontBlock(int destX, int srcX, int width) {
        if (destX + width > DATA_WIDTH) return;
        for (int y = 0; y < TEXT_HEIGHT; y++) {
            int srcRow  = y * Font.WIDTH + srcX;
            int destRow = (BORDER + DATA_HEIGHT + y) * WIDTH + BORDER + destX;
            System.arraycopy(Font.PIXELS, srcRow, ary, destRow, width);
        }
    }
}
