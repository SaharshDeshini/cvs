#include <iostream>
int fact(int n) { if (n <= 1) return 1; return n * fact(n - 1); }
int main() { int r = fact(3); std::cout << r << std::endl; return 0; }
