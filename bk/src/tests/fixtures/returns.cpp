#include <iostream>
double half(int x) {
    return x / 2.0;
}
bool isEven(int x) {
    return x % 2 == 0;
}
char grade(int score) {
    return score > 50 ? 'A' : 'B';
}
void hello() {
    std::cout << "hi\n";
}
int main() {
    double h = half(5);
    bool e = isEven(4);
    char g = grade(70);
    hello();
    std::cout << h << e << g << std::endl;
    return 0;
}
