#include <cstdlib>
#include <cstring>
#include <iostream>
int main() {
    for (int mb = 1; mb <= 2048; mb++) {
        char* p = static_cast<char*>(std::malloc(1 << 20));
        if (!p) { std::cout << "malloc failed at " << mb << "MB" << std::endl; return 1; }
        std::memset(p, 1, 1 << 20);
    }
    std::cout << "allocated 2GB" << std::endl;
}
