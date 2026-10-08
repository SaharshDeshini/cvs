void swap_ints(int* a, int* b) {
    int t = *a;
    *a = *b;
    *b = t;
}

int main() {
    int x = 1, y = 2;
    swap_ints(&x, &y);
    int arr[4] = {10, 20, 30, 40};
    int* p = arr + 2;
    int* h = new int(7);
    int* gone = new int(8);
    delete gone;
    delete h;
    return *p == 30 ? 0 : 1;
}
