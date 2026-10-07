/* Preloaded into the traced program only (tracer.py sets LD_PRELOAD for the inferior).
 * stdout is redirected to a file, so libc would block-buffer it and the whole output would appear at exit. Making it
 * unbuffered means each write reaches the file when its statement runs, which is what the output panel replays.
 * Bytes and their order are unchanged; only the timing differs from a normal (block-buffered) run. */
#include <stdio.h>

__attribute__((constructor)) static void make_stdout_unbuffered(void) {
    setvbuf(stdout, NULL, _IONBF, 0);
}
