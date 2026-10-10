int main() {
    int a[6] = {1, 2, 4, 7, 11, 15};
    int target = 15;
    int* lp = a;
    int* rp = a + 5;
    while (lp < rp) {
        int s = *lp + *rp;
        if (s == target) break;
        if (s < target) lp++;
        else rp--;
    }
    return *lp;
}
