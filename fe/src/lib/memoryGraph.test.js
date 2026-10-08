import { describe, expect, it } from "vitest";
import { buildDiagram, buildResolver, changedKeys, collectEdges, planStructures, TREE_DEPTH_LIMIT } from "./memoryGraph";

// ── builders that mirror what the tracer really emits (see bk/runner/values.py) ──────────────────────────────────
const int = (value, extra = {}) => ({ kind: "int", type: "int", value: String(value), ...extra });
const ptr = (addr, to, block = null, extra = {}) => ({
  kind: "ptr", type: `${to} *`, value: addr, addr, to,
  state: addr === "0x0" ? "null" : block ? "heap" : null, ...(block ? { block } : {}), ...extra,
});
const nul = (to) => ptr("0x0", to);
const struct = (type, fields, extra = {}) => ({ kind: "struct", type, fields: fields.map(([name, v]) => ({ name, v })), ...extra });
const block = (value, size = 16, extra = {}) => ({ kind: "block", size, live: true, ty: value.type, v: value, ...extra });
const listNode = (value, next) => block(struct("Node", [["value", int(value)], ["next", next ? ptr(next, "Node", next) : nul("Node")]]));
const dNode = (value, prev, next) => block(struct("DNode", [
  ["value", int(value)], ["prev", prev ? ptr(prev, "DNode", prev) : nul("DNode")], ["next", next ? ptr(next, "DNode", next) : nul("DNode")],
]), 24);
const treeNode = (key, left, right) => block(struct("Tree", [
  ["key", int(key)], ["left", left ? ptr(left, "Tree", left) : nul("Tree")], ["right", right ? ptr(right, "Tree", right) : nul("Tree")],
]), 24);
const view = (vars, heap = {}) => ({ frames: [{ fn: "main", line: 1, vars }], heap });
const names = (plan) => plan.map((s) => s.kind);

describe("buildResolver", () => {
  it("resolves a pointer to a heap block start to that block", () => {
    const v = view({ head: ptr("0x1000", "Node", "0x1000") }, { "0x1000": listNode(1, null) });
    expect(buildResolver(v)("0x1000", "Node")).toBe("h0x1000");
  });

  it("resolves a pointer to a stack variable that carries its address", () => {
    const v = view({ x: int(5, { at: "0x7000", size: 4 }), p: ptr("0x7000", "int") });
    expect(buildResolver(v)("0x7000", "int")).toBe("s0/x");
  });

  it("resolves a pointer into the middle of a stack array to that element", () => {
    const arr = { kind: "array", type: "int [4]", len: 4, elem: "int", elemKind: "int", elemSize: 4, items: ["10", "20", "30", "40"], at: "0x7000", size: 16 };
    expect(buildResolver(view({ arr }))("0x7008", "int")).toBe("s0/arr[2]");
  });

  it("resolves into a heap array block cell by cell", () => {
    const array = { kind: "array", type: "int [3]", len: 3, elem: "int", elemKind: "int", elemSize: 4, items: ["1", "2", "3"] };
    const v = view({}, { "0x2000": block(array, 12) });
    const resolve = buildResolver(v);
    expect(resolve("0x2000", "int")).toBe("h0x2000[0]");
    expect(resolve("0x2008", "int")).toBe("h0x2000[2]");
  });

  it("prefers the entry whose type is the pointer's target type when two start at the same address", () => {
    const first = int(1, { at: "0x1000", size: 4 }); // a targeted first field shares the block's address
    const node = block(struct("Node", [["value", first], ["next", nul("Node")]]));
    const resolve = buildResolver(view({}, { "0x1000": node }));
    expect(resolve("0x1000", "Node")).toBe("h0x1000");
    expect(resolve("0x1000", "int")).toBe("h0x1000.value");
  });

  it("returns null for an address nothing is known at", () => {
    expect(buildResolver(view({ x: int(1, { at: "0x7000", size: 4 }) }))("0x9999", "int")).toBeNull();
  });

  it("does not match one byte past the end of an entry", () => {
    expect(buildResolver(view({ x: int(1, { at: "0x7000", size: 4 }) }))("0x7004", "int")).toBeNull();
  });
});

