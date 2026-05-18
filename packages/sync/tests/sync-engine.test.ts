import { describe, it, expect, beforeEach } from "vitest";
import "fake-indexeddb/auto";
import { EventEmitter } from "zerithdb-core";
import { DbClient } from "zerithdb-db";
import { SyncEngine } from "../src/sync-engine.js";

// Highly resilient utility to poll for conditions in async tests under CPU load
async function waitUntil(predicate: () => Promise<boolean> | boolean, timeout = 3000, interval = 25): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
  throw new Error(`Timeout waiting for predicate after ${timeout}ms`);
}

// Mock Network Manager matching the public API and events used by SyncEngine
class MockNetworkManager extends EventEmitter<any> {
  public connectedPeerCount = 0;
  public peers = new Set<MockNetworkManager>();

  constructor(public readonly peerId: string) {
    super();
  }

  broadcast(msg: { type: string; payload: string }) {
    for (const peer of this.peers) {
      peer.emit("message", {
        type: msg.type,
        payload: msg.payload,
        from: this.peerId,
      });
    }
  }

  connect(other: MockNetworkManager) {
    this.peers.add(other);
    other.peers.add(this);
    this.connectedPeerCount = this.peers.size;
    other.connectedPeerCount = other.peers.size;
    this.emit("peer:connected", { peerId: other.peerId });
    other.emit("peer:connected", { peerId: this.peerId });
  }

  disconnect(other: MockNetworkManager) {
    this.peers.delete(other);
    other.peers.delete(this);
    this.connectedPeerCount = this.peers.size;
    other.connectedPeerCount = other.peers.size;
    this.emit("peer:disconnected", { peerId: other.peerId });
    other.emit("peer:disconnected", { peerId: this.peerId });
  }
}

