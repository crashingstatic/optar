package com.twibright.optar;

import java.io.IOException;
import java.util.Arrays;

/**
 * Subcommand dispatcher for the unified optar fat JAR.
 * Usage: {@code java -jar optar.jar <optar|unoptar|pgm2ps> [args...]}
 */
public final class Main {
    private Main() {}

    public static void main(String[] args) throws IOException {
        if (args.length < 1) { usage(); System.exit(1); }
        String[] rest = Arrays.copyOfRange(args, 1, args.length);
        switch (args[0]) {
            case "optar":   Optar.main(rest);   break;
            case "unoptar": Unoptar.main(rest); break;
            case "pgm2ps":  Pgm2Ps.main(rest);  break;
            case "-h": case "--help": case "help": usage(); break;
            default:
                System.err.println("optar: unknown subcommand: " + args[0]);
                usage();
                System.exit(1);
        }
    }

    private static void usage() {
        System.err.println(
            "Twibright Optar (Java port)\n\n" +
            "  java -jar optar.jar optar   <input-file> [base]\n" +
            "      encode a file into a series of PGM pages.\n\n" +
            "  java -jar optar.jar unoptar <format> <png-base> > output\n" +
            "      decode scanned PNG pages into the original payload on stdout.\n\n" +
            "  java -jar optar.jar pgm2ps  [-a4|-letter] <file.pgm> [...]\n" +
            "      convert PGM pages to A4/Letter PostScript for printing."
        );
    }
}
