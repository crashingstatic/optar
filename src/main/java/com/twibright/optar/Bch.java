package com.twibright.optar;

/**
 * BCH(63, 45, t=3) codec over GF(2^6).
 *
 * <p>Net rate 45/63 = 71.43% (≈+43% over the original Optar's Golay 50%) at
 * the same 3-bit per-codeword correction strength. Built over GF(2^6) with
 * primitive polynomial p(x) = x^6 + x + 1. Generator polynomial
 * g(x) = m_1(x)·m_3(x)·m_5(x), degree 18. Decoder is Peterson–Gorenstein–
 * Zierler (direct 3×3 / 2×2 / 1×1 GF(2^6) Cramer's-rule solves) plus
 * Chien search.
 *
 * <p>All codewords fit in a Java {@code long} (63 bits, sign bit unused).
 */
public final class Bch {
    private Bch() {}

    public static final int M = 6;
    public static final int N = 63;          // 2^M - 1
    public static final int K = 45;
    public static final int T = 3;
    public static final int PARITY = N - K; // 18

    private static final int PRIM_POLY = 0x43; // x^6 + x + 1

    private static final int[] GF_EXP = new int[N + 1];
    private static final int[] GF_LOG = new int[N + 1];

    /** Generator polynomial g(x) as a 19-bit pattern (bit i = coefficient of x^i). */
    public static final int GEN;

    static {
        int x = 1;
        for (int i = 0; i < N; i++) {
            GF_EXP[i] = x;
            GF_LOG[x] = i;
            x <<= 1;
            if ((x & (1 << M)) != 0) x ^= PRIM_POLY;
        }
        GF_EXP[N] = GF_EXP[0]; // alpha^N = 1
        GF_LOG[0] = -1;

        GEN = polyMulGF2(polyMulGF2(minimalPoly(1), minimalPoly(3)), minimalPoly(5));
    }

    private static int gfMul(int a, int b) {
        if (a == 0 || b == 0) return 0;
        return GF_EXP[(GF_LOG[a] + GF_LOG[b]) % N];
    }
    private static int gfDiv(int a, int b) {
        if (a == 0) return 0;
        if (b == 0) throw new ArithmeticException("BCH GF division by zero");
        return GF_EXP[((GF_LOG[a] - GF_LOG[b]) % N + N) % N];
    }

    private static int polyMulGF2(int a, int b) {
        int r = 0;
        while (b != 0) {
            if ((b & 1) != 0) r ^= a;
            a <<= 1;
            b >>>= 1;
        }
        return r;
    }

    /**
     * Build the minimal polynomial of α^k over GF(2). Result is bit-packed:
     * bit i = coefficient of x^i. Coefficients of any minimal polynomial of
     * an element of GF(2^m) lie in GF(2), so they fit in plain bits.
     */
    private static int minimalPoly(int k) {
        java.util.Set<Integer> seen = new java.util.LinkedHashSet<>();
        int v = ((k % N) + N) % N;
        while (!seen.contains(v)) { seen.add(v); v = (v * 2) % N; }
        int[] poly = { 1 };
        for (int c : seen) {
            int ac = GF_EXP[c];
            int[] next = new int[poly.length + 1];
            for (int i = 0; i < poly.length; i++) {
                next[i + 1] ^= poly[i];                // multiply by x
                next[i]     ^= gfMul(poly[i], ac);     // multiply by α^c
            }
            poly = next;
        }
        int bits = 0;
        for (int i = 0; i < poly.length; i++) {
            if (poly[i] == 1) bits |= 1 << i;
            else if (poly[i] != 0) {
                throw new IllegalStateException("BCH minimal poly should be over GF(2)");
            }
        }
        return bits;
    }

    /** Encode 45-bit data → 63-bit BCH codeword.
     *  codeword(x) = data(x)·x^18 + parity(x), parity = data·x^18 mod g(x). */
    public static long encode(long data) {
        long d = data & ((1L << K) - 1);
        long r = d << PARITY;
        long gen = (long) GEN;
        for (int i = N - 1; i >= PARITY; i--) {
            if (((r >> i) & 1L) != 0) r ^= gen << (i - PARITY);
        }
        return (d << PARITY) | r;
    }

    /** Compute syndromes S_1..S_2t of a received 63-bit word via Horner's rule. */
    private static int[] syndromes(long received) {
        int a1 = GF_EXP[1], a2 = GF_EXP[2], a3 = GF_EXP[3];
        int a4 = GF_EXP[4], a5 = GF_EXP[5], a6 = GF_EXP[6];
        int s1 = 0, s2 = 0, s3 = 0, s4 = 0, s5 = 0, s6 = 0;
        for (int j = N - 1; j >= 0; j--) {
            int cj = (int) ((received >> j) & 1L);
            s1 = gfMul(s1, a1) ^ cj;
            s2 = gfMul(s2, a2) ^ cj;
            s3 = gfMul(s3, a3) ^ cj;
            s4 = gfMul(s4, a4) ^ cj;
            s5 = gfMul(s5, a5) ^ cj;
            s6 = gfMul(s6, a6) ^ cj;
        }
        return new int[] { 0, s1, s2, s3, s4, s5, s6 };
    }

