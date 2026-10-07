#include <cstdio>
#include <cstring>
int main() {
    static char block[1 << 20];
    std::memset(block, 'x', sizeof block);
    for (int f = 0; f < 200; f++) {
        char name[64];
        std::snprintf(name, sizeof name, "/out/junk%d", f);
        FILE* fp = std::fopen(name, "w");
        if (!fp) break;
        for (int i = 0; i < 16; i++) std::fwrite(block, 1, sizeof block, fp);
        std::fclose(fp);
    }
    return 0;
}