describe("collectEdges", () => {
  it("draws one edge per non-null pointer and none for null or function pointers", () => {
    const heap = { "0x1000": listNode(1, "0x1010"), "0x1010": listNode(2, null) };
    const v = view({ head: ptr("0x1000", "Node", "0x1000"), cb: ptr("0x4000", "void ()", null, { fn: true }), none: nul("Node") }, heap);
    const edges = collectEdges(v, buildResolver(v));
    expect(edges.map((e) => [e.from, e.to])).toEqual([["s0/head", "h0x1000"], ["h0x1000.next", "h0x1010"]]);
  });

  it("marks a pointer to a freed block as dangling and still points at the (dead) block", () => {
    const v = view({ gone: ptr("0x5000", "int", "0x5000", { state: "freed" }) }, { "0x5000": { kind: "block", size: 4, live: false, ty: "int" } });
    const [edge] = collectEdges(v, buildResolver(v));
    expect(edge).toMatchObject({ from: "s0/gone", to: "h0x5000", dangling: true });
  });

  it("a pointer that resolves nowhere produces no edge", () => {
    const v = view({ p: ptr("0xdead", "int") });
    expect(collectEdges(v, buildResolver(v))).toEqual([]);
  });

  it("finds pointers nested in arrays of structs", () => {
    const cells = [struct("Pair", [["to", ptr("0x1000", "Node", "0x1000")]]), struct("Pair", [["to", nul("Node")]])];
    const arr = { kind: "array", type: "Pair [2]", len: 2, elem: "Pair", elemSize: 8, items: cells };
    const v = view({ arr }, { "0x1000": listNode(1, null) });
    expect(collectEdges(v, buildResolver(v)).map((e) => e.from)).toEqual(["s0/arr[0].to"]);
  });
});

describe("planStructures: linked lists", () => {
  const abc = { "0x1000": listNode(1, "0x1010"), "0x1010": listNode(2, "0x1020"), "0x1020": listNode(3, null) };

  it("lays a singly linked list out head to tail", () => {
    const plan = planStructures(view({ head: ptr("0x1000", "Node", "0x1000") }, abc));
    expect(names(plan)).toEqual(["list"]);
    expect(plan[0]).toMatchObject({ head: "0x1000", chain: ["0x1000", "0x1010", "0x1020"], link: "next", cycle: false });
  });

  it("finds the real head even when the only variable points into the middle", () => {
    const plan = planStructures(view({ mid: ptr("0x1010", "Node", "0x1010") }, abc));
    expect(plan[0].chain).toEqual(["0x1000", "0x1010", "0x1020"]);
  });

  it("flags a cycle and stops the chain instead of looping", () => {
    const heap = { "0x1000": listNode(1, "0x1010"), "0x1010": listNode(2, "0x1000") };
    const plan = planStructures(view({ head: ptr("0x1000", "Node", "0x1000") }, heap));
    expect(plan[0]).toMatchObject({ kind: "list", chain: ["0x1000", "0x1010"], cycle: true });
  });

  it("recognises a doubly linked list by its inverse pointers", () => {
    const heap = { "0x1000": dNode(1, null, "0x1018"), "0x1018": dNode(2, "0x1000", "0x1030"), "0x1030": dNode(3, "0x1018", null) };
    const plan = planStructures(view({ head: ptr("0x1000", "DNode", "0x1000") }, heap));
    expect(plan[0]).toMatchObject({ kind: "dlist", link: "next", back: "prev", chain: ["0x1000", "0x1018", "0x1030"] });
  });

  it("keeps two unrelated lists as two structures, in variable order", () => {
    const heap = { ...abc, "0x3000": listNode(9, null) };
    const plan = planStructures(view({ b: ptr("0x3000", "Node", "0x3000"), a: ptr("0x1000", "Node", "0x1000") }, heap));
    expect(plan.map((s) => s.head)).toEqual(["0x3000", "0x1000"]);
  });

  it("a block nothing points to any more is reported as leaked", () => {
    const heap = { "0x1000": { ...listNode(1, null), orphan: true } };
    const plan = planStructures(view({}, heap));
    expect(plan[0]).toMatchObject({ kind: "list", orphan: true, chain: ["0x1000"] }); // a list of one is still a list
  });
});

describe("planStructures: trees", () => {
  const bst = {
    "0x1000": treeNode(50, "0x1018", "0x1030"),
    "0x1018": treeNode(30, "0x1048", null),
    "0x1030": treeNode(70, null, null),
    "0x1048": treeNode(20, null, null),
  };
  const rootVar = { root: ptr("0x1000", "Tree", "0x1000") };

  it("plans a binary tree with left/right slots kept in place", () => {
    const [tree] = planStructures(view(rootVar, bst));
    expect(tree.kind).toBe("tree");
    expect(tree.links).toEqual(["left", "right"]);
    expect(tree.tree.addr).toBe("0x1000");
    expect(tree.tree.children[0].addr).toBe("0x1018");
    expect(tree.tree.children[0].children[0].addr).toBe("0x1048");
    expect(tree.tree.children[0].children[1]).toBeNull();
    expect(tree.tree.children[1].children).toEqual([null, null]);
  });

  it("shows a node reachable from two parents once, under the first", () => {
    const heap = { "0x1000": treeNode(1, "0x1018", "0x1030"), "0x1018": treeNode(2, "0x1048", null), "0x1030": treeNode(3, "0x1048", null), "0x1048": treeNode(4, null, null) };
    const [tree] = planStructures(view(rootVar, heap));
    expect(tree.tree.children[0].children[0].addr).toBe("0x1048");
    expect(tree.tree.children[1].children[0]).toBeNull();
    expect(tree.shared).toEqual(["0x1048"]);
  });

  it("collapses a deep skewed tree and says how many nodes are hidden", () => {
    const heap = {};
    const total = 30;
    for (let i = 0; i < total; i += 1) {
      const addr = `0x${(0x1000 + i * 0x20).toString(16)}`;
      const next = i + 1 < total ? `0x${(0x1000 + (i + 1) * 0x20).toString(16)}` : null;
      heap[addr] = treeNode(i, null, next);
    }
    const [tree] = planStructures(view(rootVar, heap));
    let depth = 0;
    let cursor = tree.tree;
    while (cursor.children?.[1]) { cursor = cursor.children[1]; depth += 1; }
    expect(depth).toBeLessThanOrEqual(TREE_DEPTH_LIMIT);
    expect(cursor.collapsed).toBe(total - TREE_DEPTH_LIMIT);
  });

  it("treats a node with three self pointers as a general graph", () => {
    const wide = (key, ...kids) => block(struct("Wide", [["k", int(key)], ...kids.map((kid, i) => [`c${i}`, kid ? ptr(kid, "Wide", kid) : nul("Wide")])]), 32);
    const heap = { "0x1000": wide(1, "0x1020", "0x1040", null), "0x1020": wide(2, null, null, null), "0x1040": wide(3, null, null, null) };
    expect(names(planStructures(view({ g: ptr("0x1000", "Wide", "0x1000") }, heap)))).toEqual(["graph"]);
  });
});

