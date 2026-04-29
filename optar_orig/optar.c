/* (c) GPL 2007 Karel 'Clock' Kulhavy, Twibright Labs */

#include <assert.h> /* assert */
#include <stdint.h> /* uint64_t */
#include <stdio.h>  /* getchar */
#include <stdlib.h> /* exit */
#include <string.h> /* memcpy */

#define width  font_width
#define height font_height
#include "font.h"
#undef width
#undef height

#include "bch.h"
#include "optar.h"
#include "parity.h"
#define HEIGHT      (2 * BORDER + DATA_HEIGHT + TEXT_HEIGHT)
#define TEXT_HEIGHT 24

static unsigned char ary[WIDTH * HEIGHT];
static unsigned char* file_label = (unsigned char*)""; /* The filename written in the
                                         file_label */
static char* output_filename;                          /* The output filename */
static unsigned output_filename_buffer_size;
static unsigned char* base = (unsigned char*)"optar_out"; /* Output filename base */
static unsigned file_number;
FILE* output_stream;
FILE* input_stream;
unsigned n_pages; /* Number of pages calculated from the file length */

void dump_ary(void)
{
    fprintf(output_stream,
        "P5\n"
        "%u %u\n"
        "255\n",
        WIDTH, HEIGHT);

    fwrite(ary, sizeof(ary), 1, output_stream);
}

/* Only the LSB is significant. Writes hamming-encoded bits. The sequence number
 * must not be out of range! */
void write_channelbit(unsigned char bit, unsigned long seq)
{
    int x, y; /* Positions of the pixel */

    bit &= 1;
    bit = -bit;
    bit = ~bit;          /* White=bit 0, black=bit 1 */
    seq2xy(&x, &y, seq); /* Returns without borders! */
    x += BORDER;
    y += BORDER;
    ary[x + y * WIDTH] = bit;
    seq++;
}

void border(void)
{
    unsigned c;
    char* ptr = (char*)(void*)ary;

    memset(ptr, 0, BORDER * WIDTH);
    ptr += BORDER * WIDTH;
    for (c = DATA_HEIGHT; c; c--) {
        memset(ptr, 0, BORDER);
        ptr += WIDTH;
        memset(ptr - BORDER, 0, BORDER);
    }
    memset(ptr, 0, TEXT_HEIGHT * WIDTH);
    ptr += TEXT_HEIGHT * WIDTH;
    /* BORDER bytes into the bottom border */
    memset(ptr, 0, BORDER * WIDTH);
}

void cross(x, y)
{
    unsigned char* ptr = ary + y * WIDTH + x;
    unsigned c;

    for (c = CHALF; c; c--, ptr += WIDTH) {
        memset(ptr, 0, CHALF);
        memset(ptr + CHALF, 0xff, CHALF);
        memset(ptr + CHALF * WIDTH, 0xff, CHALF);
        memset(ptr + CHALF * (WIDTH + 1), 0, CHALF);
    }
}

void crosses(void)
{
    unsigned x, y;

    for (y = BORDER; y <= HEIGHT - TEXT_HEIGHT - BORDER - 2 * CHALF; y += CPITCH)
        for (x = BORDER; x <= WIDTH - BORDER - 2 * CHALF; x += CPITCH)
            cross(x, y);
}

/* x is in the range 0 to DATA_WIDTH-1 */
void text_block(destx, srcx, width)
{
    int x, y;
    unsigned char* srcptr;
    unsigned char* destptr;

    if (destx + width > DATA_WIDTH)
        return; /* Letter doesn't fit */

    srcptr  = (unsigned char*)(void*)header_data + srcx;
    destptr = ary + WIDTH * (BORDER + DATA_HEIGHT) + BORDER + destx;

    for (y = 0; y < TEXT_HEIGHT; y++, srcptr += font_width, destptr += WIDTH) {
        for (x = 0; x < width; x++) {
            destptr[x] = header_data_cmap[srcptr[x]][0] & 0x80 ? 0xff : 0;
        }
    }
}

void label(void)
{
    unsigned x = 0;
    static char txt[DATA_WIDTH / TEXT_WIDTH];
    unsigned char* ptr;
    unsigned txtlen;

    snprintf(txt, sizeof txt, "  0-%u-%u-%u-%u-%u-%u-%u %u/%u %s", XCROSSES, YCROSSES, CPITCH, CHALF, FEC_ORDER, BORDER,
        TEXT_HEIGHT, file_number, n_pages, (char*)(void*)file_label);
    txtlen = strlen((char*)(void*)txt);

    assert(font_height == TEXT_HEIGHT);
    x = font_width - TEXT_WIDTH * (127 - ' ');
    text_block(0, TEXT_WIDTH * (127 - ' '), x);
    for (ptr = (unsigned char*)(void*)txt; ptr < (unsigned char*)(void*)txt + txtlen; ptr++) {
        if (*ptr >= ' ' && *ptr <= 127) {
            text_block(x, TEXT_WIDTH * (*ptr - ' '), TEXT_WIDTH);
            x += TEXT_WIDTH;
        }
    }
}

