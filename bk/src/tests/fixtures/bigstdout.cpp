#include <cstdio>
int main() {
    for (int i = 0; i < 3 * 1024 * 1024 / 16; i++) std::printf("0123456789abcde\n");
    return 0;
}
