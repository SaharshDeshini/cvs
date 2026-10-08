// Decides how the heap is drawn: which blocks form a singly linked list, a doubly linked list, a binary tree or a
// general graph. The decision comes from the data: a struct is a list node when exactly one of its pointer fields points
// at its own type, and a tree node (or a doubly linked one) when two do. Field names only break ties.
import { normalizeType, walkValue } from "./valueKeys";

export const TREE_DEPTH_LIMIT = 6;
const FORWARD_NAME = /next|fwd|forward|succ|right|child/i;
const BACK_NAME = /prev|back|pred|parent/i;

const toNumber = (hex) => Number.parseInt(hex, 16);

function pointersIn(block) {
  const pointers = [];
  if (block.v) walkValue(block.v, "", (entry) => { if (entry.kind === "ptr" && !entry.fn) pointers.push(entry); });
  return pointers;
}

/** Per block: its type, which pointer fields point at its own type, and which other blocks it points to. */
function describeBlocks(heap) {
  const info = new Map();
  for (const [address, block] of Object.entries(heap)) {
    const value = block.v;
    const isStruct = value?.kind === "struct";
    const type = normalizeType(value?.type ?? block.ty);
    const selfFields = !isStruct ? [] : value.fields
      .filter((field) => field.v.kind === "ptr" && !field.v.ref && normalizeType(field.v.to) === type)
      .map((field) => ({ name: field.name, target: heap[field.v.block] ? field.v.block : null }));
    const targets = [...new Set(pointersIn(block).map((pointer) => pointer.block).filter((target) => target && heap[target]))];
    info.set(address, { address, block, type, isStruct, selfFields, targets });
  }
  return info;
}

/** Weakly connected groups of blocks, found with union-find over "points to". */
function connectedGroups(info) {
  const parent = new Map([...info.keys()].map((address) => [address, address]));
  const find = (address) => {
    let current = address;
    while (parent.get(current) !== current) {
      parent.set(current, parent.get(parent.get(current)));
      current = parent.get(current);
    }
    return current;
  };
  for (const node of info.values()) node.targets.forEach((target) => parent.set(find(node.address), find(target)));
  const groups = new Map();
  for (const address of info.keys()) {
    const root = find(address);
    groups.set(root, [...(groups.get(root) ?? []), address]);
  }
  return [...groups.values()];
}

/** Heap blocks in the order variables first point at them (outermost frame first). */
function pointedOrder(view, heap) {
  const order = [];
  for (const frame of view.frames) {
    for (const entry of Object.values(frame.vars)) {
      walkValue(entry, "", (inner) => {
        if (inner.kind === "ptr" && inner.block && heap[inner.block] && !order.includes(inner.block)) order.push(inner.block);
      });
    }
  }
  return order;
}

function follow(head, nextOf) {
  const chain = [head];
  const seen = new Set(chain);
  let cycle = false;
  for (let current = nextOf(head); current; current = nextOf(current)) {
    if (seen.has(current)) {
      cycle = true;
      break;
    }
    chain.push(current);
    seen.add(current);
  }
  return { chain, cycle };
}

function makeLinker(info, spineSet) {
  return (address, field) => {
    const target = info.get(address).selfFields.find((candidate) => candidate.name === field)?.target;
    return target && spineSet.has(target) ? target : null;
  };
}

/** Spine nodes nothing else on the spine points at (via `fields`) are possible heads; prefer the one a variable names. */
function pickHead(spine, linkOf, fields, hint) {
  const pointedAt = new Set(spine.flatMap((node) => fields.map((field) => linkOf(node.address, field))).filter(Boolean));
  const heads = spine.map((node) => node.address).filter((address) => !pointedAt.has(address));
  if (heads.includes(hint)) return hint;
  return heads[0] ?? (spine.some((node) => node.address === hint) ? hint : spine[0].address);
}

function shared(base, spine, attached, extra) {
  const placed = new Set(extra.placed);
  return { ...base, ...extra.fields, attached: attached.map((node) => node.address), rest: spine.map((node) => node.address).filter((a) => !placed.has(a)) };
}

function planList(base, spine, attached, link, linkOf, hint) {
  const head = pickHead(spine, linkOf, [link], hint);
  const { chain, cycle } = follow(head, (address) => linkOf(address, link));
  return shared(base, spine, attached, { placed: chain, fields: { kind: "list", head, chain, link, cycle } });
}

function planDoubly(base, spine, attached, [first, second], linkOf, hint) {
  const orientations = [[first, second], [second, first]].map(([forward, back]) => {
    const head = pickHead(spine, linkOf, [forward], hint);
    return { forward, back, head, ...follow(head, (address) => linkOf(address, forward)) };
  });
  const [best] = orientations.sort((a, b) => b.chain.length - a.chain.length || Number(FORWARD_NAME.test(b.forward)) - Number(FORWARD_NAME.test(a.forward)));
  const fields = { kind: "dlist", head: best.head, chain: best.chain, link: best.forward, back: best.back, cycle: best.cycle };
  return shared(base, spine, attached, { placed: best.chain, fields });
}

