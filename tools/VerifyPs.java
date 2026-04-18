import java.nio.file.*;
import java.util.regex.*;

/** Parse the hex bitmap out of a pgm2ps-style PostScript file and compare it
 *  to the matching PGM. Pixel value != 0 in the PGM must correspond to bit=1. */
public class VerifyPs {
    public static void main(String[] a) throws Exception {
        String ps = Files.readString(Path.of(a[0]));
        byte[] pgm = Files.readAllBytes(Path.of(a[1]));

        Matcher m = Pattern.compile("(\\d+) (\\d+) 1").matcher(ps);
        if (!m.find()) throw new RuntimeException("no image header");
        int w = Integer.parseInt(m.group(1));
        int h = Integer.parseInt(m.group(2));
        int rowBytes = (w + 7) >>> 3;

        int start = ps.indexOf("image\n") + 6;
        int end   = ps.indexOf("grestore", start);
        String hex = ps.substring(start, end).replaceAll("\\s+", "");
        if (hex.length() != rowBytes * h * 2)
            throw new RuntimeException("hex length " + hex.length()
                + " != expected " + (rowBytes * h * 2));

        byte[] bitmap = new byte[rowBytes * h];
        for (int i = 0; i < bitmap.length; i++) {
            bitmap[i] = (byte) Integer.parseInt(hex.substring(i*2, i*2+2), 16);
        }

        // Skip PGM header.
        int p = 0; int nl = 0;
        while (nl < 3) { if (pgm[p] == '\n') nl++; p++; }
        int mismatches = 0;
        for (int y = 0; y < h; y++) {
            for (int x = 0; x < w; x++) {
                boolean pgmWhite = (pgm[p + y * w + x] & 0xff) != 0;
                boolean psWhite  = (bitmap[y * rowBytes + (x >>> 3)] & (0x80 >> (x & 7))) != 0;
                if (pgmWhite != psWhite) mismatches++;
            }
        }
        System.out.println("mismatches: " + mismatches + " / " + (w * h));
        if (mismatches != 0) System.exit(1);
    }
}
