/* (c) GPL 2007 Karel 'Clock' Kulhavy, Twibright Labs */

#define MIN(x, y) ((x) < (y) ? (x) : (y))
#define MAX(x, y) ((x) > (y) ? (x) : (y))

#define BORDER 2 /* In pixels. Thickness of the border */
#define CHALF                                                                        \
    3             /* Size of the cross half. Size of the cross is CHALF*2 x CHALF*2. \
                   */
#define CPITCH 24 /* Distance between cross centers */

/* XCROSSES A4 65, US Letter 67. */
#define XCROSSES 65 /* Number of crosses horizontally */
/* YCROSSES A4 93, US Letter 87. */
#define YCROSSES 93 /* Number of crosses vertically */

#define DATA_WIDTH                                                     \
    (CPITCH * (XCROSSES - 1) + 2 * CHALF) /* The rectangle occupied by \
                                             the data and crosses */
#define DATA_HEIGHT (CPITCH * (YCROSSES - 1) + 2 * CHALF)
#define WIDTH       (2 * BORDER + DATA_WIDTH) /* In pixels, including the border */
/* In pixels, including the border and the label */

#define TEXT_WIDTH 13 /* Width of a single letter */

/* Definitions for seq2xy */

/* Properties of the narrow horizontal strip, with crosses */
#define NARROWHEIGHT (2 * CHALF)
#define GAPWIDTH     (CPITCH - 2 * CHALF)
#define NARROWWIDTH  (GAPWIDTH * (XCROSSES - 1))  /* Useful width */
#define NARROWPIXELS (NARROWHEIGHT * NARROWWIDTH) /* Useful pixels */

/* Properties of the wide horizontal strip, without crosses */
#define WIDEHEIGHT GAPWIDTH
#define WIDEWIDTH  (WIDTH - 2 * BORDER)
#define WIDEPIXELS (WIDEHEIGHT * WIDEWIDTH)

/* Amount of raw payload pixels in one narrow-wide strip pair */
#define REPHEIGHT (NARROWHEIGHT + WIDEHEIGHT)
#define REPPIXELS (WIDEPIXELS + NARROWPIXELS)

/* Total bits before hamming including the unused */
#define TOTALBITS ((long)REPPIXELS * (YCROSSES - 1) + NARROWPIXELS)

/* FEC: BCH(63, 45, t=3). FEC_ORDER=10 distinguishes BCH from the legacy
 * Golay (1) / Hamming (2..5) modes the original Optar carried. */
#define FEC_ORDER     10
#define FEC_LARGEBITS 63
#define FEC_SMALLBITS 45

/* Hamming net channel capacity */
#define FEC_SYMS (TOTALBITS / FEC_LARGEBITS)
#define NETBITS  (FEC_SYMS * FEC_SMALLBITS) /* Net payload bits */
#define USEDBITS                                         \
    (FEC_SYMS * FEC_LARGEBITS) /* Used raw bits to store \
                                          Hamming symbols */

/* Functions from common.c */
extern unsigned long parity(unsigned long in);
extern int is_cross(unsigned x, unsigned y);
extern void seq2xy(int* x, int* y, unsigned seq);

/* Counts number of '1' bits */
unsigned ones(unsigned long in);
