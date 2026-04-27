package com.twibright.optar;

import java.io.BufferedOutputStream;
import java.io.IOException;
import java.io.OutputStream;
import java.io.PrintStream;
import java.nio.file.Files;
import java.nio.file.NoSuchFileException;
import java.nio.file.Path;

/**
 * Optar decoder. Reads a series of scanned PNG pages and writes the decoded
 * payload bytes to {@code stdout}. Per-page debug images are written to
 * {@code {base}_NNNN_debug.pgm}.
 *
 * CLI: unoptar &lt;format&gt; &lt;input filename base&gt;
 *
 * The {@code format} string has the form {@code 0-XCROSSES-YCROSSES-CPITCH-CHALF-FEC_ORDER-BORDER-TEXT_HEIGHT}
 * (the same sequence optar prints at the bottom of each page). Only the
 * trailing {@code TEXT_HEIGHT} value is actually honoured - all other
 * dimensions are fixed at compile time.
 */
public final class Unoptar {

    // -------------------- MAGIC CONSTANTS (tune to read noisy scans) --------------------
    static double UNSHARP_MASK  = 7.0;
    static double UNSHARP_DIST  = 1.0;
    static float  SYNC_WHITE_CUT = 0.10f;
    static float  WHITE_CUT      = 0.06f;
    static double MINMAX_FILTER  = 0.5;
    static double PIXEL_BLUR     = 0.25;
    static double CROSS_TRIM     = 0.75;
    // ------------------------------------------------------------------------------------

    static final double OUTPUT_GAMMA = 0.454545;
    static final double FINESTEP     = 0.25;

    private static final PrintStream LOG = System.err;

    // Per-page state, mirroring unoptar.c's file-static globals.
    private int width, height;
    private byte[] ary;      // live image
    private byte[] newary;   // scratch / debug output

    private final long[] histogram = new long[256];
    private int globalCutlevel;
    private int fillGlobalCutlevel;
    private int average;

    private final long[][] corners = new long[4][2];
    private long leftedge, rightedge, topedge, bottomedge;

    private final double[][][] crosses = new double[Common.XCROSSES][Common.YCROSSES][2];
    private final float[][]  cutlevels = new float[Common.XCROSSES][Common.YCROSSES];

    private int chalfFine, chalf;
    private float[] searchArea;
    private int searchStride;

    private long bad01, bad10, badTotal, irreparable;
    private final long[] golayStats = new long[5];

    private double pixelhx, pixelhy, pixelvx, pixelvy;
    private double hpixel, vpixel;

    private int[] queX;
    private int[] queY;
    private int queSize;
    private int qRead, qWrite;

    private int textHeight = 24;
    private int formatHeight;

    private OutputStream payloadOut;
    private int payloadAccu = 1;

    // Accumulator for FEC symbol bits, reset each symbol. BCH(63,45) needs a long.
    private long readHammingAccu;
    private int  readHammingBits;

    private boolean badBitsHeaderPrinted;

    public static void main(String[] args) throws IOException {
        if (args.length < 2) {
            LOG.println(
                "\nusage: unoptar <format> <input filename base>\n\n" +
                "Scan the pages into PNG on 600+ DPI grayscale with gamma off.\n" +
                "Read the number sequence from the bottom of any page and feed it as\n" +
                "the format argument; the base is the filename part before the first\n" +
                "underscore.\n\n" +
                "Example:\n" +
                "  unoptar 0-65-93-24-3-10-2-24 scan > out.ogg\n");
            System.exit(1);
        }
        Unoptar u = new Unoptar();
        u.parseFormat(args[0]);
        u.initDimensions();
        u.printChanInfo();

        try (OutputStream out = new BufferedOutputStream(
                new java.io.FileOutputStream(java.io.FileDescriptor.out))) {
            u.payloadOut = out;
            u.processFiles(args[1]);
        }
    }

    // ---------- top-level ----------

    private void parseFormat(String format) {
        String[] parts = format.split("-");
        if (parts.length >= 8) {
            try { textHeight = Integer.parseInt(parts[7]); }
            catch (NumberFormatException ignored) {}
        }
        LOG.printf("Format: text height=%d%n", textHeight);
    }

    private void initDimensions() {
        formatHeight = 2 * Common.BORDER + Common.DATA_HEIGHT + textHeight;
    }

    private void printChanInfo() {
        LOG.printf("Unformatted channel capacity %.6g kB, ",
            (double) Common.WIDTH * formatHeight / 8 / 1000);
        LOG.printf("formatted raw channel capacity %.6g kB, ",
            (double) Common.TOTALBITS / 8 / 1000);
        LOG.printf("net BCH payload capacity %.6g kB, ",
            (double) Common.NETBITS / 8 / 1000);
        LOG.printf("%d BCH symbols, ", Common.FEC_SYMS);
        LOG.printf("%d bits unused (incomplete BCH symbol), ",
            Common.TOTALBITS - Common.USEDBITS);
        LOG.printf("border taking %.6g%% of unformatted capacity, ",
            100 * (1.0 - (double) Common.DATA_WIDTH * Common.DATA_HEIGHT / Common.WIDTH / formatHeight));
        LOG.printf("border with crosses taking %.6g%% of unformatted capacity, ",
            100 * (1.0 - (double) Common.TOTALBITS / Common.WIDTH / formatHeight));
        LOG.printf("border with crosses and BCH taking %.6g%% of unformatted capacity.%n",
            100 * (1.0 - (double) Common.NETBITS / Common.WIDTH / formatHeight));
    }

