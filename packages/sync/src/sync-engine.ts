import * as Y from "yjs";
import { IndexeddbPersistence } from "y-indexeddb";
import type { ZerithDBConfig, SyncState, SyncPlugin } from "zerithdb-core";
import { EventEmitter } from "zerithdb-core";
import type { DbClient } from "zerithdb-db";
import type { NetworkManager } from "zerithdb-network";

type SyncEvents = {
  "state:change": SyncState;
  "update:local": { collectionName: string; update: Uint8Array };
  "update:remote": { collectionName: string; update: Uint8Array; fromPeer: string };
};

/**
 * CRDT sync engine — manages one Yjs Y.Doc per collection.
 * Local writes update the Y.Doc, which generates binary deltas sent to peers.
 * Incoming peer deltas are applied to the Y.Doc, which reactively updates the DB.
 */
export class SyncEngine extends EventEmitter<SyncEvents> {
  private readonly docs = new Map<string, Y.Doc>();
  private readonly persistences = new Map<string, IndexeddbPersistence>();
  private _enabled = false;
  private _state: SyncState = { synced: false, pendingUpdates: 0, connectedPeers: 0 };
  private plugins = new Map<string, SyncPlugin>();
  private activePluginVersion = 1;


  constructor(
    private readonly config: ZerithDBConfig,
    private readonly db: DbClient,
    private readonly network: NetworkManager
  ) {
    super();
    this.onPeerUpdate = this.onPeerUpdate.bind(this);
  }

  /**
   * Enable P2P sync. After calling this, local changes are broadcast
   * to connected peers and remote updates are applied locally.
   */
  enable(): void {
    if (this._enabled) return;
    this._enabled = true;
    this.network.on("message", this.onPeerUpdate);
    this.updateState({ synced: true });
  }

  /** Disable sync without disconnecting from peers */
  disable(): void {
    this._enabled = false;
    this.network.off("message", this.onPeerUpdate);
    this.updateState({ synced: false });
  }

  /**
   * Register a synchronization plugin directly.
   */
  registerPlugin(plugin: SyncPlugin): void {
    this.plugins.set(plugin.id, plugin);
    if (plugin.version > this.activePluginVersion) {
      this.activePluginVersion = plugin.version;
    }
  }

  /**
   * Dynamically load and register a plugin from a URL.
   */
  async loadPlugin(pluginUrl: string): Promise<void> {
    try {
      const module = await import(pluginUrl);
      const plugin = module.default as SyncPlugin;
      this.registerPlugin(plugin);
    } catch (err) {
      console.error(`Failed to load plugin from ${pluginUrl}`, err);
    }
  }

  /**
   * Propose a protocol upgrade to all connected peers.
   */
  proposeUpgrade(pluginUrl: string, version: number): void {
    this.network.broadcast({
      type: "sync-upgrade-offer",
      payload: JSON.stringify({ pluginUrl, version }),
    });
  }


  /** Current sync state snapshot */
  get state(): Readonly<SyncState> {
    return this._state;
  }

  /**
   * Get or create the Yjs document for a collection.
   * Documents are persisted to IndexedDB via y-indexeddb.
   */
  getDoc(collectionName: string): Y.Doc {
    if (this.docs.has(collectionName)) {
      // biome-ignore lint: map guarantees defined
      return this.docs.get(collectionName)!;
    }

    const doc = new Y.Doc({ guid: `${this.config.appId}:${collectionName}` });

    // Persist to IndexedDB
    const persistence = new IndexeddbPersistence(
      `zerithdb_sync_${this.config.appId}_${collectionName}`,
      doc
    );
    this.persistences.set(collectionName, persistence);

    // Broadcast local updates to peers
    doc.on("update", async (update: Uint8Array, origin: unknown) => {
      if (origin === "remote") return; // Don't echo back remote updates
      if (!this._enabled) return;

      let finalUpdate: Uint8Array | null = update;
      for (const plugin of this.plugins.values()) {
        if (plugin.onBeforeSendUpdate) {
          finalUpdate = await plugin.onBeforeSendUpdate(collectionName, finalUpdate);
          if (!finalUpdate) return; // Drop update
        }
      }

      this.emit("update:local", { collectionName, update: finalUpdate });
      this.network.broadcast({
        type: "sync-update",
        payload: this.encodeMessage(collectionName, finalUpdate),
      });
    });

    this.docs.set(collectionName, doc);
    return doc;
  }

