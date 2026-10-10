import { createContext, memo, useContext } from "react";
import { heapKey } from "../lib/valueKeys";
import ValueView, { DiagramContext } from "./ValueView";

const LifetimeContext = createContext(undefined); // "leaked" | "pending" | undefined, set by the structure a node sits in

const TITLES = {
  list: "Linked list",
  dlist: "Doubly linked list",
  tree: "Binary tree",
  graph: "Linked structure",
  array: "Heap array",
  node: "Heap object",
};

const shortAddress = (address) => `@…${address.slice(-4)}`;
const count = (n, noun) => `${n} ${noun}${n === 1 ? "" : "s"}`;

function NodeBox({ address, heap }) {
  const block = heap[address];
  const lifetime = useContext(LifetimeContext);
  const { born } = useContext(DiagramContext);
  const classes = ["node-box", block.live ? "" : "is-freed", lifetime ? `is-${lifetime}` : block.orphan ? "is-orphan" : "", born.has(address) ? "is-new" : ""].filter(Boolean).join(" ");
  return (
    <div className={classes}>
      {block.v
        ? <ValueView entry={block.v} path={heapKey(address)} variant="node" />
        : <span className="node-freed" data-key={heapKey(address)}>{block.live ? "unreadable" : "freed"} · {block.size} bytes</span>}
      <span className="node-addr" title={address}>{shortAddress(address)}</span>
    </div>
  );
}

function Chain({ structure, heap }) {
  const arrows = structure.kind === "dlist" ? "⇄" : "→";
  return (
    <ol className="chain" aria-label={`${TITLES[structure.kind]}, ${count(structure.chain.length, "node")}`}>
      {structure.chain.map((address, index) => (
        <li key={address} className="chain-item">
          <NodeBox address={address} heap={heap} />
          {index < structure.chain.length - 1 && <span className="chain-gap" aria-hidden="true" data-glyph={arrows} />}
        </li>
      ))}
      {structure.cycle && <li className="chain-cycle" role="note">↺ loops back</li>}
    </ol>
  );
}

function TreeBranch({ node, heap }) {
  if (node.collapsed) return <div className="tree-collapsed" role="note">⋯ {count(node.collapsed, "more node")}</div>;
  const kids = node.children;
  const present = kids.filter(Boolean).length;
  return (
    <div className="tree-branch">
      <NodeBox address={node.addr} heap={heap} />
      {present > 0 && (
        <div className="tree-children">
          {kids.map((child, index) => (child
            ? <TreeBranch key={child.addr} node={child} heap={heap} />
            : present === 1 && <div key={`gap${index}`} className="tree-stub" aria-hidden="true" />))}
        </div>
      )}
    </div>
  );
}

function Extras({ addresses, heap }) {
  if (addresses.length === 0) return null;
  return (
    <div className="structure-extra">
      <span className="structure-extra-label">also reachable</span>
      <div className="node-row">{addresses.map((address) => <NodeBox key={address} address={address} heap={heap} />)}</div>
    </div>
  );
}

function Body({ structure, heap }) {
  const extras = [...(structure.rest ?? []), ...(structure.attached ?? [])];
  switch (structure.kind) {
    case "list":
    case "dlist":
      return <><Chain structure={structure} heap={heap} /><Extras addresses={extras} heap={heap} /></>;
    case "tree":
      return <><div className="tree"><TreeBranch node={structure.tree} heap={heap} /></div><Extras addresses={extras} heap={heap} /></>;
    case "graph":
      return <div className="node-row">{structure.nodes.map((address) => <NodeBox key={address} address={address} heap={heap} />)}</div>;
    default:
      return <NodeBox address={structure.head} heap={heap} />;
  }
}

function badges(structure) {
  const found = [];
  if (structure.lifetime === "leaked") found.push(["leaked", "allocated and never freed, and no variable points here any more"]);
  else if (structure.lifetime === "pending") found.push(["transit", "the address is still in a register, on its way into a variable"]);
  if (structure.freed) found.push(["freed", "this memory was released with delete / free"]);
  if (structure.cycle) found.push(["cycle", "following the links leads back to a node already visited"]);
  if (structure.shared?.length > 0) found.push(["shared", "some node is reachable from two parents"]);
  return found;
}

function Structure({ structure, heap }) {
  const size = structure.blocks.length;
  const lifetimeClass = structure.lifetime ? ` is-${structure.lifetime}` : "";
  return (
    <section className={`structure${lifetimeClass}`} aria-label={TITLES[structure.kind]}>
      <header className="structure-head">
        <span className="structure-title">{TITLES[structure.kind]}</span>
        <span className="structure-meta">{structure.type ? `${structure.type} · ` : ""}{count(size, "block")}</span>
        {badges(structure).map(([label, hint]) => <span key={label} className={`badge badge-${label}`} title={hint}>{label}</span>)}
      </header>
      <LifetimeContext.Provider value={structure.lifetime}>
        <div className="structure-body"><Body structure={structure} heap={heap} /></div>
      </LifetimeContext.Provider>
    </section>
  );
}

const bytesIn = (structures, heap) => structures.reduce((total, s) => total + s.blocks.reduce((sum, address) => sum + (heap[address]?.size ?? 0), 0), 0);

/** Memory nothing can reach any more and that was never freed: kept apart, so the live heap stays readable. */
function LeakTray({ structures, heap }) {
  const blocks = structures.reduce((total, structure) => total + structure.blocks.length, 0);
  return (
    <section className="leak-tray" aria-label="Leaked memory">
      <h3 className="leak-title">
        Leaked <span className="leak-meta">{count(blocks, "block")} · {count(bytesIn(structures, heap), "byte")} never freed</span>
      </h3>
      <div className="heap-structures">
        {structures.map((structure) => <Structure key={structure.id} structure={structure} heap={heap} />)}
      </div>
    </section>
  );
}

/** Everything allocated with new / malloc that some pointer still reaches (or reached before): the heap. */
function HeapView({ plan, heap }) {
  const leaked = plan.filter((structure) => structure.lifetime === "leaked");
  const reachable = plan.filter((structure) => structure.lifetime !== "leaked");
  return (
    <div className="heap" role="region" aria-label="Heap">
      <h2 className="panel-title">Heap <span className="panel-meta">{count(Object.keys(heap).length, "block")}</span></h2>
      <div className="heap-structures">
        {reachable.map((structure) => <Structure key={structure.id} structure={structure} heap={heap} />)}
      </div>
      {leaked.length > 0 && <LeakTray structures={leaked} heap={heap} />}
    </div>
  );
}

export default memo(HeapView);
