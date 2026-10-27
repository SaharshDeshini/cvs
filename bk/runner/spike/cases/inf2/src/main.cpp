int main() {
    volatile int i = 0;
    while (true) {
        i = i + 1;
    }
    return 0;
}
