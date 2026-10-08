#include <iostream>

int main() {
    int a[6] = {5, 2, 9, 1, 7, 3};
    int n = 6;
    for (int i = 0; i < n - 1; i++) {
        for (int j = 0; j < n - 1 - i; j++) {
            if (a[j] > a[j + 1]) {
                int t = a[j];
                a[j] = a[j + 1];
                a[j + 1] = t;
            }
        }
    }
    std::cout << a[0] << std::endl;
    return 0;
}
