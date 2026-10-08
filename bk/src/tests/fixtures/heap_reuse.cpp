int main() {
    int* a = new int(1);
    int* b = new int(2);
    delete a;
    delete b;
    int* big = new int[64];
    for (int i = 0; i < 64; i++) {
        big[i] = i;
    }
    int* mid = big + 40;
    return *mid == 40 ? 0 : 1;
}
