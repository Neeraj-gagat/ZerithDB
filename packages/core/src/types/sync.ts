/** Conflict resolution merge policy option */
export type MergePolicy = "lww" | "crdt" | ((local: any, remote: any) => any);

import type { MediaStreamMetadata } from "./network.js";

/** A sync update payload containing document data and peer origin. */
export interface SyncUpdate {
  /** Name of the collection this update belongs to */
  collectionName: string;
  /** The document payload to sync */
  doc: any;
  /** The peer ID of the sender */
  peerId: string;
}

/** Snapshot of the current synchronization status. */
export interface SyncState {
  /** Whether the local state is fully synced with all connected peers */
  synced: boolean;
  /** Number of outbound updates waiting to be sent */
  pendingUpdates: number;
  /** Number of currently connected peers */
  connectedPeers: number;
}

/** Represents a conflict that was resolved deterministically. */
export interface ConflictResolution {
  /** Name of the collection where the conflict occurred */
  collectionName: string;
  /** Document ID */
  docId: string;
  /** Local version of the document before resolution */
  localDoc: any;
  /** Remote version of the document received */
  remoteDoc: any;
  /** Merged/resolved document version */
  resolvedDoc: any;
  /** Strategy used for resolution ("lww", "crdt", "custom", etc.) */
  strategy: string;
  /** Timestamp when conflict was resolved */
  timestamp: number;
}

/** Database sync log entry for debugging and conflict replays. */
export interface SyncLog extends ConflictResolution {
  /** Auto-incremented local ID */
  _id?: string;
}

/** Ephemeral presence state shared via the P2P Presence / Awareness protocol. */
export interface AwarenessState {
  /** Peer ID of the user */
  peerId: string;
  /** W3C DID Key identifier of the user */
  did: string;
  /** Optional cursor position for collaborative editing */
  cursor?: { line: number; column: number };
  /** Arbitrary additional presence metadata */
  [key: string]: unknown;
}

/**
 * A point-in-time snapshot of a single peer's ephemeral state.
 * Shared over the WebRTC mesh without being persisted to IndexedDB.
 *
 * @template TState - The shape of the application-defined ephemeral fields.
 */
export interface EphemeralPeerState<
  TState extends Record<string, unknown> = Record<string, unknown>,
> {
  /** Peer ID of the owner */
  peerId: string;
  /** The peer's current ephemeral state payload */
  state: TState;
  /** Monotonically increasing counter — used to discard out-of-order messages */
  sequence: number;
  /** Unix millisecond timestamp of the most recent update */
  updatedAt: number;
}

/**
 * Tuning options for the {@link EphemeralStateManager}.
 * All fields are optional — sensible defaults are used when omitted.
 */
export interface EphemeralConfig {
  /**
   * Minimum milliseconds between outbound broadcast messages.
   * Set to `0` (default) to broadcast immediately on every update.
   * @default 0
   */
  throttleMs?: number;

  /**
   * Milliseconds of silence before a peer's state is considered stale
   * and pruned from the local store.
   * @default 30_000
   */
  staleAfterMs?: number;

  /**
   * How often (in ms) the stale-peer cleanup sweep runs.
   * @default 5_000
   */
  cleanupIntervalMs?: number;
}

export interface SyncPlugin {
  id: string;
  version: number;
  /**
   * Optional semantic conflict resolver for text-heavy collections.
   */
  conflictResolver?: ConflictResolver;
  /**
   * Hook to transform/resolve conflicts before applying a remote update
   */
  onBeforeApplyUpdate?: (
    collectionName: string,
    update: Uint8Array,
    fromPeer: string
  ) => Uint8Array | null | Promise<Uint8Array | null>;
  /**
   * Hook to transform a local update before broadcasting
   */
  onBeforeSendUpdate?: (
    collectionName: string,
    update: Uint8Array
  ) => Uint8Array | null | Promise<Uint8Array | null>;
}

/** Ephemeral Presence state for a peer. */
export interface EphemeralPeerState<
  TState extends Record<string, unknown> = Record<string, unknown>,
> {
  peerId: string;
  state: TState;
  sequence: number;
  updatedAt: number;
}

export interface MediaStreamTrackMetadata {
  trackId: string;
  kind: "audio" | "video";
  label: string;
  enabled: boolean;
  muted: boolean;
  readyState: string;
}

export interface MediaStreamMetadata {
  streamId: string;
  peerId: string;
  kind: "camera" | "screen" | "custom";
  audioMuted: boolean;
  videoMuted: boolean;
  tracks: MediaStreamTrackMetadata[];
  updatedAt: number;
}

export interface ActiveSpeakerState {
  peerId: string;
  audioLevel?: number;
  updatedAt: number;
}

export interface VideoParticipantState {
  peerId: string;
  muted: {
    audio: boolean;
    video: boolean;
  };
  streams: Record<string, MediaStreamMetadata>;
  activeSpeaker?: ActiveSpeakerState;
  updatedAt: number;
}
