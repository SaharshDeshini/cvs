#include <iostream>
#include <map>
#include <vector>
#include <string>
int main() {
    std::vector<int> v;
    v.push_back(10);
    v.push_back(20);
    std::map<std::string, int> m;
    m["a"] = 1;
    m["b"] = 2;
    std::cout << v.size() + m.size() << std::endl;
    return 0;
}
