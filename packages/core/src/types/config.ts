import type { EphemeralConfig } from "./sync.js";

export interface SyncConfig {
  /**
   * WebSocket URL of the ZerithDB signaling server.
   * @default "wss://signal.zerithdb.dev"
   */
  signalingUrl?: string;

  /**
   * Multiple signaling server URLs for automatic failover.
   * Tried in order — falls back to the next on failure.
   * Takes priority over signalingUrl if both are set.
   */
  signalingUrls?: string[];

  /**
   * STUN/TURN server URLs for WebRTC ICE negotiation.
   * @default Uses Google's public STUN servers
   */
  iceServers?: RTCIceServer[];

  /**
   * Maximum number of peers to connect to per room.
   * Full-mesh topology — costs O(n²) connections.
   * @default 10
   */
  maxPeers?: number;
/**
 * Delay between sync broadcasts in ms.
 * Helps batch rapid Yjs updates together.
 * @default 100
 */
updateThrottleMs?: number;

/**
 * Signaling transport preference.
 * - `"auto"`      — Try WebSocket first, fall back to HTTP long-polling (default)
 * - `"websocket"` — WebSocket only (original behavior)
 * - `"polling"`   — HTTP long-polling only (for strict firewall environments)
 * @default "auto"
 */
transport?: "auto" | "websocket" | "polling";

  /**
   * Configuration for the {@link EphemeralStateManager}.
   * Controls broadcast throttling and stale-peer cleanup timing.
   */
  transport?: "auto" | "websocket" | "polling";

  /**
   * Configuration options for the ephemeral (non-persistent) state sync channel.
   */
  ephemeral?: {
    /** Interval in ms for cleaning up stale peer states. @default 5000 */
    cleanupIntervalMs?: number;
    /** Time in ms before a peer's state is considered stale. @default 30000 */
    staleAfterMs?: number;
    /** Minimum ms between outgoing broadcasts (throttle). @default 0 */
    throttleMs?: number;
  };
}

export interface AuthConfig {
  /**
   * Storage key prefix for the identity keypair in localStorage.
   * @default "__zerithdb_identity"
   */
  storageKey?: string;

  /**
   * URL of the shared wallet iframe for cross-origin identity management.
   * Required when using WalletProxy instead of local AuthManager.
   */
  walletUrl?: string;
}

export interface DebugConfig {
  /**
   * Enable the DevTools memory collector — samples IndexedDB and WebRTC
   * buffer usage and broadcasts snapshots for the ZerithDB DevTools extension.
   * @default false
   */
  devtools?: boolean;
}

export interface NetworkConfig {
  /**
   * Human-readable alias for this peer in the mesh.
   */
  name?: string;

  /**
   * Optional ENS identity to attach to this peer.
   */
  ens?: string;

  /**
   * Whether to automatically reconnect when a peer disconnects.
   * @default true
   */
  autoReconnect?: boolean;

  /**
   * Initial backoff delay in ms for reconnection.
   * @default 1000
   */
  reconnectDelay?: number;
}

export interface ZerithDBConfig {
  /**
   * Unique identifier for this application's data namespace.
   * This scopes all IndexedDB storage and P2P rooms.
   * Must be stable — changing it is equivalent to starting fresh.
   */
  appId: string;

  sync?: SyncConfig;
  auth?: AuthConfig;
  network?: NetworkConfig;
  debug?: DebugConfig;
  conflictResolver?: ConflictResolverConfig;

  /**
   * Log level for internal ZerithDB diagnostics.
   * @default "warn"
   */
  logLevel?: "debug" | "info" | "warn" | "error" | "silent";
}

