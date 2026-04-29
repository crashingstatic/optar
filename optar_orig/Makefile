LDFLAGS=-L/usr/local/lib
CFLAGS=-O3 -Wall -Wuninitialized -fomit-frame-pointer -funroll-loops \
	-fstrength-reduce -DNODEBUG `libpng-config --I_opts`
LDLIBS=-lpng -lz -lm
INCLUDES=-I/usr/local/include/libpng

CC=gcc

all: optar unoptar

install:
	install optar /usr/local/bin/
	install unoptar /usr/local/bin
	install pgm2ps /usr/local/bin

uninstall:
	rm /usr/local/bin/optar
	rm /usr/local/bin/unoptar
	rm /usr/local/bin/pgm2ps

clean:
	rm -f optar unoptar *.o

common.o: common.c optar.h
	$(CC) -c $(CPPFLAGS) $(CFLAGS) -o $@ $<

parity.o: parity.c
	$(CC) -c $(CPPFLAGS) $(CFLAGS) -o $@ $<

bch.o: bch.c bch.h
	$(CC) -c $(CPPFLAGS) $(CFLAGS) -o $@ $<

optar.o: optar.c optar.h font.h parity.h bch.h
	$(CC) -c $(CPPFLAGS) $(CFLAGS) -o $@ $<

unoptar.o: unoptar.c optar.h parity.h bch.h
	$(CC) -c $(INCLUDES) $(CPPFLAGS) $(CFLAGS) -o $@ $<

optar: optar.o common.o bch.o parity.o
	$(CC) $(LDFLAGS) -o $@ $^

unoptar: unoptar.o common.o bch.o parity.o
	$(CC) $(LDFLAGS) -o $@ $^ $(LDLIBS)
