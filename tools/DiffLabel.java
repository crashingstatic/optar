import java.nio.file.*;

public class DiffLabel {
    public static void main(String[] a) throws Exception {
        byte[] ref  = skipPgmHeader(Files.readAllBytes(Path.of(a[0])));
        byte[] mine = skipPgmHeader(Files.readAllBytes(Path.of(a[1])));
        int w = 1546;
        int labelStart = 2216;
        for (int dy = 0; dy < 24; dy++) {
            int y = labelStart + dy;
            int rowStart = y * w;
            StringBuilder refRow = new StringBuilder();
            StringBuilder myRow  = new StringBuilder();
            for (int x = 640; x < 660; x++) {
                refRow.append((ref[rowStart + x] & 0xff) == 0 ? '#' : '.');
                myRow .append((mine[rowStart + x] & 0xff) == 0 ? '#' : '.');
            }
            boolean equal = refRow.toString().equals(myRow.toString());
            System.out.printf("y=%d x=640..659  ref=%s  mine=%s%s%n", y, refRow, myRow, equal ? "" : " <-");
        }
    }
    static byte[] skipPgmHeader(byte[] b) {
        int p = 0, nl = 0;
        while (nl < 3) {
            if (b[p] == '\n') nl++;
            p++;
        }
        byte[] r = new byte[b.length - p];
        System.arraycopy(b, p, r, 0, r.length);
        return r;
    }
}