    private void processFiles(String base) throws IOException {
        for (int fileNumber = 1; ; fileNumber++) {
            if (fileNumber >= 9999) {
                LOG.println("unoptar: Too many pages - 10,000 or more.");
                System.exit(1);
            }
            String name = String.format("%s_%04d.png", base, fileNumber);
            Path p = Path.of(name);
            if (!Files.exists(p)) {
                if (fileNumber == 1) {
                    LOG.printf("unoptar: cannot open %s: No such file or directory%n", name);
                    System.exit(1);
                }
                return;
            }
            processFile(p);
        }
    }

    private void processFile(Path file) throws IOException {
        LOG.printf("Decoding PNG file %s...%n", file);

        PngReader.Gray g = PngReader.read(file);
        width  = g.width;
        height = g.height;
        ary    = g.pixels;
        newary = new byte[width * height];
        LOG.printf("Input %d x %d pixels, taking %.6g megabytes for 2 framebuffers.%n",
            width, height, 2.0 * width * height / 1e6);

        calcHistogram();
        analyzeCutlevel();

        LOG.print("Removing dirt from the white border: ");
        removeDirtFromBorder();

        LOG.println("Searching for the corners.");
        findCorners();

        syncCrosses();

        processMinmax();
        blurCopy();

        printMarks();

        readSyms();

        // Reset per-page accumulators.
        readHammingAccu = 0;
        readHammingBits = 0;

        String name = file.toString();
        String debugName = name.endsWith(".png")
            ? name.substring(0, name.length() - 4) + "_debug.pgm"
            : name + "_debug.pgm";
        LOG.printf("Writing debug image into %s.%n", debugName);
        dumpNewary(Path.of(debugName));

        ary = null;
        newary = null;
        searchArea = null;
    }

    // ---------- histogram / cutlevel ----------

    private void calcHistogram() {
        for (int i = 0; i < 256; i++) histogram[i] = 0;
        long total = 0;
        for (int i = 0; i < ary.length; i++) {
            int v = ary[i] & 0xff;
            histogram[v]++;
        }
        for (int i = 0; i < 256; i++) total += (long) i * histogram[i];
        long n = (long) width * height;
        average = (int) ((total + (n >> 1)) / n);
        LOG.printf("Average pixel value %d%n", average);
    }

    private void analyzeCutlevel() {
        fillGlobalCutlevel = globalCutlevel = average;

        final int MAXITER = 32;
        int iter;
        for (iter = 0; iter < MAXITER; iter++) {
            int lastCut = globalCutlevel;
            double whiteRms = 0, blackRms = 0;
            long blackPixels = 0, whitePixels = 0;

            for (int i = 0; i < globalCutlevel; i++) {
                double d = globalCutlevel - i;
                blackRms += histogram[i] * d * d;
                blackPixels += histogram[i];
            }
            for (int i = globalCutlevel + 1; i < 256; i++) {
                double d = i - globalCutlevel;
                whiteRms += histogram[i] * d * d;
                whitePixels += histogram[i];
            }
            if (whitePixels != 0) whiteRms = Math.sqrt(whiteRms / whitePixels);
            if (blackPixels != 0) blackRms = Math.sqrt(blackRms / blackPixels);

            double white = globalCutlevel + whiteRms;
            double black = globalCutlevel - blackRms;
            globalCutlevel     = (int) Math.floor(white * SYNC_WHITE_CUT + black * (1 - SYNC_WHITE_CUT) + 0.5);
            fillGlobalCutlevel = (int) Math.floor(white * 0.5 + black * 0.5 + 0.5);
            LOG.printf("Black %.6g, white %.6g, cutlevel %d (0x%02x), fill cutlevel %d (0x%02x)%n",
                black, white, globalCutlevel, globalCutlevel,
                fillGlobalCutlevel, fillGlobalCutlevel);
            if (globalCutlevel == lastCut) break;
        }
        if (iter == MAXITER) {
            LOG.printf("Warning: cutting point analysis didn't converge in %d iterations.%n", MAXITER);
        }
    }

    // ---------- flood fill: clear dirt outside the data area ----------

    private void queWrite(int x, int y) {
        queX[qWrite] = x;
        queY[qWrite] = y;
        qWrite++;
        if (qWrite >= queSize) qWrite = 0;
        if (qWrite == qRead) {
            LOG.println("unoptar: Floodfill queue overflowed.");
            System.exit(1);
        }
    }

    private boolean queRead(int[] xy) {
        if (qWrite == qRead) return false;
        xy[0] = queX[qRead];
        xy[1] = queY[qRead];
        qRead++;
        if (qRead >= queSize) qRead = 0;
        return true;
    }

    private void initQue() { qRead = 0; qWrite = 0; }

    /** If destination is still white (0xff), test the source and if OK mark dest black and enqueue. */
    private void tryCopyWhite(int x, int y, boolean test) {
        int idx = y * width + x;
        if (test && (ary[idx] & 0xff) < fillGlobalCutlevel) return;
        if (newary[idx] == 0) return; // already done
        newary[idx] = 0;
        queWrite(x, y);
    }

