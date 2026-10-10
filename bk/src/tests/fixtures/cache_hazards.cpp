#include <list>

// Both heap structs hold a value whose printed form is read from memory OUTSIDE the struct: an iterator (the printer shows
// the element it points at) and a wide-string pointer (GDB prints the string). The structs' own bytes never change, only
// what they point at does, so a cache keyed on the struct's bytes alone would keep showing the old text.
struct Cursor {
    std::list<int>::iterator it;
    int tag;
};

struct Wide {
    const wchar_t* text;
    int tag;
};

int main() {
    std::list<int> values = {1, 2, 3};
    Cursor* cursor = new Cursor{values.begin(), 0};
    wchar_t buffer[4] = {L'a', L'b', L'c', 0};
    Wide* wide = new Wide{buffer, 0};
    for (int i = 0; i < 3; i++) {
        *cursor->it = 10 + i;
        buffer[0] = L'x' + i;
        cursor->tag = 0;
    }
    delete cursor;
    delete wide;
    return 0;
}
