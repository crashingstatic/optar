#!/usr/bin/env bash
# Round-trip smoke test for the optar Java port:
#   encode a payload -> PGM -> pristine PNG -> decode -> diff.
# Requires the fat JAR already built (./build.sh).
set -euo pipefail

cd "$(dirname "$0")"

JAR=optar.jar
if [ ! -f "$JAR" ]; then
  echo "error: $JAR not found. Run ./build.sh first." >&2
  exit 1
fi

TMP=$(mktemp -d)
trap "rm -rf $TMP" EXIT

# Compile the test-only Pgm2Png helper if needed.
mkdir -p build/tools
javac -d build/tools tools/Pgm2Png.java

FAIL=0

run_roundtrip() {
  local name="$1" input="$2"
  local work="$TMP/$name"
  mkdir -p "$work"
  cp "$input" "$work/payload.bin"
  ( cd "$work" \
    && java -jar "$OLDPWD/$JAR" optar payload.bin page > /dev/null \
    && for p in page_*.pgm; do
         java -cp "$OLDPWD/build/tools" Pgm2Png "$p" "${p%.pgm}.png" > /dev/null
       done \
    && PAGE_COUNT=$(ls page_*.png | wc -l) \
    && java -jar "$OLDPWD/$JAR" unoptar 0-65-93-24-3-1-2-24 page > decoded.out 2> decoder.log \
    && echo "$PAGE_COUNT" > .pagecount
  )
  local page_count
  page_count=$(cat "$work/.pagecount")
  local expected_len
  expected_len=$(wc -c < "$work/payload.bin")
  if head -c "$expected_len" "$work/decoded.out" | cmp -s - "$work/payload.bin"; then
    echo "  [ok]    $name  ($(wc -c < "$work/payload.bin") bytes payload, $page_count pages)"
  else
    echo "  [FAIL]  $name"
    FAIL=1
  fi
}

OLDPWD=$(pwd)

echo "round-trip tests:"

# 1. Short text.
printf 'Hello World! Round trip test payload.\n' > "$TMP/short.in"
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

if [ "$FAIL" -ne 0 ]; then
  echo
  echo "some tests FAILED" >&2
  exit 1
fi

echo
echo "All round-trip tests passed."
