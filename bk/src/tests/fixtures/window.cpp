int main() {
    int a[8] = {2, 1, 5, 1, 3, 2, 4, 6};
    int k = 3;
    int sum = 0;
    int best = 0;
    int left = 0;
    for (int right = 0; right < 8; right++) {
        sum += a[right];
        if (right - left + 1 > k) {
            sum -= a[left];
            left++;
        }
        if (right - left + 1 == k && sum > best) best = sum;
    }
    return best;
}
