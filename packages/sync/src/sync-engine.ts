import * as Y from "yjs";
import * as awarenessProtocol from "y-protocols/awareness";
import { IndexeddbPersistence } from "y-indexeddb";
import { EventEmitter, ValidatorRegistry } from "zerithdb-core";
import type { ZerithDBConfig, SyncState, SyncPlugin } from "zerithdb-core";
import type { DbClient } from "zerithdb-db";
import type { NetworkManager } from "zerithdb-network";
import type { SyncProtocol } from "zerithdb-core";
import { InboxQueue } from "./queue/InboxQueue.js";
import { OutboxQueue } from "./queue/OutboxQueue.js";
import { EphemeralStateManager } from "./ephemeral-state.js";
import { DefaultSyncProtocol } from "./protocol.js";

type SyncEvents = {
  "state:change": SyncState;
  "update:local": { collectionName: string; update: Uint8Array };
  "update:remote": { collectionName: string; update: Uint8Array; fromPeer: string };
  "validation:error": {
    collectionName: string;
    fromPeer: string;
    issues: Array<{ path: Array<string | number | symbol>; message: string }>;
  };
};

/**
 * Deterministic sync engine using Vector Clocks and Lamport timestamps.
 * Replaces Yjs with an explicit state-based replication protocol.
 * Integrates Inbox/Outbox queues to handle offline-first mutation logging.
 */
export class SyncEngine extends EventEmitter<SyncEvents> {
  private readonly docs = new Map<string, Y.Doc>();
  private readonly persistences = new Map<string, IndexeddbPersistence>();
  private readonly awarenesses = new Map<string, awarenessProtocol.Awareness>();
  readonly outbox: OutboxQueue<Uint8Array>;
  readonly inbox: InboxQueue<Uint8Array>;
  public readonly ephemeral: EphemeralStateManager;
  private _enabled = false;
  private _state: SyncState = {
    synced: false,
    pendingUpdates: 0,
    connectedPeers: 0,
  };

  private plugins = new Map<string, SyncPlugin>();
  private activePluginVersion = 1;
  private pendingUpdates = new Map<string, Uint8Array[]>();

  private syncTimer: any = null;
  private syncTimerIsRaf: boolean = false;
  private protocol: SyncProtocol = new DefaultSyncProtocol();

  constructor(
    private readonly config: ZerithDBConfig,
    private readonly db: DbClient,
    private readonly network: NetworkManager,
    private readonly validatorRegistry?: ValidatorRegistry
  ) {
    super();

    this.outbox = new OutboxQueue(config.appId);
    this.inbox = new InboxQueue(config.appId);
    this.ephemeral = new EphemeralStateManager(config, network);

    this.onPeerUpdate = this.onPeerUpdate.bind(this);
    this.onLocalMutation = this.onLocalMutation.bind(this);
    this.onPeerConnected = this.onPeerConnected.bind(this);
    this.onPeerDisconnected = this.onPeerDisconnected.bind(this);

    this.outbox.onChange(() => {
      void this.refreshPendingCount();
    });

    void this.refreshPendingCount();
  }

  private handleVisibilityChange = (): void => {
    if (document.visibilityState === "visible") {
      if (this.pendingUpdates.size > 0 && !this.syncTimer) {
        this.flushUpdates();
      }
    } else if (document.visibilityState === "hidden") {
      if (this.syncTimer) {
        if (this.syncTimerIsRaf && typeof window !== "undefined" && window.cancelAnimationFrame) {
          window.cancelAnimationFrame(this.syncTimer);
        } else {
          clearTimeout(this.syncTimer);
        }

        this.syncTimer = null;
        this.syncTimerIsRaf = false;
      }
    }
  };

  enable(): void {
    if (this._enabled) return;

    this._enabled = true;

    this.network.on("message", this.onPeerUpdate);
    this.network.on("peer:connected", this.onPeerConnected);
    this.network.on("peer:disconnected", this.onPeerDisconnected);
    this.updateState({ synced: true, connectedPeers: this.network.connectedPeerCount });
    void this.flushOutbox();

    // Start background anti-entropy sync (every 100ms) to guarantee strong eventual consistency
    this.antiEntropyTimer = setInterval(() => {
      this.triggerAntiEntropy();
    }, 100);
  }