    private static int det3(int[][] m) {
        return gfMul(m[0][0], gfMul(m[1][1], m[2][2]) ^ gfMul(m[1][2], m[2][1]))
             ^ gfMul(m[0][1], gfMul(m[1][0], m[2][2]) ^ gfMul(m[1][2], m[2][0]))
             ^ gfMul(m[0][2], gfMul(m[1][0], m[2][1]) ^ gfMul(m[1][1], m[2][0]));
    }

    /**
     * Peterson–Gorenstein–Zierler error-locator polynomial Λ(x).
     * Tries t=3, falls back to t=2 then t=1. Returns null if syndromes are
     * inconsistent with any error pattern of weight ≤ 3 (i.e. uncorrectable).
     */
    private static int[] pgz(int[] s) {
        // t = 3
        int[][] M3 = {{ s[1], s[2], s[3] }, { s[2], s[3], s[4] }, { s[3], s[4], s[5] }};
        int detM3 = det3(M3);
        if (detM3 != 0) {
            int[] rhs = { s[4], s[5], s[6] };
            int[][] m30 = {{ rhs[0], M3[0][1], M3[0][2] }, { rhs[1], M3[1][1], M3[1][2] }, { rhs[2], M3[2][1], M3[2][2] }};
            int[][] m31 = {{ M3[0][0], rhs[0], M3[0][2] }, { M3[1][0], rhs[1], M3[1][2] }, { M3[2][0], rhs[2], M3[2][2] }};
            int[][] m32 = {{ M3[0][0], M3[0][1], rhs[0] }, { M3[1][0], M3[1][1], rhs[1] }, { M3[2][0], M3[2][1], rhs[2] }};
            return new int[] { 1, gfDiv(det3(m32), detM3), gfDiv(det3(m31), detM3), gfDiv(det3(m30), detM3) };
        }
        // t = 2
        int detM2 = gfMul(s[1], s[3]) ^ gfMul(s[2], s[2]);
        if (detM2 != 0) {
            int lambda1 = gfDiv(gfMul(s[1], s[4]) ^ gfMul(s[2], s[3]), detM2);
            int lambda2 = gfDiv(gfMul(s[2], s[4]) ^ gfMul(s[3], s[3]), detM2);
            return new int[] { 1, lambda1, lambda2 };
        }
        // t = 1
        if (s[1] != 0) return new int[] { 1, gfDiv(s[2], s[1]) };
        return null;
    }

    /** Chien search: enumerate roots of Λ(x). A root α^(-j) means bit j is in error. */
    private static int[] chienSearch(int[] lambda) {
        int[] errors = new int[lambda.length - 1];
        int n = 0;
        for (int j = 0; j < N && n < errors.length; j++) {
            int value = 0;
            int negJ = (N - j) % N;
            for (int k = 0; k < lambda.length; k++) {
                if (lambda[k] != 0) {
                    value ^= gfMul(lambda[k], GF_EXP[(k * negJ) % N]);
                }
            }
            if (value == 0) errors[n++] = j;
        }
        if (n != errors.length) return null;  // not enough roots — decoder failure
        return errors;
    }

    /** Result of decoding a 63-bit received word. */
    public static final class Decoded {
        /** Recovered 45 data bits (in the low 45 bits of the value). */
        public final long data;
        /** Number of bit errors corrected (0..3), or 4 if irreparable. */
        public final int errors;
        /** True iff the decoder produced a valid correction. */
        public final boolean reparable;

        Decoded(long data, int errors, boolean reparable) {
            this.data = data;
            this.errors = errors;
            this.reparable = reparable;
        }
    }

    /**
     * Decode a 63-bit received word. Corrects up to 3 bit errors. Words
     * more than 3 bits from any codeword return errors=4, reparable=false
     * with data set to the (uncorrected) top 45 bits of the input.
     */
    public static Decoded decode(long received) {
        long r = received & ((1L << N) - 1);
        int[] s = syndromes(r);
        if (s[1] == 0 && s[2] == 0 && s[3] == 0 && s[4] == 0 && s[5] == 0 && s[6] == 0) {
            return new Decoded(r >>> PARITY, 0, true);
        }
        int[] lambda = pgz(s);
        if (lambda == null) {
            return new Decoded(r >>> PARITY, 4, false);
        }
        int[] errs = chienSearch(lambda);
        if (errs == null) {
            return new Decoded(r >>> PARITY, 4, false);
        }
        long corrected = r;
        for (int j : errs) corrected ^= 1L << j;
        return new Decoded(corrected >>> PARITY, errs.length, true);
    }
}
