import java.awt.image.BufferedImage;
import java.awt.image.DataBufferByte;
import java.io.*;
import java.nio.file.*;
import javax.imageio.*;
import javax.imageio.metadata.*;
import javax.imageio.stream.*;

/** Convert a P5 PGM to an 8-bit grayscale PNG. Adds a gAMA chunk = 0.454545. */
public class Pgm2Png {
    public static void main(String[] a) throws Exception {
        for (int i = 0; i + 1 < a.length; i += 2) convert(a[i], a[i + 1]);
    }

    static void convert(String in, String out) throws Exception {
        byte[] raw = Files.readAllBytes(Path.of(in));
        int p = 0;
        String magic = readTok(raw, new int[]{p});
        if (!"P5".equals(magic)) throw new RuntimeException("not P5: " + in);
        int[] pos = {magic.length()};
        // re-parse cleanly
        pos[0] = 0;
        readTok(raw, pos);
        int w = Integer.parseInt(readTok(raw, pos));
        int h = Integer.parseInt(readTok(raw, pos));
        Integer.parseInt(readTok(raw, pos));
        int start = pos[0];

        BufferedImage img = new BufferedImage(w, h, BufferedImage.TYPE_BYTE_GRAY);
        byte[] buf = ((DataBufferByte) img.getRaster().getDataBuffer()).getData();
        System.arraycopy(raw, start, buf, 0, w * h);

        ImageWriter writer = ImageIO.getImageWritersByFormatName("png").next();
        try (ImageOutputStream ios = ImageIO.createImageOutputStream(new File(out))) {
            writer.setOutput(ios);
            ImageWriteParam param = writer.getDefaultWriteParam();
            IIOMetadata meta = writer.getDefaultImageMetadata(
                new ImageTypeSpecifier(img), param);
            IIOMetadataNode root = new IIOMetadataNode("javax_imageio_png_1.0");
            IIOMetadataNode gAMA = new IIOMetadataNode("gAMA");
            // default to sRGB-like: 0.45455
            gAMA.setAttribute("value", "45455");
            root.appendChild(gAMA);
            meta.mergeTree("javax_imageio_png_1.0", root);
            writer.write(null, new IIOImage(img, null, meta), param);
        } finally {
            writer.dispose();
        }
        System.out.println("wrote " + out);
    }

    static String readTok(byte[] raw, int[] pos) {
        while (pos[0] < raw.length) {
            int c = raw[pos[0]] & 0xff;
            if (c == '#') {
                while (pos[0] < raw.length && raw[pos[0]] != '\n') pos[0]++;
                continue;
            }
            if (!Character.isWhitespace(c)) break;
            pos[0]++;
        }
        StringBuilder sb = new StringBuilder();
        while (pos[0] < raw.length) {
            int c = raw[pos[0]] & 0xff;
            if (Character.isWhitespace(c)) { pos[0]++; break; }
            sb.append((char) c);
            pos[0]++;
        }
        return sb.toString();
    }
}
