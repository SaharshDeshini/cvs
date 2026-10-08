/* Preloaded into the traced program only (tracer.py sets LD_PRELOAD for the inferior, next to unbuf.so).
 * GDB cannot tell how big a heap block is, or whether it was freed, so the tracer replays this log instead (D-027).
 * `new`/`delete` end up in malloc/free, so wrapping those four covers C and C++ allocations.
 * The shim never allocates and keeps no map: it only appends fixed-size events to a static table. The tracer reads
 * `cvis_count` and `cvis_log` from GDB while the program is stopped on a user line (never inside this code). */
#include <stddef.h>

#define CVIS_EVENTS 65536
#define CVIS_ALLOC 1
#define CVIS_FREE 2

struct cvis_event {
    unsigned long addr;
    unsigned long size;
    unsigned long kind;
};

struct cvis_event cvis_log[CVIS_EVENTS];
unsigned long cvis_count; /* events seen; values >= CVIS_EVENTS mean the table filled up and later events were lost */

extern void *__libc_malloc(size_t);
extern void *__libc_calloc(size_t, size_t);
extern void *__libc_realloc(void *, size_t);
extern void __libc_free(void *);

static void record(unsigned long kind, void *ptr, size_t size) {
    unsigned long slot = __atomic_fetch_add(&cvis_count, 1, __ATOMIC_RELAXED);
    if (slot >= CVIS_EVENTS) return;
    cvis_log[slot].addr = (unsigned long)ptr;
    cvis_log[slot].size = size;
    cvis_log[slot].kind = kind;
}

void *malloc(size_t size) {
    void *ptr = __libc_malloc(size);
    if (ptr) record(CVIS_ALLOC, ptr, size);
    return ptr;
}

void *calloc(size_t count, size_t size) {
    void *ptr = __libc_calloc(count, size);
    if (ptr) record(CVIS_ALLOC, ptr, count * size);
    return ptr;
}

void *realloc(void *old, size_t size) {
    void *ptr = __libc_realloc(old, size);
    if (old && (ptr || size == 0)) record(CVIS_FREE, old, 0);
    if (ptr && size > 0) record(CVIS_ALLOC, ptr, size);
    return ptr;
}

void free(void *ptr) {
    if (ptr) record(CVIS_FREE, ptr, 0);
    __libc_free(ptr);
}
