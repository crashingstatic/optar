import java.nio.file.*;
import java.io.*;

/** Extract the 24-row label strip from a full optar PGM and save it as its own PGM. */
public class LabelCrop {
    public static void main(String[] a) throws Exception {
        int W = 1546, H = 2242, LABEL_Y = 2216, LABEL_H = 24;
        for (int i = 0; i < a.length; i += 2) {
            byte[] in = Files.readAllBytes(Path.of(a[i]));
            int p = 0, nl = 0;
            while (nl < 3) { if (in[p] == '\n') nl++; p++; }
            byte[] strip = new byte[W * LABEL_H];
            System.arraycopy(in, p + LABEL_Y * W, strip, 0, strip.length);
            try (OutputStream os = Files.newOutputStream(Path.of(a[i + 1]))) {
                os.write(("P5\n" + W + " " + LABEL_H + "\n255\n").getBytes());
                os.write(strip);
            }
            System.out.println("wrote " + a[i + 1]);
        }
    }
}
