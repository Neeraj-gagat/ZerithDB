// ─────────────────────────────────────────────────────────────────────────────
// zerithdb-core — Public API
// ─────────────────────────────────────────────────────────────────────────────
export { EventEmitter } from "./internal/event-emitter.js";
export { ZerithDBError, ErrorCode, SchemaValidationError } from "zerithdb-errors";
export { Logger } from "./internal/logger.js";
export { ZerithValidationError } from "./internal/validation-error.js";
export type {
  ZerithDBConfig,
  SyncConfig,
  AuthConfig,
  NetworkConfig,
  DebugConfig,
  ConflictResolverConfig,
} from "./types/config.js";

export type {
  Document,
  DocumentId,
  CollectionName,
  CollectionOptions,
  QueryFilter,
  QueryOptions,
  UpdateSpec,
  InsertResult,
  FindResult,
  CollectionOptions,
} from "./types/db.js";
export type { PeerId, PeerInfo, RoomId, NetworkMessage, MediaStreamMetadata, MediaStreamKind } from "./types/network.js";
export type { Identity, PublicKey, Signature } from "./types/auth.js";
export type {
  SyncUpdate,
  SyncState,
  AwarenessState,
  SyncPlugin,
  SyncProtocol,
  EphemeralPeerState,
  MediaStreamMetadata,
  ActiveSpeakerState,
  VideoParticipantState,
  SyncPlugin,
  MediaStreamKind,
} from "./types/sync.js";
export type {
  GraphNode,
  GraphEdge,
  GraphNodeId,
  EdgeLabel,
  GraphTraversalResult,
} from "./types/graph.js";
