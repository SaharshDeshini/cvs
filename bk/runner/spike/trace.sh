#!/bin/bash
# In-container helper for the Phase 1 spike. usage: trace.sh <file.cpp> [wall_timeout_seconds]
set -u
cd /tmp
g++ -g -O0 -o /tmp/a.out "/work/$1" || exit 2
export SRC="/work/$1" BIN=/tmp/a.out OUT=/tmp/t.jsonl
timeout "${2:-30}" gdb -nx -batch -x /opt/tracer.py 2>&1 | grep -E 'SUMMARY|SIG|signal|fault|Program'
echo "gdb exit: ${PIPESTATUS[0]}"
tail -n 2 /tmp/t.jsonl
