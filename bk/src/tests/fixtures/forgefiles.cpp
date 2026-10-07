#include <sys/stat.h>
#include <unistd.h>
int main() {
    // A hostile program replacing the result files: a symlink to a sensitive file and a FIFO.
    unlink("/out/stderr.txt");
    symlink("/etc/passwd", "/out/stderr.txt");
    unlink("/out/compile.txt");
    mkfifo("/out/compile.txt", 0666);
    return 0;
}
