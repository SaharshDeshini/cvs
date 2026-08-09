const { parseCppCode, printTree } = require("./services/cppParserService");

const code = `
#include <iostream>
using namespace std;

int main() {
    int x = 10;

    for (int i = 0; i < 3; i++) {
        x += i;
    }

    return 0;
}
`;

const rootNode = parseCppCode(code);

printTree(rootNode);
