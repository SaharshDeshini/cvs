FROM ubuntu:24.04

RUN apt-get update \
 && apt-get install -y --no-install-recommends g++ gdb python3 libstdc++-13-dev \
 && rm -rf /var/lib/apt/lists/* \
 && useradd --create-home --uid 10001 runner \
 && find / -xdev -perm -4000 -exec chmod u-s {} + 2>/dev/null || true

COPY unbuf.c heaplog.c /tmp/
RUN gcc -shared -fPIC -O2 -o /opt/unbuf.so /tmp/unbuf.c \
 && gcc -shared -fPIC -O2 -o /opt/heaplog.so /tmp/heaplog.c \
 && rm /tmp/unbuf.c /tmp/heaplog.c

WORKDIR /tmp
COPY tracer.py heap.py values.py run.sh /opt/
USER runner
ENTRYPOINT ["/bin/bash", "/opt/run.sh"]
