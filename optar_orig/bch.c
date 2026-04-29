/* (c) GPL 2026 Twibright Labs / Optar contributors
 *
 * BCH(63, 45, t=3) codec — see bch.h for design.
 */

#include "bch.h"

#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>

#define PRIM_POLY  0x43  /* x^6 + x + 1 */

static int gf_exp[BCH_N + 1];
static int gf_log[BCH_N + 1];
static uint32_t bch_gen;     /* 19-bit generator polynomial g(x) */
static int initialised = 0;

static int gf_mul(int a, int b)
{
    if (a == 0 || b == 0) return 0;
    return gf_exp[(gf_log[a] + gf_log[b]) % BCH_N];
}

static int gf_div(int a, int b)
{
    if (a == 0) return 0;
    if (b == 0) {
        fprintf(stderr, "bch: GF(2^6) division by zero\n");
        exit(1);
    }
    return gf_exp[((gf_log[a] - gf_log[b]) % BCH_N + BCH_N) % BCH_N];
}

static uint32_t poly_mul_gf2(uint32_t a, uint32_t b)
{
    uint32_t r = 0;
    while (b) {
        if (b & 1) r ^= a;
        a <<= 1;
        b >>= 1;
    }
    return r;
}

/* Build the minimal polynomial of α^k over GF(2). Returns it bit-packed
 * (bit i = coefficient of x^i). Coefficients of any minimal polynomial of an
 * element of GF(2^m) lie in GF(2), so they fit in plain bits. */
static uint32_t minimal_poly(int k)
{
    int seen[BCH_N];
    int n_seen = 0;
    int v = ((k % BCH_N) + BCH_N) % BCH_N;
    for (;;) {
        int already = 0;
        for (int i = 0; i < n_seen; i++) if (seen[i] == v) { already = 1; break; }
        if (already) break;
        seen[n_seen++] = v;
        v = (v * 2) % BCH_N;
    }

    /* poly accumulator in GF(2^6); allocate enough headroom for the product. */
    int poly[BCH_N + 2];
    int len = 1;
    poly[0] = 1;

    for (int idx = 0; idx < n_seen; idx++) {
        int ac = gf_exp[seen[idx]];
        int next[BCH_N + 2];
        for (int i = 0; i <= len; i++) next[i] = 0;
        for (int i = 0; i < len; i++) {
            next[i + 1] ^= poly[i];                    /* multiply by x */
            next[i]     ^= gf_mul(poly[i], ac);        /* multiply by α^c */
        }
        len++;
        for (int i = 0; i < len; i++) poly[i] = next[i];
    }

    uint32_t bits = 0;
    for (int i = 0; i < len; i++) {
        if (poly[i] == 1)        bits |= (uint32_t)1 << i;
        else if (poly[i] != 0) {
            fprintf(stderr, "bch: minimal poly should be over GF(2), got %d at i=%d\n",
                    poly[i], i);
            exit(1);
        }
    }
    return bits;
}

void bch_init(void)
{
    if (initialised) return;

    int x = 1;
    for (int i = 0; i < BCH_N; i++) {
        gf_exp[i] = x;
        gf_log[x] = i;
        x <<= 1;
        if (x & (1 << BCH_M)) x ^= PRIM_POLY;
    }
    gf_exp[BCH_N] = gf_exp[0]; /* alpha^N = 1 */
    gf_log[0] = -1;

    bch_gen = poly_mul_gf2(poly_mul_gf2(minimal_poly(1), minimal_poly(3)),
                           minimal_poly(5));
    initialised = 1;
}

uint64_t bch_encode(uint64_t data)
{
    uint64_t d = data & (((uint64_t)1 << BCH_K) - 1);
    uint64_t r = d << BCH_PARITY;
    uint64_t gen = (uint64_t)bch_gen;
    for (int i = BCH_N - 1; i >= BCH_PARITY; i--) {
        if ((r >> i) & 1ULL) r ^= gen << (i - BCH_PARITY);
    }
    return (d << BCH_PARITY) | r;
}

/* Compute syndromes S_1..S_6 of a received 63-bit word via Horner's rule. */
static void syndromes(uint64_t r, int s[7])
{
    int a1 = gf_exp[1], a2 = gf_exp[2], a3 = gf_exp[3];
    int a4 = gf_exp[4], a5 = gf_exp[5], a6 = gf_exp[6];
    int s1 = 0, s2 = 0, s3 = 0, s4 = 0, s5 = 0, s6 = 0;
    for (int j = BCH_N - 1; j >= 0; j--) {
        int cj = (int)((r >> j) & 1ULL);
        s1 = gf_mul(s1, a1) ^ cj;
        s2 = gf_mul(s2, a2) ^ cj;
        s3 = gf_mul(s3, a3) ^ cj;
        s4 = gf_mul(s4, a4) ^ cj;
        s5 = gf_mul(s5, a5) ^ cj;
        s6 = gf_mul(s6, a6) ^ cj;
    }
    s[0] = 0; s[1] = s1; s[2] = s2; s[3] = s3; s[4] = s4; s[5] = s5; s[6] = s6;
}

