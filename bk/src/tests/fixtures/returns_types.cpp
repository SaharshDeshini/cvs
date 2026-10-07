#include <iostream>
#include <stdexcept>
enum class Color { Red, Green, Blue };
struct Pair { int a; int b; };
float third() { return 1.5f; }
int negative() { return -3; }
long long big() { return 5000000000LL; }
unsigned char byteValue() { return 200; }
Color pick() { return Color::Blue; }
int* addressOf(int* p) { return p; }
Pair makePair() { return Pair{1, 2}; }
int& refTo(int& x) { return x; }
int thrower(int x) {
    if (x > 0) throw std::runtime_error("boom");
    return x;
}
int main() {
    int slot = 7;
    float f = third();
    int n = negative();
    long long b = big();
    unsigned char u = byteValue();
    Color c = pick();
    int* p = addressOf(&slot);
    Pair pr = makePair();
    int& r = refTo(slot);
    int caught = 0;
    try {
        thrower(1);
    } catch (const std::exception&) {
        caught = 1;
    }
    std::cout << f << n << b << (int)u << (int)c << *p << pr.a << r << caught << std::endl;
    return 0;
}
