package com.twibright.optar;

import java.io.DataInputStream;
import java.io.IOException;
import java.io.InputStream;

/**
 * The 1500x24 font, loaded once from /font.bin on the classpath.
 * Each glyph is {@link Common#TEXT_WIDTH} pixels wide and {@link Common#TEXT_HEIGHT}
 * tall. Glyphs for ASCII characters 0x20..0x7f are laid out side by side starting
 * at x=0; a 265-pixel "prefix" block lives at the right end of the strip (optar.c
 * prepends it to the label).
 */
public final class Font {
    public static final int WIDTH;
    public static final int HEIGHT;
    /** Row-major: pixel(x,y) is white iff PIXELS[y*WIDTH+x] != 0. Values are 0 or 0xff. */
    public static final byte[] PIXELS;

    static {
        try (InputStream in = Font.class.getResourceAsStream("/font.bin")) {
            if (in == null) throw new IllegalStateException("font.bin resource missing");
            DataInputStream din = new DataInputStream(in);
            WIDTH  = din.readInt();
            HEIGHT = din.readInt();
            if (HEIGHT != Common.TEXT_HEIGHT) {
                throw new IllegalStateException("font height " + HEIGHT
                    + " != TEXT_HEIGHT " + Common.TEXT_HEIGHT);
            }
            int total = WIDTH * HEIGHT;
            byte[] packed = din.readAllBytes();
            PIXELS = new byte[total];
            for (int i = 0; i < total; i++) {
                boolean white = (packed[i >> 3] & (0x80 >> (i & 7))) != 0;
                PIXELS[i] = (byte) (white ? 0xff : 0x00);
            }
        } catch (IOException e) {
            throw new ExceptionInInitializerError(e);
        }
    }

    private Font() {}
}