void format_ary(void)
{
    memset(ary, 0xff, sizeof(ary)); /* White */
    border();
    crosses();
    label();
}

/* Always formats ary. Dumps it if it's not the first one. */
void new_file(void)
{
    if (file_number) {
        dump_ary();
        fclose(output_stream);
    }
    if (file_number >= 9999) {
        fprintf(stderr, "optar: too many pages - 10,000 or more\n");
        exit(1);
    }
    snprintf(output_filename, output_filename_buffer_size, "%s_%04u.pgm", (char*)(void*)base, ++file_number);
    output_stream = fopen(output_filename, "w");
    if (!output_stream) {
        fprintf(stderr, "optar: cannot open %s for writing.\n", output_filename);
        exit(1);
    }
    format_ary();
}

/* Encode the next FEC_SMALLBITS-bit data word with BCH and write its
 * FEC_LARGEBITS channel bits interleaved across the page. */
void write_payloadbit(unsigned char bit)
{
    static uint64_t accu = 1;
    static unsigned long fec_symbol;

    accu = (accu << 1) | (bit & 1);
    if (accu & ((uint64_t)1 << FEC_SMALLBITS)) {
        uint64_t data = accu & (((uint64_t)1 << FEC_SMALLBITS) - 1);
        uint64_t code = bch_encode(data);

        if (fec_symbol >= FEC_SYMS) {
            /* Page full; start a new one. */
            new_file();
            fec_symbol = 0;
        }

        for (int shift = FEC_LARGEBITS - 1; shift >= 0; shift--) {
            write_channelbit(
                (unsigned char)((code >> shift) & 1ULL),
                fec_symbol + (FEC_LARGEBITS - 1 - shift) * FEC_SYMS);
        }
        accu = 1;
        fec_symbol++;
    }
}

void write_byte(unsigned char c)
{
    int bit;

    for (bit = 7; bit >= 0; bit--)
        write_payloadbit(c >> bit);
}

/* Prints the text at the bottom */
/* Makes one output file. */
void feed_data(void)
{
    int c;

    while ((c = fgetc(input_stream)) != EOF) {
        write_byte(c);
    }

    /* Flush the FEC with zeroes */
    for (c = FEC_SMALLBITS - 1; c; c--) {
        write_payloadbit(0);
    }

    dump_ary();
    fclose(output_stream);
}

void open_input_file(char* fname)
{
    input_stream = fopen(fname, "r");
    if (!input_stream) {
        fprintf(stderr, "optar: cannot open input file %s: ", fname);
        perror("");
        exit(1);
    }
    if (fseek(input_stream, 0, SEEK_END)) {
        fprintf(stderr, "optar: cannot seek to the end of %s: ", fname);
        perror("");
        exit(1);
    }
    n_pages = (((unsigned long)ftell(input_stream) << 3) + NETBITS - 1) / NETBITS;
    if (fseek(input_stream, 0, SEEK_SET)) {
        fprintf(stderr, "optar: cannot seek to the beginning of %s: ", fname);
        perror("");
        exit(1);
    }
}

/* argv format:
 * 1st arg - input file
 * 2nd arg(optional) - label and output filename base */
int main(int argc, char** argv)
{

    if (argc < 2) {
        fprintf(stderr, "\n"
                        "Usage: optar <input file> [filename base]\n"
                        "\n"
                        "Will take the input file as data payload and produce optar_out_????.pgm"
                        " which contain the input file encoded onto paper, with error"
                        " correction codes, and automatically split into multiple"
                        " files when necessary. Those pgm's are supposed to be printed"
                        " on laser printer at least 600 DPI for example using GIMP, or use the included pgm2ps to"
                        " convert them to PostScript and print for example"
                        " using a PostScript viewer program.\n"
                        "\n");
        exit(1);
    }
    bch_init();
    open_input_file(argv[1]);

    if (argc >= 3)
        file_label = base = (void*)argv[2];
    output_filename_buffer_size = strlen((char*)(void*)base) + 1 + 4 + 1 + 3 + 1;
    output_filename             = malloc(output_filename_buffer_size);
    if (!output_filename) {
        fprintf(stderr, "Cannot allocate output filename\n");
        exit(1);
    }
    new_file();
    feed_data();
    fclose(input_stream);
    free(output_filename);
    return 0;
}
