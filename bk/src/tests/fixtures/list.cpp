#include <iostream>

struct Node {
    int value;
    Node* next;
};

Node* push(Node* head, int value) {
    Node* node = new Node{value, head};
    return node;
}

Node* reverse(Node* head) {
    Node* prev = nullptr;
    while (head != nullptr) {
        Node* next = head->next;
        head->next = prev;
        prev = head;
        head = next;
    }
    return prev;
}

int main() {
    Node* head = nullptr;
    for (int i = 1; i <= 3; i++) {
        head = push(head, i);
    }
    head = reverse(head);
    std::cout << head->value << std::endl;
    return 0;
}