describe("planStructures: other blocks", () => {
  it("a heap array is its own structure", () => {
    const array = { kind: "array", type: "int [3]", len: 3, elem: "int", elemKind: "int", elemSize: 4, items: ["1", "2", "3"] };
    const plan = planStructures(view({ a: ptr("0x2000", "int", "0x2000") }, { "0x2000": block(array, 12) }));
    expect(names(plan)).toEqual(["array"]);
  });

  it("a single boxed value is a node", () => {
    const plan = planStructures(view({ h: ptr("0x2000", "int", "0x2000") }, { "0x2000": block(int(7), 4) }));
    expect(plan[0]).toMatchObject({ kind: "node", head: "0x2000" });
  });

  it("a freed block is still drawn, marked", () => {
    const plan = planStructures(view({ gone: ptr("0x5000", "int", "0x5000", { state: "freed" }) }, { "0x5000": { kind: "block", size: 4, live: false, ty: "int" } }));
    expect(plan[0]).toMatchObject({ kind: "node", freed: true });
  });

  it("plans nothing when there is no heap", () => {
    expect(planStructures(view({ x: int(1) }))).toEqual([]);
  });
});

describe("buildDiagram", () => {
  it("bundles arrows, shapes and changes for one step", () => {
    const heap = { "0x1000": listNode(1, "0x1010"), "0x1010": listNode(2, null) };
    const now = view({ head: ptr("0x1000", "Node", "0x1000") }, heap);
    const model = buildDiagram(now, null);
    expect(model.edges.map((edge) => [edge.from, edge.to])).toEqual([["s0/head", "h0x1000"], ["h0x1000.next", "h0x1010"]]);
    expect(model.plan.map((structure) => structure.kind)).toEqual(["list"]);
    expect(model.changed.has("h0x1010.value")).toBe(true);
  });

  it("a call (whole new frame) flags every variable of that frame", () => {
    const deeper = { ...view({ x: int(1) }), changes: ["f0"] };
    expect(buildDiagram(deeper, deeper).changed.has("s0/x")).toBe(true);
  });

  it("reports only what moved between two steps", () => {
    const before = view({ head: ptr("0x1000", "Node", "0x1000") }, { "0x1000": listNode(1, null) });
    const after = view({ head: ptr("0x1000", "Node", "0x1000") }, { "0x1000": listNode(5, null) });
    expect([...buildDiagram(after, before).changed]).toEqual(["h0x1000.value"]);
  });
});

describe("changedKeys", () => {
  it("lists array cells whose text changed, and only those", () => {
    const arr = (items) => ({ kind: "array", type: "int [3]", len: 3, elem: "int", elemKind: "int", elemSize: 4, items });
    const changed = changedKeys(view({ a: arr(["1", "2", "3"]) }), view({ a: arr(["1", "9", "3"]) }));
    expect([...changed]).toEqual(["s0/a[1]"]);
  });

  it("marks pointer fields that were re-pointed and a brand-new heap block", () => {
    const before = view({}, { "0x1000": listNode(1, null) });
    const after = view({}, { "0x1000": listNode(1, "0x1010"), "0x1010": listNode(2, null) });
    const changed = changedKeys(before, after);
    expect(changed.has("h0x1000.next")).toBe(true);
    expect(changed.has("h0x1000.value")).toBe(false);
    expect(changed.has("h0x1010.value")).toBe(true);
  });

  it("with no earlier view everything present counts as changed", () => {
    expect(changedKeys(null, view({ x: int(1) })).has("s0/x")).toBe(true);
  });
});
