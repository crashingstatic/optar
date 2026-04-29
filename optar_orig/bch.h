/* (c) GPL 2026 Twibright Labs / Optar contributors
 *
 * BCH(63, 45, t=3) codec over GF(2^6).
 *
 * Net rate 45/63 = 71.43% (≈+43% over the original Optar's Golay 50%) at
 * the same 3-bit per-codeword correction strength. Built over GF(2^6) with
 * primitive polynomial p(x) = x^6 + x + 1. Generator polynomial
 * g(x) = m_1(x)·m_3(x)·m_5(x), degree 18. Decoder uses Peterson–Gorenstein–
 * Zierler (direct 3x3 / 2x2 / 1x1 GF(2^6) Cramer's-rule solves) plus
 * Chien search.
 *
 * All codewords fit in a uint64_t (63 bits, MSB unused).
 */

#ifndef BCH_H
#define BCH_H

#include <stdint.h>

#define BCH_M       6
#define BCH_N       63       /* 2^M - 1 */
#define BCH_K       45
#define BCH_T       3
#define BCH_PARITY  18       /* N - K */

/* Initialise GF(2^6) tables and generator polynomial. Must be called once
 * before bch_encode / bch_decode. Idempotent. */
void bch_init(void);

/* Encode 45-bit data → 63-bit codeword. Only the low BCH_K bits of `data`
 * are used. */
uint64_t bch_encode(uint64_t data);

/* Decode result. */
struct bch_decoded {
    uint64_t data;     /* recovered 45 data bits (low bits) */
    int      errors;   /* 0..3 if reparable; 4 if irreparable */
    int      reparable;/* 1 if decoded successfully, 0 otherwise */
    uint64_t corrected;/* corrected 63-bit codeword (if reparable) */
};

/* Decode a 63-bit received word. Corrects up to 3 bit errors. */
struct bch_decoded bch_decode(uint64_t received);

#endif /* BCH_H */
