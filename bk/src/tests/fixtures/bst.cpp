struct Tree {
    int key;
    Tree* left;
    Tree* right;
};

Tree* insert(Tree* root, int key) {
    if (root == nullptr) return new Tree{key, nullptr, nullptr};
    if (key < root->key) root->left = insert(root->left, key);
    else root->right = insert(root->right, key);
    return root;
}

int main() {
    Tree* root = nullptr;
    int keys[5] = {50, 30, 70, 20, 40};
    for (int i = 0; i < 5; i++) {
        root = insert(root, keys[i]);
    }
    return root->key == 50 ? 0 : 1;
}
