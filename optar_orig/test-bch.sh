#!/usr/bin/env bash
# Round-trip smoke test for the C BCH(63,45) optar:
#   encode payload → PGM → PNG → decode → diff.
# Requires the binaries already built (`make`) and the Java Pgm2Png helper
# compiled (run /workspace/test.sh once or "javac -d /workspace/build/tools
#   /workspace/tools/Pgm2Png.java").
set -euo pipefail
cd "$(dirname "$0")"

if [ ! -x ./optar ] || [ ! -x ./unoptar ]; then
  echo "error: build first (cd optar_orig && make)" >&2
  exit 1
fi

PGM2PNG_JAR=/workspace/build/tools
if [ ! -f "$PGM2PNG_JAR/Pgm2Png.class" ]; then
  mkdir -p "$PGM2PNG_JAR"
  javac -d "$PGM2PNG_JAR" /workspace/tools/Pgm2Png.java
fi

TMP=$(mktemp -d)
trap "rm -rf $TMP" EXIT
OLDPWD=$(pwd)

FAIL=0
FORMAT="0-65-93-24-3-10-2-24"

run_roundtrip() {
  local name="$1" input="$2"
  local work="$TMP/$name"
  mkdir -p "$work"
  cp "$input" "$work/payload.bin"
  ( cd "$work" \
    && "$OLDPWD/optar" payload.bin page > optar.log 2>&1 \
    && for p in page_*.pgm; do
         java -cp "$PGM2PNG_JAR" Pgm2Png "$p" "${p%.pgm}.png" > /dev/null
       done \
    && PAGE_COUNT=$(ls page_*.png | wc -l) \
    && "$OLDPWD/unoptar" "$FORMAT" page > decoded.out 2> unoptar.log \
    && echo "$PAGE_COUNT" > .pagecount
  )
  local pages
  pages=$(cat "$work/.pagecount")
  local payload_len
  payload_len=$(wc -c < "$work/payload.bin")
  if head -c "$payload_len" "$work/decoded.out" | cmp -s - "$work/payload.bin"; then
    echo "  [ok]    $name  (${payload_len} bytes payload, ${pages} pages)"
  else
    echo "  [FAIL]  $name"
    FAIL=1
  fi
}

echo "C BCH(63,45,t=3) round-trip tests:"

# 1. Short text.
printf 'Hello World! BCH round trip test.\n' > "$TMP/short.in"
run_roundtrip short "$TMP/short.in"

# 2. Multi-page random binary.
head -c 500000 /dev/urandom > "$TMP/big.in"
run_roundtrip multipage "$TMP/big.in"

# 3. Empty file edge case.
: > "$TMP/empty.in"
run_roundtrip empty "$TMP/empty.in"

# 4. One-byte file.
printf '\xa5' > "$TMP/one.in"
run_roundtrip one-byte "$TMP/one.in"

# 5. Single full-capacity page (BCH = 285,390 B).
head -c 285390 /dev/urandom > "$TMP/fullpage.in"
run_roundtrip fullpage "$TMP/fullpage.in"

if [ "$FAIL" -ne 0 ]; then
  echo
  echo "Some tests FAILED" >&2
  exit 1
fi
echo
echo "All BCH round-trip tests passed."
