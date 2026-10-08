struct Node {
    int v;
    Node* next;
};

int main() {
    Node* wild;
    char* text;
    int n = 3;
    bool wildIsNull = (wild == nullptr);
    bool textIsNull = (text == nullptr);
    return n - 3 + (wildIsNull && textIsNull ? 0 : 0);
}
