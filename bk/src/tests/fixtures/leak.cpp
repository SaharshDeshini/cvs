void leak() {
    int* p = new int(5);
    (void)p;
}

int main() {
    leak();
    return 0;
}
