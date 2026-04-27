package com.twibright.optar;

/**
 * Geometry constants and shared bit/pixel routines, ported from optar.h,
 * common.c and parity.c.
 *
 * The document is laid out as a repeating pair of horizontal strips:
 *   - narrow strip: height 2*CHALF, interrupted by crosses at CPITCH intervals.
 *   - wide   strip: height CPITCH - 2*CHALF, full width, no crosses.
 * The narrow-wide pair repeats (YCROSSES-1) times, followed by a final narrow strip.
 */
public final class Common {
    private Common() {}

    /** Thickness of the border, in pixels. */
    public static final int BORDER = 2;
    /** Size of a cross half. Crosses are 2*CHALF x 2*CHALF. */
    public static final int CHALF  = 3;
    /** Distance between cross centres. */
    public static final int CPITCH = 24;

    /** Crosses horizontally. A4=65, US Letter=67. */
    public static final int XCROSSES = 65;
    /** Crosses vertically. A4=93, US Letter=87. */
    public static final int YCROSSES = 93;

    public static final int DATA_WIDTH  = CPITCH * (XCROSSES - 1) + 2 * CHALF;
    public static final int DATA_HEIGHT = CPITCH * (YCROSSES - 1) + 2 * CHALF;
    public static final int WIDTH       = 2 * BORDER + DATA_WIDTH;

    public static final int TEXT_WIDTH  = 13;
    public static final int TEXT_HEIGHT = 24;

    public static final int NARROWHEIGHT = 2 * CHALF;
    public static final int GAPWIDTH     = CPITCH - 2 * CHALF;
    public static final int NARROWWIDTH  = GAPWIDTH * (XCROSSES - 1);
    public static final int NARROWPIXELS = NARROWHEIGHT * NARROWWIDTH;

    public static final int WIDEHEIGHT = GAPWIDTH;
    public static final int WIDEWIDTH  = WIDTH - 2 * BORDER;
    public static final int WIDEPIXELS = WIDEHEIGHT * WIDEWIDTH;

    public static final int REPHEIGHT = NARROWHEIGHT + WIDEHEIGHT;
    public static final int REPPIXELS = WIDEPIXELS + NARROWPIXELS;

    public static final long TOTALBITS = (long) REPPIXELS * (YCROSSES - 1) + NARROWPIXELS;

    /** FEC_ORDER=10 means BCH(63,45,t=3). (1=Golay legacy; 2..5 were Hamming variants.) */
    public static final int FEC_ORDER     = 10;
    public static final int FEC_LARGEBITS = 63;
    public static final int FEC_SMALLBITS = 45;

    public static final long FEC_SYMS = TOTALBITS / FEC_LARGEBITS;
    public static final long NETBITS  = FEC_SYMS * FEC_SMALLBITS;
    public static final long USEDBITS = FEC_SYMS * FEC_LARGEBITS;

    /** Even parity of the low 32 bits, returned as 0 or 1. */
    public static int parity(long in) {
        int v = (int) in;
        v ^= v >>> 16;
        v ^= v >>> 8;
        v ^= v >>> 4;
        v ^= v >>> 2;
        v ^= v >>> 1;
        return v & 1;
    }

    /** Population count of the low 32 bits. */
    public static int ones(long in) {
        return Integer.bitCount((int) in);
    }

    /**
     * Maps a raw-payload-bit sequence number to an (x,y) pixel coordinate
     * inside the data area (i.e. relative to the UL corner of the UL-most
     * cross; the caller adds BORDER). Returns (-1,-1) if seq is out of range.
     */
    public static void seq2xy(int[] out, long seq) {
        if (seq >= TOTALBITS) {
            out[0] = -1;
            out[1] = -1;
            return;
        }

        long rep = seq / REPPIXELS;
        long s   = seq % REPPIXELS;

        int y = (int) (REPHEIGHT * rep);
        int x;
        if (s >= NARROWPIXELS) {
            // wide strip
            y += NARROWHEIGHT;
            s -= NARROWPIXELS;
            y += (int) (s / WIDEWIDTH);
            x  = (int) (s % WIDEWIDTH);
        } else {
            // narrow strip
            x  = 2 * CHALF;
            y += (int) (s / NARROWWIDTH);
            s  = s % NARROWWIDTH;
            long gap = s / GAPWIDTH;
            x += (int) (gap * CPITCH);
            s  = s % GAPWIDTH;
            x += (int) s;
        }
        out[0] = x;
        out[1] = y;
    }

    /** True if (x,y) falls inside a cross shape. Coordinates are relative to the UL
     *  corner of the upper-left cross (no border). */
    public static boolean isCross(int x, int y) {
        int mx = Math.floorMod(x, CPITCH);
        int my = Math.floorMod(y, CPITCH);
        return mx < 2 * CHALF && my < 2 * CHALF;
    }
}