    private void fill(int x, int y, boolean test) {
        initQue();
        tryCopyWhite(x, y, test);
        int[] xy = new int[2];
        while (queRead(xy)) {
            x = xy[0]; y = xy[1];
            if (x + 1 < width)  tryCopyWhite(x + 1, y, test);
            if (x > 0)          tryCopyWhite(x - 1, y, test);
            if (y + 1 < height) tryCopyWhite(x, y + 1, test);
            if (y > 0)          tryCopyWhite(x, y - 1, test);
        }
    }

    private void eraseDirt() {
        long dirt = 0;
        for (int i = 0; i < ary.length; i++) {
            int v = (ary[i] & 0xff) | (newary[i] & 0xff);
            ary[i] = (byte) v;
            dirt += (newary[i] & 1);
        }
        LOG.printf("erased %d pixels of dirt.%n", dirt);
    }

    private void removeDirtFromBorder() {
        queSize = (Math.max(width, height) << 1) + 5;
        queX = new int[queSize];
        queY = new int[queSize];

        // Paint newary all 0xff; fill() walks and sets visited pixels to 0.
        for (int i = 0; i < newary.length; i++) newary[i] = (byte) 0xff;

        fill(0, 0, true);
        fill(width >> 1, 0, true);
        fill(width - 1, 0, true);
        fill(0, height >> 1, true);
        fill(0, height - 1, true);
        fill(width - 1, height - 1, true);
        fill(width - 1, height >> 1, true);
        fill(width >> 1, height - 1, true);
        LOG.print("white border identified, ");
        fill(width >> 1, height >> 1, false);
        LOG.print("data area identified, ");

        eraseDirt();
        queX = null; queY = null;
    }

    // ---------- corners ----------

    private int[] diagScan(int xin, int yin, int dx, int dy) {
        int limit = Math.min(width, height);
        for (int xbegin = xin, len = 1; (dx > 0 ? xbegin < limit : xbegin >= 0) && len <= limit; xbegin += dx, len++) {
            int x = xbegin;
            int y = yin;
            for (int ctr = len; ctr > 0; ctr--, x -= dx, y += dy) {
                int px = getpixu(x, y);
                if (px < globalCutlevel) return new int[]{ x, y };
            }
        }
        return new int[]{ -1, -1 };
    }

    private int getpixu(int x, int y) {
        if (x < 0 || y < 0 || x >= width || y >= height) return 0xff;
        return ary[x + y * width] & 0xff;
    }

    private void findCorners() {
        int[] p;

        p = diagScan(0, 0, 1, 1);
        if (p[0] < 0) { cornerFail("upper left"); return; }
        corners[0][0] = p[0]; corners[0][1] = p[1];

        p = diagScan(width - 1, 0, -1, 1);
        if (p[0] < 0) { cornerFail("upper right"); return; }
        corners[1][0] = p[0] + 1; corners[1][1] = p[1];

        p = diagScan(0, height - 1, 1, -1);
        if (p[0] < 0) { cornerFail("lower left"); return; }
        corners[2][0] = p[0]; corners[2][1] = p[1] + 1;

        p = diagScan(width - 1, height - 1, -1, -1);
        if (p[0] < 0) { cornerFail("lower right"); return; }
        corners[3][0] = p[0] + 1; corners[3][1] = p[1] + 1;

        leftedge   = Math.min(corners[0][0], corners[2][0]);
        rightedge  = Math.max(corners[1][0], corners[3][0]);
        topedge    = Math.min(corners[0][1], corners[1][1]);
        bottomedge = Math.max(corners[2][1], corners[3][1]);

        hpixel = (corners[1][0] + corners[3][0] - corners[0][0] - corners[0][0]) / 2.0 / Common.WIDTH;
        vpixel = (corners[2][1] + corners[3][1] - corners[0][1] - corners[1][1]) / 2.0 / formatHeight;
        LOG.printf("One bit is %.6g horizontal pixels and %.6g vertical pixels.%n", hpixel, vpixel);

        int hchalf = (int) (hpixel * Common.CHALF * 0.5);
        int vchalf = (int) (vpixel * Common.CHALF * 0.5);
        chalf = Math.min(hchalf, vchalf);

        hchalf = (int) (hpixel * (Common.CHALF - CROSS_TRIM));
        vchalf = (int) (vpixel * (Common.CHALF - CROSS_TRIM));
        chalfFine = Math.min(hchalf, vchalf);

        pixelhx = ((double) corners[1][0] + corners[3][0] - corners[0][0] - corners[2][0]) / 2;
        pixelhy = ((double) corners[1][1] + corners[3][1] - corners[0][1] - corners[2][1]) / 2;
        pixelvx = ((double) corners[2][0] + corners[3][0] - corners[0][0] - corners[1][0]) / 2;
        pixelvy = ((double) corners[2][1] + corners[3][1] - corners[0][1] - corners[1][1]) / 2;
        double vl = Math.sqrt(pixelhx * pixelhx + pixelhy * pixelhy);
        pixelhx /= vl; pixelhy /= vl;
        vl = Math.sqrt(pixelvx * pixelvx + pixelvy * pixelvy);
        pixelvx /= vl; pixelvy /= vl;

        LOG.printf(
            "Input horizontal pixel vector %.6g,%.6g, vertical %.6g,%.6g. skew %.6g deg, perpendicularity %.6g deg.%n",
            pixelhx, pixelhy, pixelvx, pixelvy,
            normalizeAngle(angle(pixelhx, -pixelhy) + angle(pixelvx, -pixelvy) + 90) / 2,
            angle(pixelhx, -pixelhy) - angle(pixelvx, -pixelvy));

        searchStride = 4 * chalf + 1;
        searchArea = new float[searchStride * searchStride];
        LOG.printf("Allocating search area of %d x %d (%d) pixels.%n",
            chalf << 1, chalf << 1, (chalf * chalf) << 2);
        LOG.printf("Upper corners at %d, %d and %d, %d,%n" +
                   "lower corners at %d, %d and %d, %d.%n" +
                   "Cross half for searching is %d x %d input pixels.%n",
            corners[0][0], corners[0][1], corners[1][0], corners[1][1],
            corners[2][0], corners[2][1], corners[3][0], corners[3][1],
            chalf, chalf);
    }

