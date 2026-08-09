const { instrumentCppCode } = require("./services/cppInstrumentationService");

const code = `
#include <iostream>
using namespace std;

struct Node {
    int data;
    Node* next;

    Node(int value) {
        data = value;
        next = nullptr;
    }
};

int main() {
    Node* head = new Node(10);
    head->next = new Node(20);
    head->next->next = new Node(30);

    Node* current = head;

    while (current != nullptr) {
        cout << current->data << " ";
        current = current->next;
    }

    cout << endl;

    return 0;
}
`;

const instrumentedCode = instrumentCppCode(code);

console.log("========== ORIGINAL CODE ==========");
console.log(code);

console.log("\n========== INSTRUMENTED CODE ==========");
console.log(instrumentedCode);
