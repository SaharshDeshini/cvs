FROM ubuntu:24.04

RUN apt-get update \
 && apt-get install -y --no-install-recommends g++ gdb python3 libstdc++-13-dev \
 && rm -rf /var/lib/apt/lists/* \
 && useradd --create-home --uid 10001 runner \
 && find / -xdev -perm -4000 -exec chmod u-s {} + 2>/dev/null || true

COPY unbuf.c /tmp/unbuf.c
RUN gcc -shared -fPIC -O2 -o /opt/unbuf.so /tmp/unbuf.c && rm /tmp/unbuf.c

WORKDIR /tmp
COPY tracer.py run.sh /opt/
USER runner
ENTRYPOINT ["/bin/bash", "/opt/run.sh"]