function isDoublyLinked(spine, linkOf, [first, second]) {
  const inverse = (forward, back) => spine.some((node) => {
    const target = linkOf(node.address, forward);
    return target !== null && linkOf(target, back) === node.address;
  });
  if (inverse(first, second) || inverse(second, first)) return true;
  const anyLink = spine.some((node) => linkOf(node.address, first) || linkOf(node.address, second));
  return !anyLink && (BACK_NAME.test(first) || BACK_NAME.test(second)); // no evidence in the data: fall back to the names
}

/** Everything under `address` not yet placed, counted and hidden behind one "N more" marker. */
function collapse(address, linkOf, links, placed, hidden) {
  const stack = [address];
  let count = 0;
  while (stack.length > 0) {
    const current = stack.pop();
    if (placed.has(current) || hidden.has(current)) continue;
    hidden.add(current);
    count += 1;
    links.forEach((link) => { const next = linkOf(current, link); if (next) stack.push(next); });
  }
  return { addr: address, collapsed: count };
}

function planTree(base, spine, attached, links, linkOf, hint) {
  const root = pickHead(spine, linkOf, links, hint);
  const placed = new Set();
  const hidden = new Set();
  const sharedNodes = new Set();
  const build = (address, depth) => {
    placed.add(address);
    const children = links.map((link) => {
      const child = linkOf(address, link);
      if (child === null) return null;
      if (placed.has(child) || hidden.has(child)) {
        sharedNodes.add(child);
        return null;
      }
      return depth + 1 >= TREE_DEPTH_LIMIT ? collapse(child, linkOf, links, placed, hidden) : build(child, depth + 1);
    });
    return { addr: address, children };
  };
  const tree = build(root, 0);
  const planned = shared(base, spine, attached, { placed: [...placed, ...hidden], fields: { kind: "tree", head: root, tree, links, shared: [...sharedNodes] } });
  return planned;
}

function planSingle(base, member) {
  return { ...base, kind: member.block.v?.kind === "array" ? "array" : "node", head: member.address, freed: !member.block.live };
}

function planGroup(addresses, info, hintOf) {
  const members = addresses.map((address) => info.get(address)).sort((a, b) => toNumber(a.address) - toNumber(b.address));
  const hint = hintOf(addresses) ?? members[0].address;
  const base = { id: hint, blocks: members.map((member) => member.address), orphan: members.every((member) => member.block.orphan === true) };
  const spineMember = members.find((member) => member.address === hint && member.selfFields.length > 0) ?? members.find((member) => member.selfFields.length > 0);
  if (!spineMember) return members.length === 1 ? planSingle(base, members[0]) : { ...base, kind: "graph", nodes: [hint, ...base.blocks.filter((a) => a !== hint)] };
  const spine = members.filter((member) => member.isStruct && member.type === spineMember.type);
  const attached = members.filter((member) => !spine.includes(member));
  const linkOf = makeLinker(info, new Set(spine.map((member) => member.address)));
  const fields = spineMember.selfFields.map((field) => field.name);
  const withType = { ...base, type: spineMember.type };
  if (fields.length === 1) return planList(withType, spine, attached, fields[0], linkOf, hint);
  if (fields.length === 2 && isDoublyLinked(spine, linkOf, fields)) return planDoubly(withType, spine, attached, fields, linkOf, hint);
  if (fields.length === 2) return planTree(withType, spine, attached, fields, linkOf, hint);
  return { ...withType, kind: "graph", nodes: [hint, ...base.blocks.filter((a) => a !== hint)] };
}

/**
 * @param {{ frames: object[], heap: object }} view
 * @returns {object[]} one entry per connected piece of heap, in the order variables point at them, then leaked pieces
 *   ordered by address. `kind` is list | dlist | tree | graph | array | node.
 */
export function planStructures(view) {
  const heap = view.heap;
  if (Object.keys(heap).length === 0) return [];
  const info = describeBlocks(heap);
  const order = pointedOrder(view, heap);
  const hintOf = (addresses) => order.find((address) => addresses.includes(address));
  const rank = (group) => {
    const first = Math.min(...group.map((address) => order.indexOf(address)).map((index) => (index < 0 ? Infinity : index)));
    return [first, Math.min(...group.map(toNumber))];
  };
  return connectedGroups(info)
    .sort((a, b) => { const [ra, aa] = rank(a); const [rb, ab] = rank(b); return ra === rb ? aa - ab : ra - rb; })
    .map((group) => planGroup(group, info, hintOf));
}
