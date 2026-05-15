export interface SyncUpdate {
  collectionName: string;
  update: Uint8Array;
  origin: string | null;
}

export interface SyncState {
  synced: boolean;
  pendingUpdates: number;
  connectedPeers: number;
}

export interface AwarenessState {
  peerId: string;
  did: string;
  cursor?: { line: number; column: number };
  [key: string]: unknown;
}

export interface SyncPlugin {
  id: string;
  version: number;
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
