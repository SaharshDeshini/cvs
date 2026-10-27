int square(int n) {
    int result = n * n;
    return result;
}
int main() {
    int a = square(2);
    int b = square(3);
    return a + b - 13;
}
