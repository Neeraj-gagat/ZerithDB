/** UUID v4 peer identifier — assigned on connection */
export type PeerId = string;

/** Room identifier — formatted as `appId:collectionName` */
export type RoomId = string;

/** Information about a connected peer in the mesh network. */
export interface PeerInfo {
  /** Unique identifier for this peer */
  peerId: PeerId;
  /** W3C DID Key identifier of the peer */
  did: string;
  /** Base58-encoded Ed25519 public key of the peer */
  publicKey: string;
  /** Optional human-readable peer alias */
  name?: string;

  /** Optional ENS identity */
  ens?: string;

  /** Connection established timestamp in Unix milliseconds */
  connectedAt: number;
  /** 
   * Total bytes received from this peer (their "Give").
   * Represents the peer's contribution to the local node's data sync.
   * @default 0
   * @remarks 
   * This is the numerator in the reputation calculation. A healthy peer
   * should have a reasonable amount of bytes downloaded relative to uploaded.
   */
  bytesDownloaded: number;

  /** 
   * Total bytes sent to this peer (our "Give" / their "Take").
   * Represents the bandwidth cost this peer incurs on the local node.
   * @default 0
   * @remarks 
   * This is the denominator in the reputation calculation. High upload
   * with zero download indicates a leeching peer.
   */
  bytesUploaded: number;

  /** 
   * Calculated reputation score based on the Give/Take ratio (bytesDownloaded / bytesUploaded).
   * @default 1.0
   * @remarks 
   * Used for network leech protection. 
   * - 1.0: Perfect or grace-period reputation.
   * - < 0.5: Peer is throttled (messages are delayed and queued).
   * - < 0.05: Peer is considered a severe leech. If they have consumed > 5MB, they are forcibly disconnected to protect bandwidth.
   */
  reputation: number;
}

/** A message exchanged between peers over the WebRTC data channel. */
export interface NetworkMessage {
  /** Discriminator for the message kind */
  type:
    | "sync-update"
    | "awareness"
    | "ephemeral"
    | "media-stream-metadata"
    | "media-stream-removed"
    | "ping"
    | "pong";
  /** Peer ID of the sender */
  from: PeerId;
  /** Binary (Yjs update) or string (signaling metadata) payload */
  payload: Uint8Array | string;
  /** Optional Ed25519 signature for authenticity verification */
  signature?: string;
}

export type MediaStreamKind = "camera" | "screen" | "audio" | "custom";

export interface MediaTrackMetadata {
  trackId: string;
  kind: "audio" | "video";
  label?: string;
  enabled: boolean;
  muted: boolean;
  readyState: MediaStreamTrackState;
}

export interface MediaStreamMetadata {
  streamId: string;
  peerId: PeerId;
  kind: MediaStreamKind;
  label?: string;
  audioMuted: boolean;
  videoMuted: boolean;
  tracks: MediaTrackMetadata[];
  updatedAt: number;
  [key: string]: unknown;
}

