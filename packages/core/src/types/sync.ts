/** A CRDT update payload to be applied or transmitted to peers. */
export interface SyncUpdate {
  /** Name of the collection this update belongs to */
  collectionName: string;
  /** Binary-encoded Yjs state delta */
  update: Uint8Array;
  /** Origin identifier — `null` for locally-initiated updates */
  origin: string | null;
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

/** Ephemeral presence state shared via the Yjs Awareness protocol. */
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

// ─── Video-conference types ───────────────────────────────────────────────────
// Used by the VideoConferenceManager in zerithdb-sdk.

/** Metadata about a single MediaStreamTrack within a published stream. */
export interface MediaTrackInfo {
  /** The RTCDataChannel track kind: "audio" or "video" */
  kind: "audio" | "video";
  /** Whether this specific track is currently muted */
  muted: boolean;
  /** Whether the track is enabled (not forcibly disabled) */
  enabled?: boolean;
  /** Optional track label */
  label?: string;
  /** Optional track ID */
  trackId?: string;
  /** Track readyState if available */
  readyState?: string;
}

/**
 * Metadata attached to a published MediaStream.
 * Exchanged via the ephemeral state channel — never persisted.
 */
export interface MediaStreamMetadata {
  /** Opaque identifier matching `MediaStream.id` */
  streamId: string;
  /** Optional human-readable label (e.g. "camera", "screen") */
  label?: string;
  /** Whether the audio tracks in this stream are muted */
  audioMuted: boolean;
  /** Whether the video tracks in this stream are muted */
  videoMuted: boolean;
  /** Per-track details */
  tracks: MediaTrackInfo[];
  /** Arbitrary extra fields for application-specific metadata */
  [key: string]: unknown;
}

/**
 * Input type for publishing a stream — all fields are optional
 * since they default to the MediaStream's own properties.
 */
export type MediaStreamMetadataInput = Partial<Pick<MediaStreamMetadata, "label">> &
  Record<string, unknown>;

/** Identifies the current active speaker in a video call. */
export interface ActiveSpeakerState {
  /** Peer ID of the speaker */
  peerId: string;
  /** Unix millisecond timestamp of when this peer became active speaker */
  updatedAt: number;
  /** Optional audio level (0–1) at the time of detection */
  audioLevel?: number;
}

/**
 * Full presence state for a video call participant.
 * Broadcast via ephemeral state — never written to IndexedDB.
 */
export interface VideoParticipantState {
  /** Peer ID of this participant */
  peerId: string;
  /** Audio/video mute summary (aggregated across all streams) */
  muted: { audio: boolean; video: boolean };
  /** Published streams keyed by streamId */
  streams: Record<string, MediaStreamMetadata>;
  /** Unix millisecond timestamp of the last state change */
  updatedAt: number;
  /** Set when this participant is the active speaker */
  activeSpeaker?: ActiveSpeakerState;
}