    private void cornerFail(String which) {
        LOG.printf("Error: cannot find %s corner%n", which);
        LOG.println("See failure_debug.pgm why.");
        System.arraycopy(ary, 0, newary, 0, ary.length);
        try { dumpNewary(Path.of("failure_debug.pgm")); } catch (IOException ignored) {}
        System.exit(1);
    }

    private static double angle(double x, double y) {
        double deg;
        if (Math.abs(x) > Math.abs(y)) {
            deg = 180.0 / Math.PI * Math.asin(y);
            if (x < 0) deg = 180 - deg;
        } else {
            deg = 180.0 / Math.PI * Math.asin(x);
            if (y < 0) deg = deg - 90;
            else       deg = 90 - deg;
        }
        return deg;
    }

    private static double normalizeAngle(double a) {
        return Math.IEEEremainder(a, 360);
    }

    // ---------- pixel sampling ----------

    private static double bilinear(double ul, double ur, double ll, double lr, double hpar, double vpar) {
        double u = ur * hpar + ul * (1 - hpar);
        double l = lr * hpar + ll * (1 - hpar);
        return l * vpar + u * (1 - vpar);
    }

    private static float bilinearF(float ul, float ur, float ll, float lr, float hpar, float vpar) {
        float u = ur * hpar + ul * (1 - hpar);
        float l = lr * hpar + ll * (1 - hpar);
        return l * vpar + u * (1 - vpar);
    }

    /** Integers in centres of pixels. Interpolates, clamps, returns 0xff for out-of-range. */
    private float getPixelInterp(double x, double y) {
        int xi = x < 0 ? 0 : (int) Math.floor(x);
        int yi = y < 0 ? 0 : (int) Math.floor(y);
        return bilinearF(
            getpixu(xi, yi), getpixu(xi + 1, yi),
            getpixu(xi, yi + 1), getpixu(xi + 1, yi + 1),
            (float) (x - xi), (float) (y - yi));
    }

    private float pixelCorrectSample(double x, double y) {
        double hdist = hpixel * UNSHARP_DIST;
        double vdist = vpixel * UNSHARP_DIST;
        float avg;
        avg  = getPixelInterp(x - hdist * pixelhx, y - hdist * pixelhy);
        avg += getPixelInterp(x + hdist * pixelhx, y + hdist * pixelhy);
        avg += getPixelInterp(x + vdist * pixelvx, y + vdist * pixelvy);
        avg += getPixelInterp(x - vdist * pixelvx, y - vdist * pixelvy);
        avg /= 4;
        float val = getPixelInterp(x, y);
        val += (float) (UNSHARP_MASK * (val - avg));
        return val;
    }

    private float diffpix(double x, double y) {
        return getPixelInterp(x, y) - globalCutlevel;
    }

    // ---------- cross correlation & sync ----------

    private float crossCorrel(double x, double y) {
        float sum = 0;
        for (int dx = 0; dx < chalfFine; dx++) {
            for (int dy = 0; dy < chalfFine; dy++) {
                sum -= diffpix(x + dx, y + dy);
                sum -= diffpix(x - 1 - dx, y - 1 - dy);
                sum += diffpix(x + dx, y - 1 - dy);
                sum += diffpix(x - 1 - dx, y + dy);
            }
        }
        return sum;
    }

    private float getsearch(int xpos, int ypos) {
        return searchArea[ypos * searchStride + xpos];
    }

    private float crossCorrelSearch(int xpos, int ypos) {
        xpos += 2 * chalf;
        ypos += 2 * chalf;
        float sum = -4 * getsearch(xpos, ypos);
        sum += 2 * (getsearch(xpos - chalf, ypos) + getsearch(xpos + chalf, ypos)
                  + getsearch(xpos, ypos - chalf) + getsearch(xpos, ypos + chalf));
        sum -= getsearch(xpos - chalf, ypos - chalf) + getsearch(xpos - chalf, ypos + chalf)
             + getsearch(xpos + chalf, ypos - chalf) + getsearch(xpos + chalf, ypos + chalf);
        return sum;
    }

    private void integrateSearchArea() {
        int n = searchStride;
        // Horizontal prefix-sum: first col is zero (the x==0 row/col is already zero).
        for (int y = 0; y < n; y++) {
            int row = y * n;
            for (int x = 1; x < n; x++) {
                searchArea[row + x] += searchArea[row + x - 1];
            }
        }
        // Vertical prefix-sum.
        for (int y = 1; y < n; y++) {
            int row = y * n;
            int prev = row - n;
            for (int x = 0; x < n; x++) {
                searchArea[row + x] += searchArea[prev + x];
            }
        }
    }

