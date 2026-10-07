# SCV tracer: drives GDB's Python API and writes one JSON record per executed source line, plus one for every
# function return that lands in user code (so one-line functions and recursion unwind step by step, D-025).
# Run inside the runner container: gdb -nx -batch -x tracer.py
# env: SRC (user source path), BIN (binary), OUT_DIR, MAX_STEPS, MAX_INSN_PER_LINE, LINE_SECONDS
# Records (JSON lines, flushed one by one so a wall-clock kill keeps everything written so far):
#   {"t":"step","n":0,"line":3,"fn":"main","depth":1,"stdoutLen":0,"event":"step","frames":[...]}
#     after a return of a primitive-typed function the next step also has "returned":{"fn":"f","kind":"int",...}
#   {"t":"skip","line":5,"reason":"insn_cap"}
#   {"t":"end","status":"exited|crashed|killed|step_limit|line_timeout|tracer_error","exitCode":0,"signal":null,"line":9}
import json
import os
import threading
import time
import traceback

import gdb

SRC = os.environ["SRC"]
BIN = os.environ["BIN"]
OUT_DIR = os.environ.get("OUT_DIR", "/out")
MAX_STEPS = int(os.environ.get("MAX_STEPS", "5000"))
MAX_INSN_PER_LINE = int(os.environ.get("MAX_INSN_PER_LINE", "1000"))
LINE_SECONDS = float(os.environ.get("LINE_SECONDS", "3"))
FLUSH_EVERY = int(os.environ.get("FLUSH_EVERY", "1"))
WRITES = {"count": 0}
TIMING = {"snapshot": 0.0, "advance": 0.0}
LAST_LINE = {}   # frame_key -> line at the previous snapshot
COMPLETED = {}   # frame_key -> set of lines that frame has finished executing
MAX_FRAMES = 64
MAX_FINISH = 50
MAX_TEXT = 300

STDOUT_PATH = os.path.join(OUT_DIR, "stdout.txt")
STDERR_PATH = os.path.join(OUT_DIR, "stderr.txt")
STDIN_PATH = os.path.join(OUT_DIR, "stdin.txt")
TRACE_PATH = os.path.join(OUT_DIR, "trace.jsonl")
UNBUF_LIB = "/opt/unbuf.so"  # makes the program's stdout unbuffered, so output shows up at the step that printed it
USER_FILE = os.path.basename(SRC)

# Written by the GDB event handlers, read by the main loop.
EVENTS = {"signal": None, "exited": False, "exit_code": None}
# Set by advance_one_line when the function it started in returned; attached to the next step record.
PENDING = {"returned": None}
RETURN_REGISTER_CODES = frozenset((gdb.TYPE_CODE_INT, gdb.TYPE_CODE_BOOL, gdb.TYPE_CODE_FLT,
                                   gdb.TYPE_CODE_ENUM, gdb.TYPE_CODE_PTR))


def on_stop(event):
    if isinstance(event, gdb.SignalEvent) and event.stop_signal != "SIGTRAP":
        EVENTS["signal"] = event.stop_signal


def on_exit(event):
    EVENTS["exited"] = True
    EVENTS["exit_code"] = getattr(event, "exit_code", None)


def in_user_code(frame):
    symtab = frame.find_sal().symtab
    return symtab is not None and os.path.basename(symtab.filename) == USER_FILE


def first_user_frame(frame):
    """Newest frame that belongs to the user's file (a crash in libc is reported at the user's call site)."""
    depth = 0
    while frame is not None and depth < 200:
        if in_user_code(frame):
            return frame
        frame = frame.older()
        depth += 1
    return None


def describe(value):
    """Tag a gdb.Value with a kind. Containers/structs are passed through as printer text for now."""
    try:
        vtype = value.type.strip_typedefs()
        code = vtype.code
        text = str(value)[:MAX_TEXT]
        entry = {"type": str(value.type)[:200], "value": text}
        if code == gdb.TYPE_CODE_BOOL:
            entry["kind"] = "bool"
        elif code == gdb.TYPE_CODE_FLT:
            entry["kind"] = "float"
        elif code == gdb.TYPE_CODE_ENUM:
            entry["kind"] = "enum"
        elif code == gdb.TYPE_CODE_INT:
            entry["kind"] = "char" if vtype.sizeof == 1 else "int"
        elif code == gdb.TYPE_CODE_PTR:
            entry["kind"] = "ptr"
            entry["addr"] = hex(int(value))
        else:
            entry["kind"] = "raw"
        return entry
    except gdb.error as err:
        return {"kind": "unavailable", "type": "?", "value": str(err)[:MAX_TEXT]}


