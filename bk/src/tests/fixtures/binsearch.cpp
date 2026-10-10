int main() {
    int a[8] = {1, 3, 5, 7, 9, 11, 13, 15};
    int target = 11;
    int lo = 0, hi = 7;
    int found = -1;
    while (lo <= hi) {
        int mid = (lo + hi) / 2;
        if (a[mid] == target) {
            found = mid;
            break;
        }
        if (a[mid] < target) lo = mid + 1;
        else hi = mid - 1;
    }
    return found;
}