    private void crossStats(int cx, int cy) {
        double centerx = crosses[cx][cy][0];
        double centery = crosses[cx][cy][1];
        int hh = (int) Math.floor(hpixel * (Common.CHALF - CROSS_TRIM));
        int vh = (int) Math.floor(vpixel * (Common.CHALF - CROSS_TRIM));

        double whiteRms = 0, blackRms = 0;
        long whitePixels = 0, blackPixels = 0;
        for (int xoff = -hh; xoff <= hh; xoff++) {
            for (int yoff = -vh; yoff <= vh; yoff++) {
                double sx = centerx + xoff * pixelhx + yoff * pixelvx;
                double sy = centery + xoff * pixelhy + yoff * pixelvy;
                float val = getPixelInterp(sx, sy);
                if (val > globalCutlevel) {
                    double d = val - globalCutlevel;
                    whiteRms += d * d;
                    whitePixels++;
                } else if (val < globalCutlevel) {
                    double d = val - globalCutlevel;
                    blackRms += d * d;
                    blackPixels++;
                }
            }
        }
        float cutlevelResult;
        if (whitePixels == 0 || blackPixels == 0) {
            cutlevelResult = globalCutlevel;
        } else {
            whiteRms = Math.sqrt(whiteRms / whitePixels);
            blackRms = Math.sqrt(blackRms / blackPixels);
            double white = globalCutlevel + whiteRms;
            double black = globalCutlevel - blackRms;
            cutlevelResult = (float) (white * WHITE_CUT + black * (1 - WHITE_CUT));
        }
        cutlevels[cx][cy] = cutlevelResult;
        LOG.printf("%02x ", (int) Math.floor(cutlevelResult + 0.5));
    }

    private void loadSearchArea(double centerx, double centery) {
        int n = searchStride;
        for (int yoff = -2 * chalf - 1, yi = 0; yoff < 2 * chalf; yoff++, yi++) {
            for (int xoff = -2 * chalf - 1, xi = 0; xoff < 2 * chalf; xoff++, xi++) {
                int idx = yi * n + xi;
                if (yoff == -2 * chalf - 1 || xoff == -2 * chalf - 1) {
                    searchArea[idx] = 0;
                } else {
                    double sx = centerx + xoff * pixelhx + yoff * pixelvx;
                    double sy = centery + xoff * pixelhy + yoff * pixelvy;
                    searchArea[idx] = diffpix(sx, sy);
                }
            }
        }
    }

    private void resyncCross(double[] coordpair) {
        loadSearchArea(coordpair[0], coordpair[1]);
        integrateSearchArea();

        int xoffmax = 0, yoffmax = 0;
        float max = crossCorrelSearch(0, 0);

        for (int xoff = -chalf; xoff <= chalf; xoff++) {
            for (int yoff = -chalf; yoff <= chalf; yoff++) {
                float r = crossCorrelSearch(xoff, yoff);
                if (r > max) { max = r; xoffmax = xoff; yoffmax = yoff; }
            }
        }
        double xmax = coordpair[0] + xoffmax * pixelhx + yoffmax * pixelvx;
        double ymax = coordpair[1] + xoffmax * pixelhy + yoffmax * pixelvy;

        // Fine sub-pixel resync.
        int HALFRANGE = (int) (0.5 / FINESTEP);
        xoffmax = 0; yoffmax = 0;
        max = crossCorrel(xmax, ymax);
        for (int xoff = -HALFRANGE; xoff <= HALFRANGE; xoff++) {
            for (int yoff = -HALFRANGE; yoff <= HALFRANGE; yoff++) {
                double sx = xmax + xoff * FINESTEP * pixelhx + yoff * FINESTEP * pixelvx;
                double sy = ymax + xoff * FINESTEP * pixelhy + yoff * FINESTEP * pixelvy;
                float r = crossCorrel(sx, sy);
                if (r > max) { max = r; xoffmax = xoff; yoffmax = yoff; }
            }
        }
        xmax += xoffmax * FINESTEP * pixelhx + yoffmax * FINESTEP * pixelvx;
        ymax += xoffmax * FINESTEP * pixelhy + yoffmax * FINESTEP * pixelvy;
        coordpair[0] = xmax;
        coordpair[1] = ymax;
    }

    private void syncCrosses() {
        double rightx = ((double) corners[1][0] + corners[3][0] - corners[0][0] - corners[2][0]) / 2
            * Common.CPITCH / Common.WIDTH;
        double righty = ((double) corners[1][1] + corners[3][1] - corners[0][1] - corners[2][1]) / 2
            * Common.CPITCH / Common.WIDTH;
        double downx  = ((double) corners[2][0] + corners[3][0] - corners[0][0] - corners[1][0]) / 2
            * Common.CPITCH / formatHeight;
        double downy  = ((double) corners[2][1] + corners[3][1] - corners[0][1] - corners[1][1]) / 2
            * Common.CPITCH / formatHeight;

        crosses[0][0][0] = bilinear(corners[0][0], corners[1][0], corners[2][0], corners[3][0],
            (double) (Common.BORDER + Common.CHALF) / Common.WIDTH,
            (double) (Common.BORDER + Common.CHALF) / formatHeight);
        crosses[0][0][1] = bilinear(corners[0][1], corners[1][1], corners[2][1], corners[3][1],
            (double) (Common.BORDER + Common.CHALF) / Common.WIDTH,
            (double) (Common.BORDER + Common.CHALF) / formatHeight);

        LOG.printf("Finding crosses (%d lines), numbers indicate individual cutlevels:%n",
            Common.YCROSSES);

        for (int cy = 0; cy < Common.YCROSSES; cy++) {
            LOG.printf("%3d: ", cy);
            for (int cx = 0; cx < Common.XCROSSES; cx++) {
                if (cx > 0) {
                    crosses[cx][cy][0] = crosses[cx - 1][cy][0] + rightx;
                    crosses[cx][cy][1] = crosses[cx - 1][cy][1] + righty;
                } else if (cy > 0) {
                    crosses[cx][cy][0] = crosses[cx][cy - 1][0] + downx;
                    crosses[cx][cy][1] = crosses[cx][cy - 1][1] + downy;
                }
                resyncCross(crosses[cx][cy]);
                crossStats(cx, cy);
            }
            LOG.println();
        }
    }