def frame_key(frame):
    """Stable identity of a stack frame across steps: function + the caller's stack pointer (= this frame's CFA)."""
    older = frame.older()
    if older is None:
        return (frame.name(), 0)
    try:
        return (frame.name(), int(older.read_register("sp")))
    except gdb.error:
        return (frame.name(), 0)


def note_line(key, line):
    """Remember lines this frame has finished executing (a line counts as done once we are on another one)."""
    previous = LAST_LINE.get(key)
    if previous is not None and previous != line:
        COMPLETED.setdefault(key, set()).add(previous)
    LAST_LINE[key] = line


def is_alive(sym, current_line, completed):
    """A local exists for the user once its declaring line has run; arguments exist from the start."""
    return sym.is_argument or sym.line < current_line or sym.line in completed


def read_vars(frame, key):
    values = {}
    current_line = frame.find_sal().line
    completed = COMPLETED.get(key, set())
    try:
        block = frame.block()
    except RuntimeError:
        return values
    while block is not None and not block.is_global and not block.is_static:
        for sym in block:
            if not (sym.is_variable or sym.is_argument) or sym.name in values:
                continue
            if is_alive(sym, current_line, completed):
                values[sym.name] = read_symbol(sym, frame)
        block = block.superblock
    return values


def read_symbol(sym, frame):
    try:
        return describe(sym.value(frame))
    except gdb.error as err:  # e.g. optimized out / unreadable: one bad variable must not end the trace
        return {"kind": "unavailable", "type": "?", "value": str(err)[:MAX_TEXT]}


def forget_dead_frames(live_keys):
    """Per-frame memory must not outlive the frame: a second call to the same function from the same site has the
    same key, and would otherwise inherit the previous call's completed lines (locals shown before declaration)."""
    for table in (LAST_LINE, COMPLETED):
        for key in [key for key in table if key not in live_keys]:
            del table[key]


def collect_frames(top):
    frames = []
    live_keys = set()
    frame = top
    while frame is not None and len(frames) < MAX_FRAMES:
        if in_user_code(frame):
            key = frame_key(frame)
            live_keys.add(key)
            line = frame.find_sal().line
            note_line(key, line)
            frames.append({"fn": frame.name(), "line": line, "vars": read_vars(frame, key)})
        frame = frame.older()
    forget_dead_frames(live_keys)
    frames.reverse()  # outermost (main) first
    return frames


def stdout_len():
    try:
        return os.path.getsize(STDOUT_PATH)
    except OSError:
        return 0


def write_record(out, record):
    out.write(json.dumps(record) + "\n")
    WRITES["count"] += 1
    if record["t"] != "step" or WRITES["count"] % FLUSH_EVERY == 0:
        out.flush()


def function_block(frame):
    block = frame.block()
    while block is not None and block.function is None:
        block = block.superblock
    return block


def finish_prologue(frame):
    """At a function's first instruction its arguments are not stored yet (they would read as garbage), so run to
    the end of the prologue: the first line-table address after the entry that starts a different line."""
    block = function_block(frame)
    if block is None or frame.pc() != block.start:
        return
    entry_line = frame.find_sal().line
    candidates = sorted((item.pc, item.line) for item in frame.find_sal().symtab.linetable()
                        if block.start < item.pc < block.end)
    target = next((pc for pc, line in candidates if line != entry_line), candidates[0][0] if candidates else None)
    if target is not None:
        try:
            gdb.execute("advance *%s" % hex(target), to_string=True)
        except gdb.error:
            pass  # exited or signalled on the way: the caller's event checks report it


