int main() {
    int big[1000];
    for (int i = 0; i < 1000; i++) {
        big[i] = i * 2;
    }
    int last = big[999];
    return last > 0 ? 0 : 1;
}
