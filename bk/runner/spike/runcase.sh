#!/bin/bash
# Host-side helper: run one .cpp through the production image. usage: runcase.sh <name> [wall_seconds]
# Output lands in ./cases/<name>/{src,out}. Needs Docker; set MSYS_NO_PATHCONV=1 in Git Bash.
set -u
name="$1"
wall="${2:-25}"
here="$(cd "$(dirname "$0")" && pwd -W 2>/dev/null || pwd)"
mkdir -p "cases/$name/src" "cases/$name/out"
cp "$name.cpp" "cases/$name/src/main.cpp"
rm -f "cases/$name/out/"*
chmod 777 "cases/$name/out"
start=$(date +%s)
timeout "$wall" docker run --rm --name "cvis-spike-$name" --network none --memory 512m --memory-swap 512m \
  --pids-limit 64 --cpus ${CPUS:-1} --cap-drop ALL --security-opt no-new-privileges \
  --tmpfs /tmp:rw,exec,size=64m --ulimit fsize=20971520:20971520 \
  -e MAX_STEPS=5000 -e FLUSH_EVERY=${FLUSH_EVERY:-1} -e TRACE_SECONDS=15 \
  --mount "type=bind,src=$here/cases/$name/src,dst=/src,readonly" \
  --mount "type=bind,src=$here/cases/$name/out,dst=/out" \
  cvis-runner:2
echo "docker exit: $?  wall: $(( $(date +%s) - start ))s"