def return_type(frame):
    """Declared return type of the function `frame` runs, if its value is a primitive we can read from a register.
    None for void, structs/containers (memory-returned, later phases), references and `main` (its value is the exit
    code, which the end record already carries)."""
    try:
        function = frame.function()
        if function is None or function.name == "main":
            return None
        rtype = function.type.target()
        stripped = rtype.strip_typedefs()
        if stripped.code not in RETURN_REGISTER_CODES or stripped.sizeof > 8:
            return None
        if stripped.code == gdb.TYPE_CODE_FLT and stripped.sizeof not in (4, 8):
            return None  # long double comes back on the x87 stack
        return rtype
    except gdb.error:
        return None


def read_return_value(rtype, name):
    """Right after `ret`, x86-64 SysV keeps integers/pointers/bool/char/enums in rax and float/double in xmm0."""
    try:
        stripped = rtype.strip_typedefs()
        if stripped.code == gdb.TYPE_CODE_FLT:
            lane = "v4_float" if stripped.sizeof == 4 else "v2_double"
            value = gdb.parse_and_eval("$xmm0.%s[0]" % lane)
        else:
            bits = int(gdb.parse_and_eval("$rax")) & ((1 << (8 * stripped.sizeof)) - 1)
            value = gdb.Value(bits.to_bytes(stripped.sizeof, "little"), rtype)
        entry = describe(value)
        entry["type"] = str(rtype)[:200]
        return dict(entry, fn=name)
    except (gdb.error, ValueError, OverflowError):
        return None  # never guess: no value is better than a wrong one


def advance_one_line():
    """stepi until a new line starts. Returns ok | signal | exited | insn_cap."""
    top = first_user_frame(gdb.selected_frame())
    start_line, start_fn, start_key = top.find_sal().line, top.name(), frame_key(top)
    start_cfa = start_key[1]  # this frame's CFA: the stack pointer once its `ret` has executed
    rtype = return_type(top) if start_cfa > 0 else None
    caller = top.older()
    return_pc = caller.pc() if caller is not None else None  # where a real `ret` lands (an exception unwind does not)
    returned = False
    PENDING["returned"] = None
    for _ in range(MAX_INSN_PER_LINE):
        gdb.execute("stepi", to_string=True)
        if EVENTS["signal"]:
            return "signal"
        if EVENTS["exited"]:
            return "exited"
        frame = gdb.selected_frame()
        if not returned and frame.pc() == return_pc and int(frame.read_register("sp")) >= start_cfa:
            returned = True  # once per advance: later stepi's must not read the caller's registers as the value
            if in_user_code(frame):  # a value returned into library code (comparator, libc) has no frame to show it on
                if rtype is not None:
                    PENDING["returned"] = read_return_value(rtype, start_fn)
                return "ok"  # landing mid-line in the caller is a step of its own: a one-line function has no later
                # line boundary, so without this the rest of the run would vanish into one advance
        if not in_user_code(frame):
            outcome = leave_library_code()
            if outcome != "ok":
                return outcome
            frame = gdb.selected_frame()  # back mid-line in user code: still check whether a new line began
        sal = frame.find_sal()
        if sal.pc != frame.pc():
            continue
        block = function_block(frame)
        entering = block is not None and frame.pc() == block.start  # also true for same-line recursion
        # (line, name) alone misses a recursive return: fact(1) and fact(2) both end on the same `}` line, so the
        # caller's frame is a new step only when its identity (function + CFA) differs from where we started
        if sal.line != start_line or frame.name() != start_fn or entering or frame_key(frame) != start_key:
            if entering:
                finish_prologue(frame)
                if EVENTS["signal"]:
                    return "signal"
                if EVENTS["exited"]:
                    return "exited"
            return "ok"
    return "insn_cap"


def leave_library_code():
    for _ in range(MAX_FINISH):
        frame = gdb.selected_frame()
        if in_user_code(frame):
            return "ok"
        try:
            gdb.execute("finish", to_string=True)
        except gdb.error:
            gdb.execute("continue", to_string=True)  # outermost frame: let the program run out
        if EVENTS["signal"]:
            return "signal"
        if EVENTS["exited"]:
            return "exited"
    return "ok"


def next_line_address(frame):
    """Address of the first code of the nearest later source line in the same function, or None."""
    block = frame.block()
    while block is not None and block.function is None:
        block = block.superblock
    if block is None:
        return None
    current = frame.find_sal().line
    best = None
    for item in frame.find_sal().symtab.linetable():
        if item.line > current and block.start <= item.pc < block.end:
            if best is None or (item.line, item.pc) < best:
                best = (item.line, item.pc)
    return best[1] if best else None


