struct Node {
    int value;
    Node* next;
};

int main() {
    Node* head = nullptr;
    for (int i = 5; i >= 1; i--) {
        head = new Node{i, head};
    }
    Node* slow = head;
    Node* fast = head;
    while (fast && fast->next) {
        slow = slow->next;
        fast = fast->next->next;
    }
    return slow->value;
}
