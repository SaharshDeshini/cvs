#include <iostream>
#include <unistd.h>
#include <sys/wait.h>
int main() {
    int ok = 0;
    for (int i = 0; i < 200; i++) {
        pid_t pid = fork();
        if (pid < 0) break;
        if (pid == 0) { pause(); _exit(0); }
        ok++;
    }
    std::cout << "forked " << ok << " of 200" << std::endl;
    _exit(0);
}