  /**
   * Apply a remote CRDT update to the local document.
   * Called by the network layer when a peer sends an update.
   */
  async applyRemoteUpdate(collectionName: string, update: Uint8Array, fromPeer: string): Promise<void> {
    let finalUpdate: Uint8Array | null = update;
    for (const plugin of this.plugins.values()) {
      if (plugin.onBeforeApplyUpdate) {
        finalUpdate = await plugin.onBeforeApplyUpdate(collectionName, finalUpdate, fromPeer);
        if (!finalUpdate) return; // Drop update
      }
    }

    const doc = this.getDoc(collectionName);
    Y.applyUpdate(doc, finalUpdate, "remote");
    this.emit("update:remote", { collectionName, update: finalUpdate, fromPeer });
  }

  async dispose(): Promise<void> {
    this.disable();
    for (const [, persistence] of this.persistences) {
      await persistence.destroy();
    }
    for (const [, doc] of this.docs) {
      doc.destroy();
    }
    this.docs.clear();
    this.persistences.clear();
  }

  // ─── Private ──────────────────────────────────────────────────────────────

  private onPeerUpdate(msg: { type: string; payload: Uint8Array | string; from: string }): void {
    if (msg.type === "sync-upgrade-offer") {
      const payloadStr = typeof msg.payload === "string" ? msg.payload : new TextDecoder().decode(msg.payload);
      const offer = JSON.parse(payloadStr) as { pluginUrl: string; version: number };
      
      // Auto-accept and load for this MVP.
      this.loadPlugin(offer.pluginUrl)
        .then(() => {
          this.network.sendTo(msg.from, {
            type: "sync-upgrade-accept",
            payload: JSON.stringify({ version: offer.version }),
          });
        })
        .catch(() => {
          // Failure to upgrade -> disconnect peer
          // Assuming `network` has a way to disconnect or we just ignore.
          // We can emit an error or handle it.
          console.warn(`Peer ${msg.from} failed to upgrade. Disconnecting is currently not natively supported in NetworkManager's public API directly from SyncEngine, but we will ignore their updates.`);
        });
      return;
    }

    if (msg.type === "sync-upgrade-accept") {
      // Could log or update peer state
      return;
    }

    if (msg.type !== "sync-update") return;

    const payload = typeof msg.payload === "string" ? base64ToBytes(msg.payload) : msg.payload;

    const decoded = this.decodeMessage(payload);
    if (decoded === null) return;

    void this.applyRemoteUpdate(decoded.collectionName, decoded.update, msg.from);
  }

  private encodeMessage(collectionName: string, update: Uint8Array): string {
    const nameBytes = new TextEncoder().encode(collectionName);
    const header = new Uint8Array([nameBytes.length]);
    const combined = new Uint8Array(1 + nameBytes.length + update.length);
    combined.set(header, 0);
    combined.set(nameBytes, 1);
    combined.set(update, 1 + nameBytes.length);
    return bytesToBase64(combined);
  }

  private decodeMessage(bytes: Uint8Array): {
    collectionName: string;
    update: Uint8Array;
  } | null {
    try {
      const nameLen = bytes[0];
      if (nameLen === undefined) return null;
      const nameBytes = bytes.slice(1, 1 + nameLen);
      const update = bytes.slice(1 + nameLen);
      return {
        collectionName: new TextDecoder().decode(nameBytes),
        update,
      };
    } catch {
      return null;
    }
  }

  private updateState(partial: Partial<SyncState>): void {
    this._state = { ...this._state, ...partial };
    this.emit("state:change", this._state);
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function bytesToBase64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

function base64ToBytes(b64: string): Uint8Array {
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}
