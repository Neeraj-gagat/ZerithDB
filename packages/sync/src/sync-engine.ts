import type { ZerithDBConfig, SyncState, Document, MergePolicy } from "zerithdb-core";
import { EventEmitter } from "zerithdb-core";
import type { DbClient } from "zerithdb-db";
import type { NetworkManager } from "zerithdb-network";
import { lwwMerge } from "./merge/lww.js";
import { crdtMerge } from "./merge/crdt.js";
import { InboxQueue } from "./queue/InboxQueue.js";
import { OutboxQueue } from "./queue/OutboxQueue.js";
import { EphemeralStateManager } from "./ephemeral-state.js";


type SyncEvents = {
  "state:change": SyncState;
  "update:local": { collectionName: string; doc: Document<any> };
  "update:remote": { collectionName: string; doc: Document<any>; fromPeer: string };
  conflict: { collectionName: string; docId: string; strategy: string };
};

/**
 * Deterministic sync engine using Vector Clocks and Lamport timestamps.
 * Replaces Yjs with an explicit state-based replication protocol.
 * Integrates Inbox/Outbox queues to handle offline-first mutation logging.
 */
export class SyncEngine extends EventEmitter<SyncEvents> {
  /** Low-latency, non-persistent metadata sync for presence, media, and UI state. */
  readonly ephemeral: EphemeralStateManager;

  private _enabled = false;
  
  private _state: SyncState = { synced: false, pendingUpdates: 0, connectedPeers: 0 };
  private activeCollections = new Set<string>();
  readonly outbox: OutboxQueue<Document<any>>;
  readonly inbox: InboxQueue<Document<any>>;

  constructor(
    private readonly config: ZerithDBConfig,
    private readonly db: DbClient,
    private readonly network: NetworkManager,
    private readonly auth: AuthManager
  ) {
    super();
    this.ephemeral = new EphemeralStateManager(config, network);
    this.outbox = new OutboxQueue(config.appId);
    this.inbox = new InboxQueue(config.appId);
    this.onPeerUpdate = this.onPeerUpdate.bind(this);
    this.onLocalMutation = this.onLocalMutation.bind(this);
    this.onPeerConnected = this.onPeerConnected.bind(this);
    this.onPeerDisconnected = this.onPeerDisconnected.bind(this);

    this.outbox.onChange(() => {
      void this.refreshPendingCount();
    });
    void this.refreshPendingCount();
  }

  /**
   * Enable sync. Subscribes to network messages and DB mutations.
   */
  enable(): void {
    if (this._enabled) return;
    this._enabled = true;
    this.network.on("message", this.onPeerUpdate);
    this.network.on("peer:connected", this.onPeerConnected);
    this.network.on("peer:disconnected", this.onPeerDisconnected);
    this.ephemeral.enable();
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
    this.ephemeral.disable();
    this.updateState({ synced: false, connectedPeers: 0 });

    if (this.antiEntropyTimer) {
      clearInterval(this.antiEntropyTimer);
      this.antiEntropyTimer = null;
    }
  }

  private triggerAntiEntropy(): void {
    if (!this._enabled || this.network.connectedPeerCount === 0) return;
    for (const [collectionName, doc] of this.docs.entries()) {
      const stateVector = Y.encodeStateVector(doc);
      this.network.broadcast({
        type: "sync-request",
        payload: this.encodeMessage(collectionName, stateVector),
      });
    }
  }

  get state(): Readonly<SyncState> {
    return this._state;
  }

  /**
   * Registers a collection for sync.
   */
  registerCollection(collectionName: string): void {
    if (this.activeCollections.has(collectionName)) return;
    
    const collection = this.db.collection(collectionName);
    collection.on("mutation", this.onLocalMutation);
    this.activeCollections.add(collectionName);
  }

