/** A CRDT update payload to be applied or transmitted to peers. */
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

/** Low-latency ephemeral state for a single peer (non-persistent). */
export interface EphemeralPeerState<TState extends Record<string, unknown> = Record<string, unknown>> {
  /** The peer ID of the peer this state belongs to */
  peerId: string;
  /** The state object itself */
  state: TState;
  /** Incrementing sequence number for conflict-free ordering */
  sequence: number;
  /** Timestamp of the last update in Unix milliseconds */
  updatedAt: number;
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

/**
 * Defines how sync updates are encoded and decoded for network transmission.
 * Swapping the protocol allows for hot-reloading different wire formats
 * (e.g. binary, JSON, encrypted) without restarting the sync engine.
 */
export interface SyncProtocol {
  readonly name: string;
  readonly version: string;
  encode(collectionName: string, update: Uint8Array): string | Uint8Array;
  decode(data: string | Uint8Array): { collectionName: string; update: Uint8Array } | null;
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