def run_rest_of_line(top):
    """After the per-line instruction cap: run at full speed to the next code line (single-stepping 10^7
    instructions through GDB would take hours). A timer interrupts it if the line never ends."""
    target = next_line_address(top)
    command = "advance *%s" % hex(target) if target is not None else "until"
    timer = threading.Timer(LINE_SECONDS, gdb.interrupt)
    timer.start()
    try:
        gdb.execute(command, to_string=True)
    except gdb.error:
        pass
    finally:
        timer.cancel()
    if EVENTS["signal"] == "SIGINT":
        return "line_timeout"
    if EVENTS["signal"]:
        return "signal"
    return "exited" if EVENTS["exited"] else "ok"


def step_event(depth, previous_depth):
    if previous_depth is None or depth == previous_depth:
        return "step"
    return "call" if depth > previous_depth else "return"


def trace_loop(out):
    """Returns (outcome, last_line). The line is read while the frame is still valid: after the process exits,
    touching the old frame raises, and that must not be how a normal run ends."""
    steps, previous_depth, outcome, line = 0, None, "ok", None
    while steps < MAX_STEPS and outcome == "ok":
        top = first_user_frame(gdb.selected_frame())
        if top is None:
            return "exited", line
        line = top.find_sal().line
        began = time.time()
        frames = collect_frames(top)
        record = {"t": "step", "n": steps, "line": line, "fn": top.name(),
                  "depth": len(frames), "stdoutLen": stdout_len(),
                  "event": step_event(len(frames), previous_depth), "frames": frames}
        returned, PENDING["returned"] = PENDING["returned"], None
        if returned is not None:
            record["returned"] = returned
        write_record(out, record)
        TIMING["snapshot"] += time.time() - began
        steps, previous_depth = steps + 1, len(frames)
        began = time.time()
        outcome = advance_one_line()
        TIMING["advance"] += time.time() - began
        if outcome == "insn_cap":
            write_record(out, {"t": "skip", "line": line, "reason": "insn_cap"})
            outcome = run_rest_of_line(top)
    return ("step_limit" if outcome == "ok" else outcome), line


def guarded_trace(out):
    """Run the loop; an error is explained by an event we saw (exit/signal) or it is a tracer failure, which is
    reported as such (never as a clean exit) and its traceback goes to gdb.log."""
    try:
        return trace_loop(out)
    except gdb.error:
        if EVENTS["signal"]:
            return "signal", None
        if EVENTS["exited"]:
            return "exited", None
        traceback.print_exc()
        return "tracer_error", None
    except Exception:  # noqa: BLE001 - last resort: still write an end record so the backend sees a typed failure
        traceback.print_exc()
        return "tracer_error", None


def classify(outcome):
    """GDB's exited event has no exit_code when the program was killed by a signal (e.g. OOM kill = SIGKILL):
    that must never be reported as a clean exit."""
    if outcome == "signal":
        return "crashed"
    if outcome == "exited" and EVENTS["exited"] and EVENTS["exit_code"] is None:
        return "killed"
    return outcome


def main():
    gdb.events.stop.connect(on_stop)
    gdb.events.exited.connect(on_exit)
    gdb.execute("set pagination off")
    gdb.execute("set confirm off")
    gdb.execute("file %s" % BIN)
    gdb.execute("break main")
    stdin = STDIN_PATH if os.path.exists(STDIN_PATH) else "/dev/null"
    if os.path.exists(UNBUF_LIB):  # a missing library would make the loader print a warning into the user's stderr
        gdb.execute("set environment LD_PRELOAD %s" % UNBUF_LIB)
    gdb.execute("run < %s > %s 2> %s" % (stdin, STDOUT_PATH, STDERR_PATH), to_string=True)
    with open(TRACE_PATH, "w") as out:
        outcome, line = guarded_trace(out)
        write_record(out, {"t": "end", "status": classify(outcome), "exitCode": EVENTS["exit_code"],
                           "signal": EVENTS["signal"], "line": line,
                           "timing": {k: round(v, 3) for k, v in TIMING.items()}})


main()
