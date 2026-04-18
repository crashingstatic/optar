package com.twibright.optar;

import java.awt.image.BufferedImage;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Iterator;
import javax.imageio.ImageIO;
import javax.imageio.ImageReader;
import javax.imageio.metadata.IIOMetadata;
import javax.imageio.metadata.IIOMetadataNode;
import javax.imageio.stream.ImageInputStream;
import org.w3c.dom.NodeList;

/**
 * Reads a PNG into a linear grayscale pixel array. Mimics what the C code
 * does via libpng's {@code png_set_gamma(png, 1.0, file_gamma)}:
 *   - gray out colour (sRGB luminance weights 0.299/0.587/0.114)
 *   - linearize using the file gamma (gAMA chunk if present, else 0.454545)
 * The returned bytes hold linear intensity (0=black..255=white).
 */
public final class PngReader {
    private PngReader() {}

    public static final double DEFAULT_FILE_GAMMA = 0.454545;

    public static final class Gray {
        public final int width;
        public final int height;
        /** Row-major linear grayscale, unsigned. */
        public final byte[] pixels;
        Gray(int w, int h, byte[] p) { width = w; height = h; pixels = p; }
    }

    public static Gray read(Path file) throws IOException {
        double fileGamma = DEFAULT_FILE_GAMMA;
        BufferedImage img;
        try (ImageInputStream iis = ImageIO.createImageInputStream(Files.newInputStream(file))) {
            Iterator<ImageReader> it = ImageIO.getImageReaders(iis);
            if (!it.hasNext()) throw new IOException("no PNG reader for " + file);
            ImageReader reader = it.next();
            try {
                reader.setInput(iis, true, false);
                IIOMetadata meta = reader.getImageMetadata(0);
                Double g = readGamma(meta);
                if (g != null) fileGamma = g;
                img = reader.read(0);
            } finally {
                reader.dispose();
            }
        }
        return grayscaleAndLinearize(img, fileGamma);
    }

    /** Reads the gAMA chunk via the PNG native metadata tree. Returns null if absent. */
    private static Double readGamma(IIOMetadata meta) {
        if (meta == null) return null;
        String[] formats = meta.getMetadataFormatNames();
        for (String fmt : formats) {
            if (!"javax_imageio_png_1.0".equals(fmt)) continue;
            IIOMetadataNode root = (IIOMetadataNode) meta.getAsTree(fmt);
            NodeList list = root.getElementsByTagName("gAMA");
            if (list.getLength() == 0) return null;
            IIOMetadataNode gAMA = (IIOMetadataNode) list.item(0);
            String v = gAMA.getAttribute("value");
            if (v == null || v.isEmpty()) return null;
            try {
                // PNG gAMA chunk stores gamma * 100000 as an unsigned int.
                return Double.parseDouble(v) / 100000.0;
            } catch (NumberFormatException e) {
                return null;
            }
        }
        return null;
    }

    private static Gray grayscaleAndLinearize(BufferedImage img, double fileGamma) {
        int w = img.getWidth(), h = img.getHeight();
        byte[] gray = new byte[w * h];

        // Collapse to 8-bit gray with sRGB luma weights. Handles RGB, RGBA, indexed,
        // and grayscale PNGs uniformly via BufferedImage.getRGB().
        int[] rgba = new int[w];
        for (int y = 0; y < h; y++) {
            img.getRGB(0, y, w, 1, rgba, 0, w);
            int rowStart = y * w;
            for (int x = 0; x < w; x++) {
                int p = rgba[x];
                int r = (p >> 16) & 0xff;
                int g = (p >>  8) & 0xff;
                int b =  p        & 0xff;
                // Match libpng's default rgb-to-gray weights (709/BT.709-ish).
                // libpng's default weights correspond to the standard luma. The C
                // code uses png_set_rgb_to_gray(png, 1, -1, -1); "-1, -1" means use
                // default (roughly 0.2125R + 0.7154G + 0.0721B). We approximate with
                // integer math to avoid floating drift.
                int yv = (2126 * r + 7152 * g + 722 * b + 5000) / 10000;
                if (yv > 255) yv = 255;
                gray[rowStart + x] = (byte) yv;
            }
        }

        // Linearize. libpng applies (v/255)^(display_gamma/file_gamma) * 255 with
        // display_gamma=1, file_gamma=<file>. So exponent = 1/file_gamma.
        double exp = 1.0 / fileGamma;
        byte[] lut = new byte[256];
        for (int i = 0; i < 256; i++) {
            double r = 255.0 * Math.pow(i / 255.0, exp);
            int v = (int) Math.floor(r + 0.5);
            if (v > 255) v = 255;
            if (v < 0)   v = 0;
            lut[i] = (byte) v;
        }
        for (int i = 0; i < gray.length; i++) {
            gray[i] = lut[gray[i] & 0xff];
        }
        return new Gray(w, h, gray);
    }
}