    // ---------- bit sampling coordinate lookup ----------

    private void bitCoord(double[] xyOut, float[] cutOut, int x, int y) {
        int cx = x < Common.CHALF ? 0 : (x - Common.CHALF) / Common.CPITCH;
        int cy = y < Common.CHALF ? 0 : (y - Common.CHALF) / Common.CPITCH;
        if (cx > Common.XCROSSES - 2) cx = Common.XCROSSES - 2;
        if (cy > Common.YCROSSES - 2) cy = Common.YCROSSES - 2;

        int rx = x - (cx * Common.CPITCH + Common.CHALF);
        int ry = y - (cy * Common.CPITCH + Common.CHALF);

        double xrem = ((double) rx + 0.5) / Common.CPITCH;
        double yrem = ((double) ry + 0.5) / Common.CPITCH;

        double xd = bilinear(crosses[cx][cy][0], crosses[cx + 1][cy][0],
                             crosses[cx][cy + 1][0], crosses[cx + 1][cy + 1][0], xrem, yrem);
        double yd = bilinear(crosses[cx][cy][1], crosses[cx + 1][cy][1],
                             crosses[cx][cy + 1][1], crosses[cx + 1][cy + 1][1], xrem, yrem);
        if (cutOut != null) {
            cutOut[0] = bilinearF(cutlevels[cx][cy], cutlevels[cx + 1][cy],
                                  cutlevels[cx][cy + 1], cutlevels[cx + 1][cy + 1],
                                  (float) xrem, (float) yrem);
        }
        xyOut[0] = xd - 0.5;
        xyOut[1] = yd - 0.5;
    }

    // ---------- preprocessing: minmax + blur ----------

    private void max() {
        for (int y = height - 1; y >= 0; y--) {
            int start = y * width;
            for (int x = width - 1; x > 0; x--) {
                int a = ary[start + x] & 0xff;
                int b = ary[start + x - 1] & 0xff;
                ary[start + x] = (byte) (a > b ? a : b);
            }
        }
        for (int y = height - 1; y >= 1; y--) {
            int cur  = y * width;
            int prev = cur - width;
            for (int x = 0; x < width; x++) {
                int a = ary[cur + x] & 0xff;
                int b = ary[prev + x] & 0xff;
                ary[cur + x] = (byte) (a > b ? a : b);
            }
        }
    }

    private void min() {
        for (int y = 0; y < height; y++) {
            int start = y * width;
            for (int x = 0; x < width - 1; x++) {
                int a = ary[start + x] & 0xff;
                int b = ary[start + x + 1] & 0xff;
                ary[start + x] = (byte) (a < b ? a : b);
            }
        }
        for (int y = 0; y < height - 1; y++) {
            int cur  = y * width;
            int next = cur + width;
            for (int x = 0; x < width; x++) {
                int a = ary[cur + x] & 0xff;
                int b = ary[next + x] & 0xff;
                ary[cur + x] = (byte) (a < b ? a : b);
            }
        }
    }

    private void processMinmax() {
        double npix = Math.floor(Math.sqrt(vpixel * hpixel) * MINMAX_FILTER);
        int n = (int) npix;
        if (n > 0) LOG.printf("Doing %d cycles of max and %d cycles of min.%n", n, n);
        for (int i = 1; i <= n; i++) { max(); LOG.printf("%d ", i); }
        for (int i = 1; i <= n; i++) { min(); LOG.printf("%d ", i); }
        if (n > 0) LOG.println();
    }

    private void blurCopy() {
        int blurCycles = (int) Math.floor(vpixel * hpixel * PIXEL_BLUR * PIXEL_BLUR + 0.5);
        if (blurCycles > 0) LOG.printf("Doing %d cycles of 1 2 1 / 2 4 2 / 1 2 1 blur.%n", blurCycles);

        for (int cycle = 1; cycle <= blurCycles; cycle++) {
            // Copy topmost row.
            System.arraycopy(ary, 0, newary, 0, width);
            for (int y = 1; y < height - 1; y++) {
                int row = y * width;
                newary[row] = ary[row]; // leftmost
                for (int x = 1; x < width - 1; x++) {
                    int c = ary[row + x] & 0xff;
                    int n = ary[row - width + x] & 0xff;
                    int s = ary[row + width + x] & 0xff;
                    int w = ary[row + x - 1] & 0xff;
                    int e = ary[row + x + 1] & 0xff;
                    int nw = ary[row - width + x - 1] & 0xff;
                    int ne = ary[row - width + x + 1] & 0xff;
                    int sw = ary[row + width + x - 1] & 0xff;
                    int se = ary[row + width + x + 1] & 0xff;
                    int v = (c << 2) + ((n + s + w + e) << 1) + (nw + ne + sw + se);
                    v = (v + 8) >> 4;
                    newary[row + x] = (byte) v;
                }
                newary[row + width - 1] = ary[row + width - 1];
            }
            // Copy bottommost row.
            int lastRow = (height - 1) * width;
            System.arraycopy(ary, lastRow, newary, lastRow, width);
            System.arraycopy(newary, 0, ary, 0, ary.length);
            LOG.printf("%d ", cycle);
        }
        if (blurCycles <= 0) {
            System.arraycopy(ary, 0, newary, 0, ary.length);
        } else {
            LOG.println();
        }
    }

