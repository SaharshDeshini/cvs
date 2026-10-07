#include <unistd.h>
int main() {
    for (int i = 0; i < 500; i++) {
        if (fork() == 0) { pause(); _exit(0); }
    }
    return 0;
}
