# Reads gdb values into the typed value tree of trace schema 2 (docs/ARCHITECTURE.md): scalars, arrays, structs/classes,
# pointers/references, and STL containers through GDB's own pretty-printers. Everything is read from the stopped
# program; a value that cannot be read becomes {"kind": "unavailable"}, never a guess.
#
# Entry shapes (all have "type"; "value" is display text):
#   int|float|bool|char|enum   {"kind", "value"}
#   ptr                        {"addr": "0x..", "to": pointee type, "state": null|heap|freed, "block": "0x..", "text"?, "ref"?}
#   array                      {"len", "elem", "elemKind"?, "elemSize", "items": [str | entry], "more"?}
#   struct                     {"fields": [{"name", "v": entry}]}
#   string                     {"value"}
#   seq | map                  {"container", "len"?, "items": [str | entry] | [{"k", "v"}], "more"?}
#   block (heap table only)    {"size", "live", "ty", "v"?: entry, "orphan"?}
# "at"/"size" (own address / byte size) are kept only on entries some pointer in the same snapshot points into.
import bisect
import itertools
import re
import struct

import gdb

MAX_TEXT = 300
MAX_ITEMS = 64
MAX_FIELDS = 40
MAX_DEPTH = 6
MAX_NODES = 2500
MAX_BLOCKS = 150
MAX_STRING = 60
MAX_BLOCK_ELEMENTS = 1 << 20   # array length assumed for a heap block (a forged block size must not build a huge gdb type)
MAX_COUNTED = 5000   # how far past the shown window a container without a printed size is counted
LENGTH_IN_SUMMARY = re.compile(r"(?:length|with)\s+(\d+)")
INDEXED_CHILD = re.compile(r"^\[\d+\]$")
SEQUENCE_CONTAINERS = frozenset(("vector", "list", "forward_list", "deque", "set", "multiset", "unordered_set",
                                 "unordered_multiset", "array"))
STRUCT_CODES = (gdb.TYPE_CODE_STRUCT, gdb.TYPE_CODE_UNION)
REF_CODES = (gdb.TYPE_CODE_REF, gdb.TYPE_CODE_RVALUE_REF)
STRUCT_FORMATS = {1: "b", 2: "h", 4: "i", 8: "q"}


def type_name(gdb_type):
    return str(gdb_type)[:200]


def scalar_kind(stripped):
    """Kind name for primitive types, None for everything else."""
    code = stripped.code
    if code == gdb.TYPE_CODE_BOOL:
        return "bool"
    if code == gdb.TYPE_CODE_FLT:
        return "float"
    if code == gdb.TYPE_CODE_ENUM:
        return "enum"
    if code == gdb.TYPE_CODE_INT:
        return "char" if stripped.sizeof == 1 else "int"
    return None


def is_signed(stripped):
    try:
        return stripped.is_signed
    except AttributeError:
        return "unsigned" not in str(stripped)


def char_text(byte):
    if byte == 0:
        return "'\\0'"
    return repr(chr(byte)) if byte in (9, 10, 13) or 32 <= byte < 127 else str(byte)


def container_name(type_text):
    """`std::__cxx11::list<int>` -> `list`; the template name without namespaces."""
    return type_text.split("<", 1)[0].rsplit("::", 1)[-1]


def block_value(start, target_type, count):
    pointer = gdb.Value(start).cast(target_type.pointer())
    if count == 1:
        return pointer.dereference()
    return pointer.cast(target_type.array(count - 1).pointer()).dereference()


