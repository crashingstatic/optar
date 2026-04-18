import java.io.BufferedReader;
import java.io.FileReader;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * One-shot tool: parses optar_orig/font.h and writes a compact
 * 1-bit-per-pixel binary font to src/main/resources/font.bin.
 *
 * Layout of font.bin:
 *   bytes 0..3  : width  (big-endian int, = 1500)
 *   bytes 4..7  : height (big-endian int, = 24)
 *   bytes 8..N  : packed bits, row-major, MSB first, 1=white 0=black.
 *
 * The derivation of "white vs black" matches optar.c:
 *   header_data_cmap[srcptr[x]][0] & 0x80 ? 0xff : 0
 * The cmap in font.h has index 0 -> {0,0,0} and every other index -> {255,255,255},
 * so effectively: pixel==0 means black, anything else means white.
 */
public class FontExtractor {
    public static void main(String[] args) throws Exception {
        Path fontH = Path.of("optar_orig/font.h");
        Path out   = Path.of("src/main/resources/font.bin");

        String src = Files.readString(fontH);

        int width  = parseIntDecl(src, "width");
        int height = parseIntDecl(src, "height");
        System.err.println("font width=" + width + " height=" + height);

        // Locate the header_data array body.
        int start = src.indexOf("header_data[] = {");
        if (start < 0) throw new IllegalStateException("header_data[] not found");
        start = src.indexOf('{', start) + 1;
        int end = src.indexOf('}', start);
        String body = src.substring(start, end);

        // Extract all integer tokens.
        List<Integer> pixels = new ArrayList<>(width * height);
        Matcher m = Pattern.compile("-?\\d+").matcher(body);
        while (m.find()) pixels.add(Integer.parseInt(m.group()));
        if (pixels.size() != width * height) {
            throw new IllegalStateException("pixel count mismatch: got " + pixels.size()
                + ", expected " + (width * height));
        }

        int packedLen = (width * height + 7) / 8;
        byte[] packed = new byte[packedLen];
        for (int i = 0; i < pixels.size(); i++) {
            // white=1, black=0 (index 0 in cmap is black, anything else is white).
            boolean white = pixels.get(i) != 0;
            if (white) packed[i >> 3] |= (byte) (0x80 >> (i & 7));
        }

        ByteBuffer bb = ByteBuffer.allocate(8 + packedLen).order(ByteOrder.BIG_ENDIAN);
        bb.putInt(width);
        bb.putInt(height);
        bb.put(packed);

        Files.createDirectories(out.getParent());
        Files.write(out, bb.array());
        System.err.println("wrote " + out + " (" + bb.capacity() + " bytes)");
    }

    private static int parseIntDecl(String src, String name) {
        Matcher m = Pattern.compile("unsigned int\\s+" + name + "\\s*=\\s*(\\d+)\\s*;").matcher(src);
        if (!m.find()) throw new IllegalStateException("couldn't find unsigned int " + name);
        return Integer.parseInt(m.group(1));
    }
}
