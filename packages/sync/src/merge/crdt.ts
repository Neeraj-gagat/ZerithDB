import type { Document } from "zerithdb-core";
import { lwwMerge } from "./lww.js";

/**
 * CRDT-inspired Object Merge strategy.
 *
 * Merges non-overlapping top-level keys from both documents.
 * For conflicting keys, falls back to document-level LWW using Lamport timestamps
 * with peer ID as a deterministic tiebreaker.
 *
 * ⚠️ KNOWN LIMITATION — Top-level keys only:
 * This merge operates at the top-level property level. Nested objects are treated
 * as opaque values, not recursively merged. For example, if peer A updates
 * `settings.theme` and peer B updates `settings.fontSize`, one peer's entire
 * `settings` object will be chosen as the winner and the other's changes will
 * be discarded silently.
 *
 * For documents with deeply nested or shared sub-object structures, prefer
 * the `lww` merge policy instead, or split nested objects into separate
 * top-level collections.
 *
 * This is a known MVP limitation and may be improved in a future release
 * with per-field vector clocks.
 */
export function crdtMerge<T extends Record<string, any>>(
  local: Document<T>,
  remote: Document<T>,
  localPeerId: string,
  remotePeerId: string
): Document<T> {
  // If remote is strictly newer according to vector clock, just take remote
  // (This logic should be in SyncEngine, but we'll implement the "merge" part here)
  
  const mergedContent: any = { ...local };
  
  for (const [key, remoteValue] of Object.entries(remote)) {
    if (key.startsWith("_")) continue; // Skip metadata
    
    const localValue = (local as any)[key];
    
    if (localValue === undefined) {
      mergedContent[key] = remoteValue;
    } else if (JSON.stringify(localValue) !== JSON.stringify(remoteValue)) {
      // Conflict on this key!
      // In a real CRDT we'd have per-field clocks. 
      // Here we fall back to document-level LWW for the conflicting value.
      if (remote._lamport > local._lamport || (remote._lamport === local._lamport && remotePeerId > localPeerId)) {
        mergedContent[key] = remoteValue;
      }
    }
  }
  
  // Merge vector clocks
  const mergedVClock = { ...local._vclock };
  for (const [peer, count] of Object.entries(remote._vclock)) {
    mergedVClock[peer] = Math.max(mergedVClock[peer] || 0, count);
  }
  
  return {
    ...mergedContent,
    _id: local._id,
    _createdAt: local._createdAt,
    _updatedAt: Math.max(local._updatedAt, remote._updatedAt),
    _vclock: mergedVClock,
    _lamport: Math.max(local._lamport, remote._lamport),
    _deleted: local._deleted || remote._deleted, // Tombstone wins
  } as Document<T>;
}
