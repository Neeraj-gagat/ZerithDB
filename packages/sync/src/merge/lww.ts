import type { Document } from "zerithdb-core";

/**
 * Last-Writer-Wins merge strategy.
 * Compares Lamport timestamps, and falls back to lexicographical peer ID comparison.
 */
export function lwwMerge<T extends Record<string, any>>(
  local: Document<T>,
  remote: Document<T>,
  localPeerId: string,
  remotePeerId: string
): Document<T> {
  if (remote._lamport > local._lamport) {
    return remote;
  }
  
  if (remote._lamport === local._lamport) {
    // Tie-break with peer ID
    return remotePeerId > localPeerId ? remote : local;
  }
  
  return local;
}