  disable(): void {
    this._enabled = false;

    this.network.off("message", this.onPeerUpdate);
    this.network.off("peer:connected", this.onPeerConnected);
    this.network.off("peer:disconnected", this.onPeerDisconnected);
    this.updateState({ synced: false, connectedPeers: 0 });

  registerPlugin(plugin: SyncPlugin): void {
    this.plugins.set(plugin.id, plugin);

    if (plugin.version > this.activePluginVersion) {
      this.activePluginVersion = plugin.version;
    }
  }

  async loadPlugin(pluginUrl: string): Promise<void> {
    try {
      const module = await import(pluginUrl);
      const plugin = module.default as SyncPlugin;
      this.registerPlugin(plugin);
    } catch (err) {
      console.error(`Failed to load plugin from ${pluginUrl}`, err);
    }
  }

  proposeUpgrade(pluginUrl: string, version: number): void {
    this.network.broadcast({
      type: "sync-upgrade-offer",
      payload: JSON.stringify({ pluginUrl, version }),
    });
  }

  /**
   * Update the sync protocol at runtime.
   * This allows hot-reloading different wire formats or conflict resolution
   * rules without dropping existing peer connections.
   */
  setProtocol(protocol: SyncProtocol): void {
    console.log(
      `[SyncEngine] Switching protocol: ${this.protocol.name} v${this.protocol.version} -> ${protocol.name} v${protocol.version}`
    );
    this.protocol = protocol;
  }

  /** Current sync state snapshot */
  get state(): Readonly<SyncState> {
    return this._state;
  }

  /**
   * Alias for getDoc to match common Yjs terminology.
   */
  getYDoc(collectionName: string): Y.Doc {
    return this.getDoc(collectionName);
  }

  /**
   * Get or create the Yjs document for a collection.
   * Documents are persisted to IndexedDB via y-indexeddb.
   */
  getDoc(collectionName: string): Y.Doc {
    if (this.docs.has(collectionName)) {
      return this.docs.get(collectionName)!;
    }

    const doc = new Y.Doc({
      guid: `${this.config.appId}:${collectionName}`,
    });

    const persistence = new IndexeddbPersistence(
      `zerithdb_sync_${this.config.appId}_${collectionName}`,
      doc
    );

    this.persistences.set(collectionName, persistence);

    doc.on("update", (update: Uint8Array, origin: unknown) => {
      if (origin === "remote") return;

      this.queueUpdate(collectionName, update);
    });

    this.docs.set(collectionName, doc);

    return doc;
  }

  /**
   * Get or create the awareness instance for a collection.
   * Awareness is used for ephemeral state like cursor positions.
   */
  getAwareness(collectionName: string): awarenessProtocol.Awareness {
    if (this.awarenesses.has(collectionName)) {
      // biome-ignore lint: map guarantees defined
      return this.awarenesses.get(collectionName)!;
    }

    const doc = this.getDoc(collectionName);
    const awareness = new awarenessProtocol.Awareness(doc);

    awareness.on("update", ({ added, updated, removed }: any, origin: any) => {
      if (origin === "remote") return;
      if (!this._enabled) return;

      const changedClients = added.concat(updated).concat(removed);
      const update = awarenessProtocol.encodeAwarenessUpdate(awareness, changedClients);

      this.network.broadcast({
        type: "awareness",
        payload: this.encodeMessage(collectionName, update),
      });
    });

    this.awarenesses.set(collectionName, awareness);
    return awareness;
  }

  /**
   * Apply a remote CRDT update to the local document.
   * Called by the network layer when a peer sends an update.
   */
  async applyRemoteUpdate(
    collectionName: string,
    update: Uint8Array,
    fromPeer: string
  ): Promise<void> {
    let finalUpdate: Uint8Array | null = update;

    for (const plugin of this.plugins.values()) {
      if (plugin.onBeforeApplyUpdate) {
        finalUpdate = await plugin.onBeforeApplyUpdate(collectionName, finalUpdate, fromPeer);

        if (!finalUpdate) return;
      }
    }

    const doc = this.getDoc(collectionName);
    const dataMap = doc.getMap(collectionName);
    const changedKeys = new Set<string>();
    let observing = false;

    const observer = (event: Y.YMapEvent<any>) => {
      for (const [key] of event.changes.keys) {
        changedKeys.add(key);
      }
    };

    if (this.validatorRegistry?.has(collectionName)) {
      observing = true;
      dataMap.observe(observer);
    }

    try {
      await this.handleRemoteUpdate(collectionName, finalUpdate, fromPeer);
    } finally {
      if (observing) {
        dataMap.unobserve(observer);
      }
    }

    if (observing && changedKeys.size > 0) {
      for (const key of changedKeys) {
        const value = dataMap.get(key);
        if (value === undefined) continue; // deleted key

        const result = this.validatorRegistry!.validateRemote(collectionName, value);

        if (!result.valid) {
          this.emit("validation:error", {
            collectionName,
            fromPeer,
            issues: result.issues,
          });
        }
      }
    }
  }

  /**
   * Apply a remote awareness update.
   */
  applyRemoteAwarenessUpdate(collectionName: string, update: Uint8Array): void {
    const awareness = this.getAwareness(collectionName);
    awarenessProtocol.applyAwarenessUpdate(awareness, update, "remote");
  }

  async dispose(): Promise<void> {
    if (typeof document !== "undefined") {
      document.removeEventListener("visibilitychange", this.handleVisibilityChange);
    }

    this.disable();
    if (this.syncTimer) {
      if (this.syncTimerIsRaf && typeof window !== "undefined" && window.cancelAnimationFrame) {
        window.cancelAnimationFrame(this.syncTimer);
      } else {
        clearTimeout(this.syncTimer);
      }

      this.syncTimer = null;
      this.syncTimerIsRaf = false;
    }

    for (const [, persistence] of this.persistences) {
      await persistence.destroy();
    }

    for (const [, doc] of this.docs) {
      doc.destroy();
    }
    for (const [, awareness] of this.awarenesses) {
      awareness.destroy();
    }
    this.docs.clear();
    this.persistences.clear();
    this.awarenesses.clear();
    this.pendingUpdates.clear();
  }

  // ─── Private ──────────────────────────────────────────────────────────────

  private queueUpdate(collectionName: string, update: Uint8Array): void {
    let updates = this.pendingUpdates.get(collectionName);

    if (!updates) {
      updates = [];
      this.pendingUpdates.set(collectionName, updates);
    }

    updates.push(update);

    if (
      !this.syncTimer &&
      (typeof document === "undefined" || document.visibilityState !== "hidden")
    ) {
      if (typeof window !== "undefined" && window.requestAnimationFrame) {
        this.syncTimer = window.requestAnimationFrame(() => this.flushUpdates());

        this.syncTimerIsRaf = true;
      } else {
        this.syncTimer = setTimeout(() => this.flushUpdates(), 50);
        this.syncTimerIsRaf = false;
      }
    }
  }

  private flushUpdates(): void {
    this.syncTimer = null;
    for (const [collectionName, updates] of this.pendingUpdates.entries()) {
      const merged = Y.mergeUpdates(updates);
      void this.handleLocalUpdate(collectionName, merged);
    }

    this.pendingUpdates.clear();
  }

  private onPeerUpdate(msg: { type: string; payload: Uint8Array | string; from: string }): void {
    if (msg.type === "sync-upgrade-offer") {
      const payloadStr =
        typeof msg.payload === "string" ? msg.payload : new TextDecoder().decode(msg.payload);

      this.loadPlugin(offer.pluginUrl)
        .then(() => {
          this.network.sendTo(msg.from, {
            type: "sync-upgrade-accept",
            payload: JSON.stringify({ version: offer.version }),
          });
        })
        .catch(() => {
          console.warn(
            `Peer ${msg.from} failed to upgrade. Ignoring their future updates.`
          );
        });

      return;
    }

    if (msg.type === "sync-upgrade-accept") {
      return;
    }

    if (msg.type !== "sync-update" && msg.type !== "awareness-update") return;

    const decoded = this.protocol.decode(msg.payload);
    if (decoded === null) return;

    if (msg.type === "sync-update") {
      void this.applyRemoteUpdate(decoded.collectionName, decoded.update, msg.from);
    } else {
      this.applyRemoteAwarenessUpdate(decoded.collectionName, decoded.update);
    }
  }

  private onPeerConnected(): void {
    this.updateState({
      connectedPeers: this.network.connectedPeerCount,
    });

    void this.flushOutbox();
  }

  private onPeerDisconnected(): void {
    this.updateState({
      connectedPeers: this.network.connectedPeerCount,
    });
  }

  private async handleLocalUpdate(collectionName: string, update: Uint8Array): Promise<void> {
    try {
      let finalUpdate: Uint8Array | null = update;

      for (const plugin of this.plugins.values()) {
        if (plugin.onBeforeSendUpdate) {
          finalUpdate = await plugin.onBeforeSendUpdate(collectionName, finalUpdate);
          if (!finalUpdate) return;
        }
      }

      const mutation = await this.outbox.enqueue({
        type: "sync-update",
        collection: collectionName,
        payload: finalUpdate,
      });

      if (!this._enabled) return;

      this.emit("update:local", {
        collectionName,
        update: finalUpdate,
      });

      if (this.network.connectedPeerCount === 0) return;

      this.network.broadcast({
        type: "sync-update",
        payload: this.protocol.encode(collectionName, finalUpdate),
      });

      await this.outbox.acknowledge(mutation.id);
    } catch {
      // swallow
    }
  }

  private async handleRemoteUpdate(
    collectionName: string,
    update: Uint8Array,
    fromPeer: string
  ): Promise<void> {
    let mutationId: string | null = null;
    try {
      const rawPayload = typeof msg.payload === "string" ? msg.payload : new TextDecoder().decode(msg.payload);
      const { collectionName, doc, peerId } = JSON.parse(rawPayload);
      
      const mutation = await this.inbox.enqueue({
        type: "sync-update",
        collection: collectionName,
        payload: doc,
      });

      mutationId = mutation.id;
    } catch {
      // continue
    }

    try {
      const doc = this.getDoc(collectionName);

      Y.applyUpdate(doc, update, "remote");

      if (mutationId) {
        await this.inbox.acknowledge(mutationId);
      }

      this.emit("update:remote", {
        collectionName,
        update,
        fromPeer,
      });
    } catch {
      if (mutationId) {
        await this.inbox.markFailed(mutationId);
      }
    }
  }

  private onPeerConnected(peer: { peerId: string }): void {
  const peerId = peer.peerId;
    this.updateState({ connectedPeers: this.network.connectedPeerCount });
    void this.sendCapability(peerId);
    void this.flushOutbox();

    if (peer?.peerId) {
      for (const [collectionName, doc] of this.docs.entries()) {
        const stateVector = Y.encodeStateVector(doc);
        this.network.sendTo(peer.peerId, {
          type: "sync-request",
          payload: this.encodeMessage(collectionName, stateVector),
        });
      }
    }
  }

  private onPeerDisconnected(peer: { peerId: string }): void {
  const peerId = peer.peerId;
    this.peerCapabilities.delete(peerId);
    this.updateState({ connectedPeers: this.network.connectedPeerCount });
  }

  private async flushOutbox(): Promise<void> {
    if (!this._enabled) return;
    if (this.network.connectedPeerCount === 0) return;
    if (this.isFlushing) return;

    const pending = await this.outbox.getPending();

    for (const mutation of pending) {
      this.network.broadcast({
        type: mutation.type,
        payload: this.protocol.encode(mutation.collection, mutation.payload),
      });

      await this.outbox.acknowledge(mutation.id);
    }
  }

  private updateState(partial: Partial<SyncState>): void {
    this._state = { ...this._state, ...partial };
    this.emit("state:change", this._state);
  }

  private async refreshPendingCount(): Promise<void> {
    const pending = await this.outbox.count();

    this.updateState({
      pendingUpdates: pending,
    });
  }
}
