int main() {
    int a[8] = {2, 4, 6, 8, 10, 12, 14, 16};
    int target = 14;
    int left = 0;
    int right = 7;
    int found = -1;
    while (left <= right) {
        int mid = (left + right) / 2;
        if (a[mid] == target) {
            found = mid;
            break;
        }
        if (a[mid] < target) left = mid + 1;
        else right = mid - 1;
    }
    return found;
}