    // ---------- decoding loop ----------

    private void resetStats() {
        bad01 = bad10 = badTotal = irreparable = 0;
        for (int i = 0; i < 5; i++) golayStats[i] = 0;
        badBitsHeaderPrinted = false;
    }

    private void readSyms() {
        resetStats();

        double[] xyOut = new double[2];
        float[] cutOut = new float[1];
        int[] pix = new int[2];

        for (int symNo = 0; symNo < Common.FEC_SYMS; symNo++) {
            for (int bit = 0; bit < Common.FEC_LARGEBITS; bit++) {
                long seq = symNo + (long) bit * Common.FEC_SYMS;
                Common.seq2xy(pix, seq);
                int xb = pix[0], yb = pix[1];
                bitCoord(xyOut, cutOut, xb, yb);
                double xc = xyOut[0], yc = xyOut[1];
                float pixval = pixelCorrectSample(xc, yc);

                if ((xb & 7) == 0 || (yb & 7) == 0) {
                    int v = (int) Math.floor(pixval + 0.5);
                    if (v > 255) v = 255; else if (v < 0) v = 0;
                    v ^= 255;
                    writepix(xc + 0.5, yc + 0.5, (byte) v);
                }
                readHammingBit(pixval < cutOut[0] ? 1 : 0, symNo);
            }
        }
        printBadbitFinish();
    }

    private void writepix(double x, double y, byte c) {
        int xi = (int) Math.floor(x);
        int yi = (int) Math.floor(y);
        if (xi >= 0 && yi >= 0 && xi < width && yi < height) {
            newary[xi + yi * width] = c;
        }
    }

    private void readHammingBit(int inputBit, int symNo) throws RuntimeException {
        readHammingAccu = (readHammingAccu << 1) | (inputBit & 1L);
        readHammingBits++;
        if (readHammingBits >= Common.FEC_LARGEBITS) {
            long mask = (1L << Common.FEC_LARGEBITS) - 1;
            long data = unbch(readHammingAccu & mask, symNo);
            for (int shift = Common.FEC_SMALLBITS - 1; shift >= 0; shift--) {
                readPayloadBit((int) ((data >> shift) & 1L));
            }
            readHammingAccu = 0L;
            readHammingBits = 0;
        }
    }

    private void readPayloadBit(int bit) {
        payloadAccu = (payloadAccu << 1) | (bit & 1);
        if ((payloadAccu & 0x100) != 0) {
            try {
                payloadOut.write(payloadAccu & 0xff);
            } catch (IOException e) {
                throw new RuntimeException(e);
            }
            payloadAccu = 1;
        }
    }

    private long unbch(long in, int symNo) {
        long mask = (1L << Common.FEC_LARGEBITS) - 1;
        in &= mask;
        Bch.Decoded dec = Bch.decode(in);
        if (!dec.reparable) {
            LOG.println();
            for (int badbit = 0; badbit < Common.FEC_LARGEBITS; badbit++) {
                printBadbit(symNo, badbit, 2);
            }
            LOG.println("!");
            irreparable += 4;
            badTotal += 4;
            golayStats[4]++;
            return in >>> Common.FEC_SMALLBITS;
        }
        if (dec.errors > 0) {
            long corrected = (dec.data << Common.FEC_SMALLBITS) | (in & ((1L << Common.FEC_SMALLBITS) - 1));
            // For reporting, recover the actual corrected codeword by XOR-ing
            // bit positions where corrected differs from received. Cheaper to
            // recompute here than thread the locator through Bch.decode.
            long codeword = bchEncodeCanonical(dec.data);
            unbchBadBits(codeword, in, symNo);
        }
        if (dec.errors >= 0 && dec.errors <= 3) {
            golayStats[dec.errors]++;
        }
        return dec.data;
    }

    /** Re-encode canonical 63-bit codeword for the given 45-bit data; used only
     *  for bad-bit reporting (to know which positions were flipped). */
    private static long bchEncodeCanonical(long data) {
        return Bch.encode(data);
    }

    private void unbchBadBits(long right, long wrong, long symNo) {
        long diff = right ^ wrong;
        for (int bit = Common.FEC_LARGEBITS - 1; bit >= 0; bit--) {
            if (((diff >> bit) & 1L) != 0) {
                printBadbit((int) symNo, (Common.FEC_LARGEBITS - 1) - bit, (int) ((wrong >> bit) & 1L));
            }
        }
    }

    // ---------- bad-bit reporting ----------

