package com.twibright.optar;

/**
 * Extended binary Golay code G(24,12,8). Encodes 12 data bits into 24 channel
 * bits and corrects up to 3 errors.
 *
 * The table {@link #CODES} is generated at class-init time using the same
 * dodecahedron construction the original golay.c uses.
 */
public final class Golay {
    private Golay() {}

    /** For each dodecahedron face (1..12), its 5 neighbours. */
    private static final int[][] DODECAHEDRON = {
        { 2,  3,  4,  5,  6},
        { 1,  3,  6,  7,  8},
        { 1,  2,  4,  8,  9},
        { 1,  3,  5,  9, 10},
        { 1,  4,  6, 10, 11},
        { 1,  2,  5,  7, 11},
        { 2,  6,  8, 11, 12},
        { 2,  3,  7,  9, 12},
        { 3,  4,  8, 10, 12},
        { 4,  5,  9, 11, 12},
        { 5,  6,  7, 10, 12},
        { 7,  8,  9, 10, 11},
    };

    /** CODES[d] is the 24-bit Golay codeword for the 12-bit data word d. */
    public static final int[] CODES = new int[4096];

    static {
        int[] parities = new int[12];
        for (int p = 0; p < 12; p++) {
            int mask = 0xfff;
            for (int f = 0; f < 5; f++) {
                mask ^= 1 << (DODECAHEDRON[p][f] - 1);
            }
            parities[p] = mask;
        }
        for (int data = 0; data < 4096; data++) {
            int prty = 0;
            for (int p = 0; p < 12; p++) {
                prty <<= 1;
                prty |= Common.parity(data & parities[p]);
            }
            CODES[data] = (data << 12) | prty;
        }
    }

    /** Encode 12 bits to 24 bits. Only the low 12 bits of {@code in} are used. */
    public static int encode(int in) {
        return CODES[in & 0xfff];
    }

    /** Result of decoding a 24-bit received word. */
    public static final class Decoded {
        /** Recovered 12 data bits. */
        public final int data;
        /** Number of bit errors corrected (0..3), or 4 if irreparable. */
        public final int errors;
        /** True if the codeword was decoded (errors <= 3). */
        public final boolean reparable;
        /** The codeword the decoder picked (original-recovered). For irreparable symbols,
         *  this is the received word itself. */
        public final int picked;

        Decoded(int data, int errors, boolean reparable, int picked) {
            this.data = data;
            this.errors = errors;
            this.reparable = reparable;
            this.picked = picked;
        }
    }

    /**
     * Decode a 24-bit received word. Corrects up to 3 bit errors.
     * If the received word is more than 3 bits away from any codeword the data
     * is returned as the upper 12 bits of {@code in} with errors=4, reparable=false.
     */
    public static Decoded decode(int in) {
        in &= 0xffffff;
        int topData = (in >>> 12) & 0xfff;

        if (CODES[topData] == in) {
            return new Decoded(topData, 0, true, in);
        }
        for (int d = 0; d < 4096; d++) {
            int code = CODES[d];
            int diff = code ^ in;
            int n = Integer.bitCount(diff);
            if (n <= 3) {
                return new Decoded(d, n, true, code);
            }
        }
        return new Decoded(topData, 4, false, in);
    }
}
