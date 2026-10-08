#include <list>

int main() {
    std::list<int> numbers;
    for (int i = 0; i < 100; i++) {
        numbers.push_back(i);
    }
    return numbers.size() == 100 ? 0 : 1;
}