    private void printBadbit(int symbol, int bit, int dir) {
        if (!badBitsHeaderPrinted) {
            LOG.print("The following coordinates have damaged bits. \",\" is black dirt, " +
                      "\"'\" white dirt, \":\"bit which is a part of an irreparable symbol. " +
                      "Exclamation marks (!) indicate irreparable damage: ");
            badBitsHeaderPrinted = true;
        }
        if (dir == 1) { bad01++; badTotal++; }
        else if (dir == 0) { bad10++; badTotal++; }

        long seq = symbol + (long) bit * Common.FEC_SYMS;
        int[] xy = new int[2];
        Common.seq2xy(xy, seq);
        double[] xyOut = new double[2];
        bitCoord(xyOut, null, xy[0], xy[1]);
        long xd = (long) Math.floor(xyOut[0] + 0.5);
        long yd = (long) Math.floor(xyOut[1] + 0.5);
        markBadBit((int) xd, (int) yd, dir);
        char delim;
        switch (dir) {
            case 0:  delim = '\''; break;
            case 1:  delim = ',';  break;
            default: delim = ':';  break;
        }
        LOG.printf("%d%c%d ", xd, delim, yd);
    }

    private void printBadbitFinish() {
        if (badTotal > 0) {
            LOG.printf(
                "%n%d bits bad from %d, bit error rate %.6g%%. %.6g%% black dirt, " +
                "%.6g%% white dirt and %d (%.6g%%) irreparable.%n",
                badTotal, Common.USEDBITS, 100.0 * badTotal / Common.USEDBITS,
                100.0 * bad01 / badTotal, 100.0 * bad10 / badTotal,
                irreparable, 100.0 * irreparable / badTotal);
        } else {
            LOG.println("No bad bits!");
        }
        LOG.printf(
            "BCH stats%n=========%n" +
            "0 bad bits      %d%n" +
            "1 bad bit       %d%n" +
            "2 bad bits      %d%n" +
            "3 bad bits      %d%n" +
            "4 bad bits      %d%n" +
            "total codewords %d%n",
            golayStats[0], golayStats[1], golayStats[2], golayStats[3], golayStats[4],
            golayStats[0] + golayStats[1] + golayStats[2] + golayStats[3] + golayStats[4]);
    }

    private void markBadBit(int x, int y, int dir) {
        int size = (int) Math.floor(2 * Math.sqrt(hpixel * vpixel) + 0.5);
        int v = dir != 0 ? 0 : 255;

        if (dir == 1) {
            for (int u = 0; u < leftedge; u++) writepixu(u, y, (byte) 0);
            for (int u = 0; u < topedge; u++)  writepixu(x, u, (byte) 0);
        } else if (dir == 0) {
            for (int u = (int) rightedge; u < width; u++)  writepixu(u, y, (byte) 0);
            for (int u = (int) bottomedge; u < height; u++) writepixu(x, u, (byte) 0);
        }

        for (int i = -size; i <= size; i++) {
            writepixu(x + i,         y - size + 1, (byte) v);
            writepixu(x + i,         y + size - 1, (byte) v);
            writepixu(x - size + 1,  y + i,        (byte) v);
            writepixu(x + size - 1,  y + i,        (byte) v);
        }
        int v2 = dir == 2 ? 0x80 : v ^ 0xff;
        for (int i = -size; i <= size; i++) {
            writepixu(x + i,     y - size, (byte) v2);
            writepixu(x + i,     y + size, (byte) v2);
            writepixu(x - size,  y + i,    (byte) v2);
            writepixu(x + size,  y + i,    (byte) v2);
        }
    }

    private void writepixu(int x, int y, byte c) {
        if (x >= 0 && y >= 0 && x < width && y < height) {
            newary[x + y * width] = c;
        }
    }

    // ---------- debug marks ----------

    private void mark(double x, double y) {
        int xu = (int) Math.floor(x + 0.5);
        int yu = (int) Math.floor(y + 0.5);
        writepixu(xu,     yu,     (byte) 0xff);
        writepixu(xu - 1, yu - 1, (byte) 0xff);
        writepixu(xu - 1, yu,     (byte) 0);
        writepixu(xu,     yu - 1, (byte) 0);
    }

    private void printMarks() {
        mark(corners[0][0], corners[0][1]);
        mark(corners[1][0], corners[1][1]);
        mark(corners[2][0], corners[2][1]);
        mark(corners[3][0], corners[3][1]);

        for (int cy = 0; cy < Common.YCROSSES; cy++) {
            for (int cx = 0; cx < Common.XCROSSES; cx++) {
                double x = crosses[cx][cy][0];
                double y = crosses[cx][cy][1];
                mark(x, y);
                mark(x + chalf * pixelhx, y + chalf * pixelhy);
                mark(x - chalf * pixelhx, y - chalf * pixelhy);
                mark(x + chalf * pixelvx, y + chalf * pixelvy);
                mark(x - chalf * pixelvx, y - chalf * pixelvy);
            }
        }
    }

    // ---------- debug PGM dump ----------

    private void dumpNewary(Path file) throws IOException {
        // Re-apply output gamma: newary currently holds linear-ish intensities.
        byte[] lut = new byte[256];
        for (int i = 0; i < 256; i++) {
            double r = 255.0 * Math.pow(i / 255.0, OUTPUT_GAMMA);
            int v = (int) Math.floor(r + 0.5);
            if (v > 255) v = 255;
            if (v < 0)   v = 0;
            lut[i] = (byte) v;
        }
        byte[] out = new byte[newary.length];
        for (int i = 0; i < newary.length; i++) out[i] = lut[newary[i] & 0xff];
        Pgm.write(file, out, width, height);
    }
}
