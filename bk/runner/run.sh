#!/bin/bash
# Container entrypoint: compile /src/main.cpp, trace it, then return the results on stdout as length-prefixed
# frames (format: bk/src/utils/frames.js). /out is a size-limited tmpfs, so a hostile program can neither fill the
# host disk nor plant symlinks/FIFOs where the host would read them (docs/DECISIONS.md D-016).
# env (set by runnerService): MAX_STEPS COMPILE_SECONDS TRACE_SECONDS MAX_TRACE_BYTES MAX_OUTPUT_BYTES
#                             MAX_COMPILE_OUTPUT_BYTES
set -u
cd /tmp
cp /src/main.cpp /tmp/main.cpp
if [ -f /src/stdin.txt ]; then cp /src/stdin.txt /out/stdin.txt; fi

# emit <name> <max_bytes>: a frame for a regular, non-symlink file (the program may have replaced the file).
# The data is copied first so the frame length stays correct even if a leftover process is still writing.
emit() {
  local path="/out/$1"
  if [ -f "$path" ] && [ ! -L "$path" ]; then
    local copy="/tmp/emit.$$"
    local original
    original=$(stat -c %s "$path")
    head -c "$2" "$path" > "$copy"
    printf '\001CVIS %s %s %s\n' "$1" "$(stat -c %s "$copy")" "$original"
    cat "$copy"
    rm -f "$copy"
  fi
}

# Not piped into head: head closing the pipe early would kill g++ with SIGPIPE and fake a compile error.
timeout "${COMPILE_SECONDS:-20}" g++ -std=c++17 -g -O0 -o /tmp/prog /tmp/main.cpp > /tmp/compile.full 2>&1
compile_rc=$?
head -c "${MAX_COMPILE_OUTPUT_BYTES:-20000}" /tmp/compile.full > /out/compile.txt

if [ "$compile_rc" = "0" ]; then
  export SRC=/tmp/main.cpp BIN=/tmp/prog OUT_DIR=/out
  timeout "${TRACE_SECONDS:-25}" gdb -nx -batch -x /opt/tracer.py > /out/gdb.log 2>&1
fi

# The compile status is a shell variable, not a file, so the program cannot tamper with it.
printf '\001CVIS compile.rc %s %s\n%s' "${#compile_rc}" "${#compile_rc}" "$compile_rc"
emit compile.txt "${MAX_COMPILE_OUTPUT_BYTES:-20000}"
emit trace.jsonl "${MAX_TRACE_BYTES:-5242880}"
emit stdout.txt "${MAX_OUTPUT_BYTES:-1048576}"
emit stderr.txt "${MAX_OUTPUT_BYTES:-1048576}"