static int det3(int m[3][3])
{
    return gf_mul(m[0][0], gf_mul(m[1][1], m[2][2]) ^ gf_mul(m[1][2], m[2][1]))
         ^ gf_mul(m[0][1], gf_mul(m[1][0], m[2][2]) ^ gf_mul(m[1][2], m[2][0]))
         ^ gf_mul(m[0][2], gf_mul(m[1][0], m[2][1]) ^ gf_mul(m[1][1], m[2][0]));
}

/* PGZ: try Λ(x) of degree 3 → 2 → 1. Returns degree (1..3) and fills lambda[];
 * lambda[0]=1 always. Returns 0 if no degree fits (uncorrectable). */
static int pgz(const int s[7], int lambda[4])
{
    int M3[3][3] = {
        { s[1], s[2], s[3] },
        { s[2], s[3], s[4] },
        { s[3], s[4], s[5] }
    };
    int detM3 = det3(M3);
    if (detM3 != 0) {
        int rhs[3] = { s[4], s[5], s[6] };
        int m30[3][3] = {{ rhs[0], M3[0][1], M3[0][2] },
                         { rhs[1], M3[1][1], M3[1][2] },
                         { rhs[2], M3[2][1], M3[2][2] }};
        int m31[3][3] = {{ M3[0][0], rhs[0], M3[0][2] },
                         { M3[1][0], rhs[1], M3[1][2] },
                         { M3[2][0], rhs[2], M3[2][2] }};
        int m32[3][3] = {{ M3[0][0], M3[0][1], rhs[0] },
                         { M3[1][0], M3[1][1], rhs[1] },
                         { M3[2][0], M3[2][1], rhs[2] }};
        lambda[0] = 1;
        lambda[1] = gf_div(det3(m32), detM3);
        lambda[2] = gf_div(det3(m31), detM3);
        lambda[3] = gf_div(det3(m30), detM3);
        return 3;
    }
    int detM2 = gf_mul(s[1], s[3]) ^ gf_mul(s[2], s[2]);
    if (detM2 != 0) {
        lambda[0] = 1;
        lambda[1] = gf_div(gf_mul(s[1], s[4]) ^ gf_mul(s[2], s[3]), detM2);
        lambda[2] = gf_div(gf_mul(s[2], s[4]) ^ gf_mul(s[3], s[3]), detM2);
        return 2;
    }
    if (s[1] != 0) {
        lambda[0] = 1;
        lambda[1] = gf_div(s[2], s[1]);
        return 1;
    }
    return 0;
}

/* Chien search. Writes up to `degree` error positions to errors[].
 * Returns the number of roots found (== degree if successful). */
static int chien_search(const int lambda[4], int degree, int errors[3])
{
    int n = 0;
    for (int j = 0; j < BCH_N && n < degree; j++) {
        int neg_j = (BCH_N - j) % BCH_N;
        int value = 0;
        for (int k = 0; k <= degree; k++) {
            if (lambda[k] != 0) {
                value ^= gf_mul(lambda[k], gf_exp[(k * neg_j) % BCH_N]);
            }
        }
        if (value == 0) errors[n++] = j;
    }
    return n;
}

struct bch_decoded bch_decode(uint64_t received)
{
    struct bch_decoded out;
    uint64_t r = received & (((uint64_t)1 << BCH_N) - 1);

    int s[7];
    syndromes(r, s);
    if (!s[1] && !s[2] && !s[3] && !s[4] && !s[5] && !s[6]) {
        out.data = r >> BCH_PARITY;
        out.errors = 0;
        out.reparable = 1;
        out.corrected = r;
        return out;
    }

    int lambda[4] = { 0, 0, 0, 0 };
    int degree = pgz(s, lambda);
    if (degree == 0) {
        out.data = r >> BCH_PARITY;
        out.errors = 4;
        out.reparable = 0;
        out.corrected = r;
        return out;
    }
    int errs[3];
    int found = chien_search(lambda, degree, errs);
    if (found != degree) {
        out.data = r >> BCH_PARITY;
        out.errors = 4;
        out.reparable = 0;
        out.corrected = r;
        return out;
    }
    uint64_t corrected = r;
    for (int i = 0; i < found; i++) corrected ^= (uint64_t)1 << errs[i];
    out.data = corrected >> BCH_PARITY;
    out.errors = degree;
    out.reparable = 1;
    out.corrected = corrected;
    return out;
}
