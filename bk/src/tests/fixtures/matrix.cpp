#include <vector>

int main() {
    int m[3][4] = {{1, 2, 3, 4}, {5, 6, 7, 8}, {9, 10, 11, 12}};
    std::vector<std::vector<int>> g = {{1, 2}, {3, 4}, {5, 6}};
    int total = 0;
    for (int i = 0; i < 3; i++) {
        for (int j = 0; j < 4; j++) {
            total += m[i][j];
        }
    }
    for (int r = 0; r < 3; r++) {
        for (int c = 0; c < 2; c++) {
            total += g[r][c];
        }
    }
    return total;
}
