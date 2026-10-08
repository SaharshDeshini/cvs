struct Node {
    int value;
    Node* next;
};

int main() {
    Node* head = nullptr;
    for (int i = 0; i < 200; i++) {
        head = new Node{i, head};
    }
    int total = 0;
    for (Node* cur = head; cur != nullptr; cur = cur->next) {
        total += cur->value;
    }
    return total > 0 ? 0 : 1;
}
