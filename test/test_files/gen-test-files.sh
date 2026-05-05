#!/usr/bin/bash

for n in 125 250 375 500 750 1000
do
    dd if=/dev/urandom of=test-${n}.bin bs=1K count=$n
    sha256sum test-${n} >> SHAs
done