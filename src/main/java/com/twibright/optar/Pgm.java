package com.twibright.optar;

import java.io.BufferedInputStream;
import java.io.BufferedOutputStream;
import java.io.EOFException;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.file.Files;
import java.nio.file.Path;

/**
 * Minimal P5 (binary grayscale) PGM read/write.
 */
public final class Pgm {
    private Pgm() {}

    public static void write(Path out, byte[] pixels, int width, int height) throws IOException {
        try (OutputStream os = new BufferedOutputStream(Files.newOutputStream(out))) {
            os.write(("P5\n" + width + " " + height + "\n255\n").getBytes());
            os.write(pixels, 0, width * height);
        }
    }

    public static final class Image {
        public final int width;
        public final int height;
        public final byte[] pixels;
        public Image(int width, int height, byte[] pixels) {
            this.width = width;
            this.height = height;
            this.pixels = pixels;
        }
    }

    public static Image read(Path in) throws IOException {
        try (InputStream is = new BufferedInputStream(Files.newInputStream(in))) {
            String magic = readToken(is);
            if (!"P5".equals(magic)) throw new IOException("not P5 PGM: " + magic);
            int width  = Integer.parseInt(readToken(is));
            int height = Integer.parseInt(readToken(is));
            int maxval = Integer.parseInt(readToken(is));
            if (maxval != 255) throw new IOException("only maxval 255 supported, got " + maxval);
            byte[] pixels = is.readNBytes(width * height);
            if (pixels.length != width * height) throw new EOFException("short PGM body");
            return new Image(width, height, pixels);
        }
    }

    private static String readToken(InputStream is) throws IOException {
        StringBuilder sb = new StringBuilder();
        int c;
        // skip whitespace and comments
        while (true) {
            c = is.read();
            if (c < 0) throw new EOFException("unexpected EOF in PGM header");
            if (c == '#') {
                while (c != '\n' && c >= 0) c = is.read();
                continue;
            }
            if (!Character.isWhitespace(c)) break;
        }
        while (!Character.isWhitespace(c) && c >= 0) {
            sb.append((char) c);
            c = is.read();
        }
        return sb.toString();
    }
}