class Reader:
    def __init__(self, heap):
        self.heap = heap
        self.exposed = {}   # block start -> pointee gdb.Type: blocks the user has seen, so a leak can still be drawn
        self.begin()

    def begin(self):
        """Start one snapshot: forget the bookkeeping of the previous one."""
        self.nodes = 0
        self.addressed = []   # entries that carry _at/_size until pruning
        self.targets = []     # every address some pointer in this snapshot points to
        self.pending = []     # (pointee type, Block) to follow into the heap
        self.truncated = False  # a cap hid part of what is reachable: absence of a pointer proves nothing this snapshot

    # ── reading ──────────────────────────────────────────────────────────────────────────────────────────────────
    def read(self, value, depth=0):
        self.nodes += 1
        entry = {"type": type_name(value.type)}
        if depth > MAX_DEPTH or self.nodes > MAX_NODES:
            self.truncated = True
            entry.update(kind="raw", value="…")
            return entry
        try:
            self._fill(value, value.type.strip_typedefs(), entry, depth)
        except Exception as err:  # noqa: BLE001 - a pretty-printer over a half-built object can raise anything; one
            # unreadable value must not end the whole trace (KeyboardInterrupt from the line timer is not an Exception)
            return {"kind": "unavailable", "type": entry["type"], "value": str(err)[:MAX_TEXT]}
        return entry

    def _fill(self, value, stripped, entry, depth):
        self._note_address(value, stripped, entry)
        code = stripped.code
        kind = scalar_kind(stripped)
        if kind is not None:
            entry.update(kind=kind, value=str(value)[:MAX_TEXT])
        elif code == gdb.TYPE_CODE_PTR:
            self._fill_pointer(value, stripped, entry)
        elif code in REF_CODES:
            self._fill_reference(value, entry)
        elif code == gdb.TYPE_CODE_ARRAY:
            self._fill_array(value, stripped, entry, depth)
        elif code in STRUCT_CODES:
            self._fill_struct(value, stripped, entry, depth)
        else:
            entry.update(kind="raw", value=str(value)[:MAX_TEXT])

    def _note_address(self, value, stripped, entry):
        try:
            address = value.address
        except gdb.error:
            address = None
        if address is not None:
            entry["_at"], entry["_size"] = int(address), stripped.sizeof
            self.addressed.append(entry)

    def _fill_pointer(self, value, stripped, entry):
        target_type = stripped.target()
        target = target_type.strip_typedefs()
        addr = int(value)
        entry.update(kind="ptr", addr=hex(addr), value=str(value)[:MAX_TEXT], to=type_name(target_type), state=None)
        if target.code == gdb.TYPE_CODE_FUNC:
            entry["fn"] = True
            return
        if addr == 0:
            entry["state"] = "null"
            return
        if target.code == gdb.TYPE_CODE_INT and target.sizeof == 1:
            entry["text"] = self._c_string(value)
        self._follow(entry, addr, target_type, target)

    def _fill_reference(self, value, entry):
        target = value.referenced_value()
        addr = int(target.address)
        entry.update(kind="ptr", ref=True, addr=hex(addr), value=str(target)[:MAX_TEXT], to=type_name(target.type), state=None)
        self._follow(entry, addr, target.type, target.type.strip_typedefs())  # a reference to a heap object leads there too

    def _follow(self, entry, addr, target_type, target):
        """Record where a pointer points; if that is a heap block, queue it so the heap table can show it."""
        self.targets.append(addr)
        block = self.heap.find(addr)
        if block is None:
            return
        entry["state"] = "heap" if block.live else "freed"
        entry["block"] = hex(block.start)
        if target.code != gdb.TYPE_CODE_VOID and target.sizeof > 0:
            self.pending.append((target_type, block))

    @staticmethod
    def _c_string(pointer):
        try:
            return pointer.string(length=MAX_STRING, errors="replace")
        except gdb.error:
            return None

    def _fill_array(self, value, stripped, entry, depth):
        low, high = stripped.range()
        length = max(high - low + 1, 0)
        element_type = stripped.target()
        element = element_type.strip_typedefs()
        shown = min(length, MAX_ITEMS)
        entry.update(kind="array", len=length, elem=type_name(element_type), elemSize=element.sizeof)
        elem_kind = scalar_kind(element)
        if elem_kind is not None:
            entry["elemKind"] = elem_kind
            entry["items"] = self._scalar_items(value, element, elem_kind, shown)
        else:
            entry["items"] = [self.read(value[index], depth + 1) for index in range(shown)]
        if length > shown:
            entry["more"] = length - shown
            self.truncated = True

    def _scalar_items(self, value, element, elem_kind, count):
        """One memory read for the whole window; falls back to per-element reads for floats, enums and odd sizes."""
        size = element.sizeof
        fmt = STRUCT_FORMATS.get(size)
        if elem_kind in ("float", "enum") or fmt is None or value.address is None:
            return [str(value[index])[:MAX_TEXT] for index in range(count)]
        raw = bytes(gdb.selected_inferior().read_memory(int(value.address), count * size))
        signed = is_signed(element)
        numbers = struct.unpack("<%d%s" % (count, fmt if signed else fmt.upper()), raw)
        if elem_kind == "bool":
            return ["true" if number else "false" for number in numbers]
        if elem_kind == "char":
            return [char_text(number & 0xFF) if number >= 0 else str(number) for number in numbers]
        return [str(number) for number in numbers]

    def _fill_struct(self, value, stripped, entry, depth):
        printer = gdb.default_visualizer(value)
        if printer is not None:
            self._fill_printed(value, printer, entry, depth)
            return
        fields = []
        for field in stripped.fields():
            if not field.is_base_class and not hasattr(field, "bitpos"):
                continue  # static member: not part of the object
            if field.name and field.name.startswith("_vptr"):
                continue
            if len(fields) >= MAX_FIELDS:
                entry["more"] = True
                self.truncated = True
                break
            fields.append({"name": field.name or "", "v": self.read(value[field], depth + 1)})
        entry.update(kind="struct", fields=fields)

    # ── pretty-printed values (STL) ──────────────────────────────────────────────────────────────────────────────
    def _fill_printed(self, value, printer, entry, depth):
        hint = printer.display_hint() if hasattr(printer, "display_hint") else None
        summary = self._text_of(printer.to_string()) if hasattr(printer, "to_string") else ""
        if hint == "string" or not hasattr(printer, "children"):
            entry.update(kind="string" if hint == "string" else "raw", value=summary[:MAX_TEXT])
            return
        entry["container"] = container_name(entry["type"])
        limit = MAX_ITEMS * 2 if hint == "map" else MAX_ITEMS + 1
        iterator = iter(printer.children())
        children = list(itertools.islice(iterator, limit))
        # std::list / forward_list print no count in their summary: count what is left (bounded) instead of guessing
        spilled = sum(1 for _ in itertools.islice(iterator, MAX_COUNTED)) if len(children) == limit else 0
        if hint == "map":
            self._fill_map(children, summary, entry, depth, spilled // 2)
        elif hint == "array" or self._is_sequence(children, entry["container"]):
            self._fill_seq(children, summary, entry, depth, spilled)
        else:
            entry.update(kind="struct", fields=[{"name": str(name), "v": self._child(child, depth)} for name, child in children[:MAX_FIELDS]])

    @staticmethod
    def _is_sequence(children, container):
        """libstdc++ prints list/set/deque without an `array` hint, but their children are named `[0]`, `[1]`...
        (an empty one has no children to look at, so its container name decides)."""
        if children:
            return all(INDEXED_CHILD.match(str(name)) for name, _ in children)
        return container in SEQUENCE_CONTAINERS

    def _fill_seq(self, children, summary, entry, depth, spilled):
        shown = children[:MAX_ITEMS]
        items = [self._child_item(child, depth) for _, child in shown]
        found = LENGTH_IN_SUMMARY.search(summary)
        length = int(found.group(1)) if found else len(children) + spilled
        entry.update(kind="seq", len=length, items=items)
        if all(isinstance(item, str) for item in items) and shown:
            entry["elemKind"] = self._child_kind(shown[0][1])
        if length > len(shown):
            entry["more"] = length - len(shown)
            self.truncated = True

    def _fill_map(self, children, summary, entry, depth, spilled):
        pairs = [(children[index][1], children[index + 1][1]) for index in range(0, len(children) - 1, 2)][:MAX_ITEMS]
        found = LENGTH_IN_SUMMARY.search(summary)
        length = int(found.group(1)) if found else len(children) // 2 + spilled
        entry.update(kind="map", len=length, items=[{"k": self._child_item(k, depth), "v": self._child_item(v, depth)} for k, v in pairs])
        if length > len(pairs):
            entry["more"] = length - len(pairs)
            self.truncated = True

    def _child(self, child, depth):
        if isinstance(child, gdb.Value):
            return self.read(child, depth + 1)
        return {"kind": "raw", "type": type(child).__name__, "value": str(child)[:MAX_TEXT]}

    def _child_item(self, child, depth):
        """Scalars stay plain strings (compact); anything else is read as a full entry."""
        if not isinstance(child, gdb.Value):
            return str(child)[:MAX_TEXT]
        if scalar_kind(child.type.strip_typedefs()) is not None:
            return str(child)[:MAX_TEXT]
        return self.read(child, depth + 1)

    @staticmethod
    def _child_kind(child):
        if isinstance(child, gdb.Value):
            return scalar_kind(child.type.strip_typedefs()) or "int"
        return "int"

    @staticmethod
    def _text_of(head):
        if head is None:
            return ""
        if isinstance(head, str):
            return head
        if hasattr(head, "length") and hasattr(head, "value") and not isinstance(head, gdb.Value):  # gdb.LazyString
            length = head.length if 0 <= head.length <= MAX_TEXT else MAX_TEXT
            return head.value().string(length=length, errors="replace")
        return str(head)

    # ── heap table ───────────────────────────────────────────────────────────────────────────────────────────────
    def finish(self):
        """Read every heap block reachable from what this snapshot read (breadth first, bounded) and settle the
        address bookkeeping. Returns {block start: block entry}; blocks freed or leaked are included, marked."""
        heap = {}
        index = 0
        while index < len(self.pending) and len(heap) < MAX_BLOCKS:
            target_type, block = self.pending[index]
            index += 1
            key = hex(block.start)
            if key not in heap:
                heap[key] = self._read_block(block, target_type)
        if len(heap) >= MAX_BLOCKS:
            self.truncated = True
        if not self.truncated:  # a cap may have hidden the pointer that still reaches a block: do not call it leaked
            self._add_orphans(heap)
        self._prune_addresses()
        return heap

    def _read_block(self, block, target_type):
        info = {"kind": "block", "size": block.size, "live": block.live, "ty": type_name(target_type)}
        if not block.live:
            self.exposed.pop(block.start, None)
            return info
        self.exposed[block.start] = (target_type, block)  # the Block object itself: a reused address is a different block
        try:
            count = min(max(1, block.size // target_type.strip_typedefs().sizeof), MAX_BLOCK_ELEMENTS)
            entry = self.read(block_value(block.start, target_type, count))
        except Exception as err:  # noqa: BLE001 - forged sizes / unreadable memory: show the block as unavailable
            entry = {"kind": "unavailable", "type": info["ty"], "value": str(err)[:MAX_TEXT]}
        entry.pop("_at", None)
        entry.pop("_size", None)
        info["v"] = entry
        return info

    def _add_orphans(self, heap):
        """Blocks the user could see before, still allocated, but no pointer reaches them now: leaked."""
        for start, (target_type, seen) in list(self.exposed.items()):
            key = hex(start)
            block = self.heap.blocks.get(start)
            if key in heap or len(heap) >= MAX_BLOCKS:
                continue
            if block is not seen or not block.live:  # freed, or the address now belongs to a different allocation
                self.exposed.pop(start, None)
                continue
            heap[key] = dict(self._read_block(block, target_type), orphan=True)

    def _prune_addresses(self):
        targets = sorted(set(self.targets))
        for entry in self.addressed:
            at = entry.pop("_at", None)
            size = entry.pop("_size", 0)
            if at is None:
                continue
            position = bisect.bisect_left(targets, at)
            if position < len(targets) and targets[position] < at + max(size, 1):
                entry["at"], entry["size"] = hex(at), size
