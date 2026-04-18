#!/usr/bin/env bash
# Build optar JARs. Requires JDK 17+ on PATH (javac, jar).
#
# Targets:
#   all      -> optar.jar, optar-encode.jar, optar-decode.jar  (default)
#   combined -> optar.jar           (encode + decode + pgm2ps dispatcher)
#   encode   -> optar-encode.jar    (encoder only)
#   decode   -> optar-decode.jar    (decoder only)
set -euo pipefail

cd "$(dirname "$0")"

SRC=src/main/java
RES=src/main/resources
OUT=build/classes
PKG=com/twibright/optar

target=${1:-all}

rm -rf "$OUT"
mkdir -p "$OUT"

mapfile -t SOURCES < <(find "$SRC" -name '*.java')
javac -d "$OUT" -encoding UTF-8 "${SOURCES[@]}"

if [ -d "$RES" ]; then
  cp -r "$RES"/. "$OUT"/
fi

build_combined() {
  jar --create --file=optar.jar \
      --main-class=com.twibright.optar.Main \
      -C "$OUT" .
  echo "Built optar.jar"
}

# Build a focused JAR containing only the listed class basenames plus any
# bundled resources. Shared support classes (Common, Golay, Pgm) are always
# included.
build_subset() {
  local jarname="$1" mainclass="$2"
  shift 2
  local staging
  staging=$(mktemp -d)
  trap "rm -rf '$staging'" RETURN
  mkdir -p "$staging/$PKG"
  for cls in Common Golay Pgm "$@"; do
    cp "$OUT/$PKG/$cls".class "$staging/$PKG/" 2>/dev/null || true
    # Include inner classes (e.g. Pgm$Image, Golay$Decoded).
    for inner in "$OUT/$PKG/$cls"\$*.class; do
      [ -e "$inner" ] && cp "$inner" "$staging/$PKG/"
    done
  done
  # Copy non-class resources (font.bin etc.).
  if [ -d "$RES" ]; then
    (cd "$OUT" && find . -type f ! -name '*.class') | while read -r f; do
      mkdir -p "$staging/$(dirname "$f")"
      cp "$OUT/$f" "$staging/$f"
    done
  fi
  jar --create --file="$jarname" \
      --main-class="$mainclass" \
      -C "$staging" .
  echo "Built $jarname"
}

case "$target" in
  all)
    build_combined
    build_subset optar-encode.jar com.twibright.optar.Optar   Optar Font
    build_subset optar-decode.jar com.twibright.optar.Unoptar Unoptar PngReader
    ;;
  combined)
    build_combined
    ;;
  encode)
    build_subset optar-encode.jar com.twibright.optar.Optar   Optar Font
    ;;
  decode)
    build_subset optar-decode.jar com.twibright.optar.Unoptar Unoptar PngReader
    ;;
  *)
    echo "unknown target: $target (expected: all, combined, encode, decode)" >&2
    exit 1
    ;;
esac