  /**
   * Apply a remote update to the local database with deterministic conflict resolution.
   */
  async applyRemoteUpdate(collectionName: string, remoteDoc: Document<any>, fromPeer: string): Promise<void> {
    this.registerCollection(collectionName);
    const collection = this.db.collection(collectionName);
    const localDoc = await collection.findById(remoteDoc._id);

    if (!localDoc) {
      // New document, just save it
      await collection.applyRemoteUpdate(remoteDoc);
      this.emit("update:remote", { collectionName, doc: remoteDoc, fromPeer });
      return;
    }

    // Compare vector clocks
    const comparison = this.compareVectorClocks(localDoc._vclock, remoteDoc._vclock);

    if (comparison === "greater") {
      // Local is strictly newer, ignore remote
      return;
    }

    if (comparison === "less") {
      // Remote is strictly newer, apply it
      await collection.applyRemoteUpdate(remoteDoc);
      this.emit("update:remote", { collectionName, doc: remoteDoc, fromPeer });
      return;
    }

    // Concurrent modification! Conflict resolution needed.
    const policy = this.config.sync?.mergePolicies?.[collectionName] || "lww";
    let resolvedDoc: Document<any>;
    let strategy = "";

    if (policy === "lww") {
      resolvedDoc = lwwMerge(localDoc, remoteDoc, this.db.peerId, fromPeer);
      strategy = "lww";
    } else if (policy === "crdt") {
      resolvedDoc = crdtMerge(localDoc, remoteDoc, this.db.peerId, fromPeer);
      strategy = "crdt";
    } else if (typeof policy === "function") {
      resolvedDoc = policy(localDoc, remoteDoc);
      strategy = "custom";
    } else {
      resolvedDoc = lwwMerge(localDoc, remoteDoc, this.db.peerId, fromPeer);
      strategy = "lww-fallback";
    }

    await collection.applyRemoteUpdate(resolvedDoc);
    
    // Log conflict for debugging/replay
    await this.db.logConflict({
      collectionName,
      docId: remoteDoc._id,
      localDoc,
      remoteDoc,
      resolvedDoc,
      strategy,
      timestamp: Date.now(),
    });

    this.emit("conflict", { collectionName, docId: remoteDoc._id, strategy });
    this.emit("update:remote", { collectionName, doc: resolvedDoc, fromPeer });
  }

  async dispose(): Promise<void> {
    this.disable();
    this.ephemeral.dispose();
    for (const name of this.activeCollections) {
      this.db.collection(name).off("mutation", this.onLocalMutation);
    }
    this.activeCollections.clear();
  }

  // ─── Private ──────────────────────────────────────────────────────────────

  private onLocalMutation(event: { collectionName: string; doc: Document<any> }): void {
    if (!this._enabled) return;

    this.emit("update:local", { collectionName: event.collectionName, doc: event.doc });

    // Enqueue mutation in the outbox
    this.outbox.enqueue({
      type: "sync-update",
      collection: event.collectionName,
      payload: event.doc,
    }).then(() => {
      void this.flushOutbox();
    }).catch((err) => {
      console.error("Failed to enqueue outbox update", err);
    });
  }

  private async onPeerUpdate(msg: { type: string; payload: string | Uint8Array; from: string }): Promise<void> {
    if (msg.type !== "sync-update") return;

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

      await this.applyRemoteUpdate(collectionName, doc, peerId);
      await this.inbox.acknowledge(mutationId);
    } catch (err) {
      console.error("Failed to process peer update", err);
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

    try {
      const pending = await this.outbox.getPending();
      for (const mutation of pending) {
        this.network.broadcast({
          type: "sync-update",
          payload: JSON.stringify({
            collectionName: mutation.collection,
            doc: mutation.payload,
            peerId: this.db.peerId,
          }),
        });
        await this.outbox.acknowledge(mutation.id);
      }
    } catch (err) {
      console.error("Failed to flush outbox", err);
    }
  }

  private compareVectorClocks(v1: Record<string, number>, v2: Record<string, number>): "less" | "greater" | "equal" | "concurrent" {
    let v1Greater = false;
    let v2Greater = false;

    const allKeys = new Set([...Object.keys(v1), ...Object.keys(v2)]);

    for (const key of allKeys) {
      const c1 = v1[key] || 0;
      const c2 = v2[key] || 0;

      if (c1 > c2) v1Greater = true;
      if (c2 > c1) v2Greater = true;
    }

    if (v1Greater && v2Greater) return "concurrent";
    if (v1Greater) return "greater";
    if (v2Greater) return "less";
    return "equal";
  }

  private updateState(partial: Partial<SyncState>): void {
    this._state = { ...this._state, ...partial };
    this.emit("state:change", this._state);
  }

  private async refreshPendingCount(): Promise<void> {
    try {
      const pending = await this.outbox.count();
      this.updateState({ pendingUpdates: pending });
    } catch {
      // Ignore count read errors on initial/closing states
    }
  }
}
