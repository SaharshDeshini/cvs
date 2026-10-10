#include <vector>

int main() {
    std::vector<int> v = {4, 7, 9};
    int sum = 0;
    for (int x : v) {
        sum += x;
    }
    int a[3] = {1, 2, 3};
    for (int y : a) {
        sum += y;
    }
    return sum;
}
