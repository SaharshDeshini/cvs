# Replays the heaplog.so allocation log (heaplog.c) into a table of heap blocks the tracer can query by address.
# A block stays in the table after free(), marked dead, so a pointer to it can be reported as dangling.
import bisect
import struct

import gdb

EVENT = struct.Struct("<QQQ")
ALLOC, FREE = 1, 2
MAX_EVENTS = 65536


class Block:
    __slots__ = ("start", "size", "live")

    def __init__(self, start, size, live):
        self.start, self.size, self.live = start, size, live

    def contains(self, addr):
        return self.start <= addr < self.start + max(self.size, 1)


class HeapLog:
    def __init__(self):
        self.blocks = {}      # start address -> Block
        self.starts = []      # sorted block start addresses
        self.consumed = 0
        self.overflowed = False   # the log filled up: later frees/allocations are not seen (docs: D-027)
        self.count_addr = None
        self.log_addr = None

    def _locate_symbols(self):
        try:
            self.count_addr = int(gdb.parse_and_eval("(unsigned long)&cvis_count"))
            self.log_addr = int(gdb.parse_and_eval("(unsigned long)&cvis_log"))
        except gdb.error:
            self.count_addr = self.log_addr = None  # shim not loaded (e.g. statically linked): no heap information

    def refresh(self):
        """Apply the events logged since the last call. Returns True when the table changed."""
        if self.count_addr is None:
            self._locate_symbols()
            if self.count_addr is None:
                return False
        inferior = gdb.selected_inferior()
        try:
            total = struct.unpack("<Q", bytes(inferior.read_memory(self.count_addr, 8)))[0]
        except gdb.MemoryError:
            return False
        if total > MAX_EVENTS:
            self.overflowed = True
            total = MAX_EVENTS
        if total <= self.consumed:
            return False
        raw = bytes(inferior.read_memory(self.log_addr + self.consumed * EVENT.size, (total - self.consumed) * EVENT.size))
        for offset in range(0, len(raw), EVENT.size):
            self._apply(*EVENT.unpack_from(raw, offset))
        self.consumed = total
        return True

    def _apply(self, addr, size, kind):
        if kind == ALLOC:
            self._evict_overlapped(addr, size)
            if addr not in self.blocks:
                bisect.insort(self.starts, addr)
            self.blocks[addr] = Block(addr, size, True)
        elif kind == FREE:
            block = self.blocks.get(addr)
            if block is not None:
                block.live = False

    def _evict_overlapped(self, addr, size):
        """A new allocation owns its address range: any older (freed) block that started inside it is stale. Left in
        the table it would capture pointers into the new block, or hide the new block behind it in `find`."""
        low = bisect.bisect_left(self.starts, addr)
        high = bisect.bisect_left(self.starts, addr + max(size, 1))
        for start in self.starts[low:high]:
            if start != addr:
                del self.blocks[start]
        self.starts[low:high] = [start for start in self.starts[low:high] if start == addr]

    def find(self, addr):
        """The block containing `addr` (live or freed), or None."""
        index = bisect.bisect_right(self.starts, addr) - 1
        if index < 0:
            return None
        block = self.blocks[self.starts[index]]
        return block if block.contains(addr) else None
