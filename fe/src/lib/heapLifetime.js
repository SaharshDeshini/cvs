// The tracer marks a heap block `orphan` when no pointer it could read reaches the block at this step. Most of the time
// that is a real leak, but for a step or two after `new` (or after a function returns its pointer) the address is only
// in a CPU register on its way to a variable. The whole trace is already in memory, so look ahead: an orphan that is
// reachable again later is "pending"; one that never is again (still allocated, or freed first) is "leaked".

/**
 * @param {{ heap: Record<string, { live: boolean, orphan?: boolean }> }[]} views one reconstructed view per step
 * @param {{ complete?: boolean }} [options] `complete: false` = the run was cut short (crash, timeout, step cap): the program
 *   never got to store what it still held, so an orphan at the last step is not proven to be a leak.
 * @returns {Map<string, "pending" | "leaked">[]} per step, per orphan block address. Reachable blocks are not listed.
 */
export function classifyOrphans(views, { complete = true } = {}) {
  const result = new Array(views.length);
  const lastHeap = views.at(-1)?.heap ?? {};
  const reachableLater = new Set(complete ? [] : Object.keys(lastHeap).filter((address) => lastHeap[address].live)); // addresses whose current allocation is reachable at some later step
  for (let index = views.length - 1; index >= 0; index -= 1) {
    const { heap } = views[index];
    const verdicts = new Map();
    for (const [address, block] of Object.entries(heap)) {
      if (!block.live) reachableLater.delete(address); // freed: a later block at this address is a different allocation
      else if (!block.orphan) reachableLater.add(address);
      else verdicts.set(address, reachableLater.has(address) ? "pending" : "leaked");
    }
    for (const address of reachableLater) {
      if (!(address in heap)) reachableLater.delete(address); // gone from the table: same reason
    }
    result[index] = verdicts;
  }
  return result;
}