describe("SyncEngine Integration", () => {
  let appId: string;

  beforeEach(() => {
    appId = `test-sync-${Math.random().toString(36).slice(2)}`;
  });

  const setupNode = (peerId: string, policies?: Record<string, "lww" | "crdt">) => {
    // Isolate each node's physical IndexedDB database by suffixing the appId with the peerId
    const config = {
      appId: `${appId}-${peerId}`,
      sync: {
        mergePolicies: policies,
      },
    };
    const db = new DbClient(config);
    // Override the auto-generated peerId for deterministic peer testing
    Object.defineProperty(db, "peerId", { value: peerId });

    const network = new MockNetworkManager(peerId);
    const sync = new SyncEngine(config, db, network);

    return { db, network, sync };
  };

  it("should propagate basic inserts when online", async () => {
    const nodeA = setupNode("peer-A");
    const nodeB = setupNode("peer-B");

    // Connect peers
    nodeA.network.connect(nodeB.network);

    // Enable sync on both
    nodeA.sync.registerCollection("posts");
    nodeB.sync.registerCollection("posts");
    nodeA.sync.enable();
    nodeB.sync.enable();

    // Node A inserts a post
    const collA = nodeA.db.collection("posts");
    const { id } = await collA.insert({ title: "Hello World", content: "Deterministic Sync FTW!" });

    const collB = nodeB.db.collection("posts");
    
    // Poll until Node B receives the record
    await waitUntil(async () => {
      const docB = await collB.findById(id);
      return docB !== undefined;
    });

    const docB = (await collB.findById(id))!;
    expect(docB.title).toBe("Hello World");
    expect(docB._vclock).toEqual({ "peer-A": 1 });
  });

  it("should queue updates offline and sync upon reconnection", async () => {
    const nodeA = setupNode("peer-A");
    const nodeB = setupNode("peer-B");

    // Enable sync while offline
    nodeA.sync.registerCollection("todos");
    nodeB.sync.registerCollection("todos");
    nodeA.sync.enable();
    nodeB.sync.enable();

    // Node A inserts offline
    const collA = nodeA.db.collection("todos");
    const { id } = await collA.insert({ task: "Write tests", done: false });

    // Node A outbox queue should have 1 pending update
    expect(await nodeA.sync.outbox.count()).toBe(1);

    // Connect and verify auto-flush
    nodeA.network.connect(nodeB.network);

    const collB = nodeB.db.collection("todos");

    // Poll until Node B receives it and Node A's outbox gets cleared
    await waitUntil(async () => {
      const docB = await collB.findById(id);
      const pendingCount = await nodeA.sync.outbox.count();
      return docB !== undefined && pendingCount === 0;
    });

    const docB = (await collB.findById(id))!;
    expect(docB.task).toBe("Write tests");
  });

  it("should resolve concurrent edits via Last-Writer-Wins policy and log conflict", async () => {
    const nodeA = setupNode("peer-A", { books: "lww" });
    const nodeB = setupNode("peer-B", { books: "lww" });

    // Initialize document in sync
    nodeA.network.connect(nodeB.network);
    nodeA.sync.registerCollection("books");
    nodeB.sync.registerCollection("books");
    nodeA.sync.enable();
    nodeB.sync.enable();

    const collA = nodeA.db.collection("books");
    const { id } = await collA.insert({ title: "Unknown", author: "Nobody" });

    // Ensure insertion is synced
    const collB = nodeB.db.collection("books");
    await waitUntil(async () => {
      return (await collB.findById(id)) !== undefined;
    });

    // Disconnect to make concurrent changes
    nodeA.network.disconnect(nodeB.network);

    // Node A updates author
    await collA.update({ _id: id }, { $set: { author: "Author A" } });

    // Node B updates author with slightly advanced lamport timestamp
    await new Promise((resolve) => setTimeout(resolve, 10)); // Lamport advance
    await collB.update({ _id: id }, { $set: { author: "Author B" } });

    // Verify clocks are concurrent
    const docAAfterEdit = (await collA.findById(id))!;
    const docBAfterEdit = (await collB.findById(id))!;
    expect(docAAfterEdit._vclock).toEqual({ "peer-A": 2 });
    expect(docBAfterEdit._vclock).toEqual({ "peer-A": 1, "peer-B": 1 });

    // Reconnect nodes to trigger deterministic merge
    nodeA.network.connect(nodeB.network);

    // Wait until document convergence and conflict logs are written
    await waitUntil(async () => {
      const finalA = await collA.findById(id);
      const finalB = await collB.findById(id);
      const logs = await nodeA.db.getSyncLogs();
      return finalA?.author === "Author B" && finalB?.author === "Author B" && logs.length > 0;
    });

    // Converged document check
    const docAFinal = (await collA.findById(id))!;
    const docBFinal = (await collB.findById(id))!;

    expect(docAFinal.author).toBe("Author B"); // Higher Lamport wins
    expect(docBFinal.author).toBe("Author B");

    // Verify the conflict was logged locally in Dexie
    const logs = await nodeA.db.getSyncLogs();
    expect(logs[0].strategy).toBe("lww");
    expect(logs[0].collectionName).toBe("books");
  });

  it("should merge concurrent edits recursively via CRDT merge policy", async () => {
    const nodeA = setupNode("peer-A", { profile: "crdt" });
    const nodeB = setupNode("peer-B", { profile: "crdt" });

    // Setup initial document
    nodeA.network.connect(nodeB.network);
    nodeA.sync.registerCollection("profile");
    nodeB.sync.registerCollection("profile");
    nodeA.sync.enable();
    nodeB.sync.enable();

    const collA = nodeA.db.collection("profile");
    const { id } = await collA.insert({ name: "User" });

    const collB = nodeB.db.collection("profile");
    await waitUntil(async () => {
      return (await collB.findById(id)) !== undefined;
    });

    // Disconnect
    nodeA.network.disconnect(nodeB.network);

    // Node A changes address (non-overlapping)
    await collA.update({ _id: id }, { $set: { address: "123 Main St" } });

    // Node B concurrently changes phone (non-overlapping)
    await collB.update({ _id: id }, { $set: { phone: "555-1234" } });

    // Reconnect
    nodeA.network.connect(nodeB.network);

    // Poll until merge is fully converged on both ends
    await waitUntil(async () => {
      const finalA = await collA.findById(id);
      const finalB = await collB.findById(id);
      return finalA?.address === "123 Main St" && finalA?.phone === "555-1234" &&
             finalB?.address === "123 Main St" && finalB?.phone === "555-1234";
    });

    // Convergence verify
    const docAFinal = (await collA.findById(id))!;
    const docBFinal = (await collB.findById(id))!;

    expect(docAFinal.address).toBe("123 Main St");
    expect(docAFinal.phone).toBe("555-1234");
    expect(docBFinal.address).toBe("123 Main St");
    expect(docBFinal.phone).toBe("555-1234");
    expect(docAFinal._vclock).toEqual({ "peer-A": 2, "peer-B": 1 });
  });

  it("should replicate logical deletes with tombstones", async () => {
    const nodeA = setupNode("peer-A");
    const nodeB = setupNode("peer-B");

    nodeA.network.connect(nodeB.network);
    nodeA.sync.registerCollection("notes");
    nodeB.sync.registerCollection("notes");
    nodeA.sync.enable();
    nodeB.sync.enable();

    // Node A inserts
    const collA = nodeA.db.collection("notes");
    const { id } = await collA.insert({ memo: "Confidential" });

    const collB = nodeB.db.collection("notes");
    await waitUntil(async () => {
      return (await collB.findById(id)) !== undefined;
    });

    // Node A deletes logically
    await collA.delete({ _id: id });

    // Poll until both hide the record from find operations
    await waitUntil(async () => {
      const docA = await collA.findById(id);
      const docB = await collB.findById(id);
      const listA = await collA.find();
      const listB = await collB.find();
      return docA === undefined && docB === undefined && listA.length === 0 && listB.length === 0;
    });

    // Under-the-hood check: Dexie should contain the logical tombstone doc with _deleted: true
    const rawTableA = (nodeA.db as any).dexie.ensureCollection("notes");
    const docInDbA = await rawTableA.get(id);
    expect(docInDbA).toBeDefined();
    expect(docInDbA._deleted).toBe(true);

    const rawTableB = (nodeB.db as any).dexie.ensureCollection("notes");
    const docInDbB = await rawTableB.get(id);
    expect(docInDbB).toBeDefined();
    expect(docInDbB._deleted).toBe(true);
  });
});
