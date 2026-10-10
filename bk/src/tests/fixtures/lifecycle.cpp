struct Node {
    int value;
    Node* next;
};

Node* build(int n) {
    Node* head = nullptr;
    Node* tail = nullptr;
    for (int i = 1; i <= n; i++) {
        Node* node = new Node{i, nullptr};
        if (tail) tail->next = node;
        else head = node;
        tail = node;
    }
    return head;
}

void leakyHelper() {
    Node* temp = new Node{99, nullptr};
    temp->next = new Node{98, nullptr};
}

void destroy(Node* head) {
    while (head) {
        Node* next = head->next;
        delete head;
        head = next;
    }
}

int main() {
    Node* list = build(3);
    leakyHelper();
    destroy(list);
    return 0;
}
