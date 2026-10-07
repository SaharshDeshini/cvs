#include <cstdlib>
#include <cstring>
int main() {
    for (int mb = 0; mb < 4096; mb++) {
        char* p = static_cast<char*>(std::malloc(1 << 20));
        if (p) std::memset(p, 1, 1 << 20);
    }
    return 0;
}
