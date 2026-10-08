#include <map>
#include <string>
#include <vector>

int main() {
    std::vector<int> v = {3, 1, 2};
    v.push_back(9);
    std::string s = "hello";
    std::map<std::string, int> m;
    m["one"] = 1;
    m["two"] = 2;
    return (int)(v.size() + s.size() + m.size());
}
