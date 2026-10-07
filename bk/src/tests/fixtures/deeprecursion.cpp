int down(int n) {
    return down(n + 1) + 1;
}
int main() {
    return down(0);
}
