import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import "fake-indexeddb/auto";
import { NetworkManager } from "../../packages/network/src/network-manager.js";
import { SyncEngine } from "../../packages/sync/src/sync-engine.js";
import { AuthManager } from "../../packages/auth/src/auth-manager.js";
import { DbClient } from "../../packages/db/src/db-client.js";

// Mock SimplePeer so simple-peer does not try to initialize real WebRTC in node
vi.mock("simple-peer", () => {
  return {
    default: class MockSimplePeer {
      on() {}
      destroy() {}
    }
  };
});

describe("P2P & Sync Hardening Regression Tests", () => {
  let config: any;
  let auth: AuthManager;
  let db: DbClient;
  let network: NetworkManager;
  let syncEngine: SyncEngine;
  let currentAppId: string;

  beforeEach(() => {
    currentAppId = "test-p2p-" + Math.random().toString(36).slice(2);
    config = {
      appId: currentAppId,
      sync: {
        signalingUrl: "ws://localhost:8000",
        transport: "websocket",
      },
    };
    auth = new AuthManager(config);
    db = new DbClient(config);
    network = new NetworkManager(config, auth);
    syncEngine = new SyncEngine(config, db, network);
  });

  afterEach(async () => {
    await syncEngine.dispose();
    await network.dispose();
    await db.dispose();
    vi.restoreAllMocks();
  });

  describe("NetworkManager Reconnection Timer Guard", () => {
    it("should clear any active reconnect timers to prevent connection storm cascading loops", () => {
      const clearSpy = vi.spyOn(globalThis, "clearTimeout");
      const setSpy = vi.spyOn(globalThis, "setTimeout");

      // Trigger reconnection multiple times (simulate successive onClose events)
      // scheduleReconnect is private, so we access it dynamically
      (network as any).scheduleReconnect("test-room");
      (network as any).scheduleReconnect("test-room");
      (network as any).scheduleReconnect("test-room");

      // Assert that clearTimeout was called to invalidate the prior timers
      expect(clearSpy).toHaveBeenCalled();
      
      // Clean up the timer so it doesn't fire after the test
      if ((network as any).reconnectTimer) {
        clearTimeout((network as any).reconnectTimer);
      }
    });

    it("should clear any active reconnect timers when connect() is manually/automatically called", async () => {
      const clearSpy = vi.spyOn(globalThis, "clearTimeout");

      // Pre-populate reconnectTimer
      (network as any).reconnectTimer = setTimeout(() => {}, 10000);

      // Mock connectToUrl to resolve instantly so we don't hit real networking
      vi.spyOn(network as any, "connectToUrl").mockResolvedValue(undefined);

      await network.connect("test-room");

      // Assert that the active timer was cleared
      expect(clearSpy).toHaveBeenCalled();
      expect((network as any).reconnectTimer).toBeNull();
    });
  });

  describe("SyncEngine Outbox Concurrency Deduplication", () => {
    it("should process outbox mutations sequentially and prevent duplicate broadcasts when flush is triggered concurrently", async () => {
      // Configure outbox queue and seed it with a pending mutation
      await syncEngine.outbox.enqueue({
        type: "sync-update",
        collection: "todos",
        payload: new Uint8Array([1, 2, 3]),
      });

      // Enable sync
      syncEngine.enable();

      // Spy on network.broadcast and mock network peer count
      const broadcastSpy = vi.spyOn(network, "broadcast").mockImplementation(() => {});
      vi.spyOn(network, "connectedPeerCount", "get").mockReturnValue(2);

      // Trigger flushOutbox concurrently (multiple parallel async runs)
      // flushOutbox is private, so we access it dynamically
      await Promise.all([
        (syncEngine as any).flushOutbox(),
        (syncEngine as any).flushOutbox(),
        (syncEngine as any).flushOutbox(),
      ]);

      // Assert that broadcast was called EXACTLY ONCE
      expect(broadcastSpy).toHaveBeenCalledTimes(1);

      // Assert outbox is now fully flushed
      const pending = await syncEngine.outbox.getPending();
      expect(pending).toHaveLength(0);
    });
  });
});
