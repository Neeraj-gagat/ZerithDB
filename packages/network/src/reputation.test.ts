/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi } from "vitest";
import { NetworkManager } from "./network-manager.js";

describe("Peer Reputation and Leech Protection", () => {
  it("should initialize peer reputation to 1.0", () => {
    const mockAuth = {} as any;
    const nm = new NetworkManager({ appId: "test" }, mockAuth);

    const peerId = "peer-1";
    // Simulate peer connection setup
    (nm as any).peerInfo.set(peerId, {
      peerId,
      connectedAt: Date.now(),
      bytesDownloaded: 0,
      bytesUploaded: 0,
      reputation: 1.0,
    });

    const info = (nm as any).peerInfo.get(peerId);
    expect(info.reputation).toBe(1.0);
  });

  it("should decrease reputation when peer only downloads (leeching)", () => {
    const mockAuth = {} as any;
    const nm = new NetworkManager({ appId: "test" }, mockAuth);

    const peerId = "peer-2";
    (nm as any).peerInfo.set(peerId, {
      peerId,
      connectedAt: Date.now(),
      bytesDownloaded: 0,
      bytesUploaded: 0,
      reputation: 1.0,
    });

    // Simulate peer downloading 1MB without uploading
    (nm as any).updateReputation(peerId, 1024 * 1024, 0);
    
    const info = (nm as any).peerInfo.get(peerId);
    expect(info.reputation).toBeLessThan(1.0);
  });

  it("should maintain reputation when peer uploads fairly", () => {
    const mockAuth = {} as any;
    const nm = new NetworkManager({ appId: "test" }, mockAuth);

    const peerId = "peer-3";
    (nm as any).peerInfo.set(peerId, {
      peerId,
      connectedAt: Date.now(),
      bytesDownloaded: 0,
      bytesUploaded: 0,
      reputation: 1.0,
    });

    // Simulate peer uploading 500KB and downloading 500KB
    (nm as any).updateReputation(peerId, 500 * 1024, 500 * 1024);
    
    const info = (nm as any).peerInfo.get(peerId);
    expect(info.reputation).toBeGreaterThan(0.5);
  });

  it("should disconnect peer when leech threshold is crossed", () => {
    const mockAuth = {} as any;
    const nm = new NetworkManager({ appId: "test" }, mockAuth);
    const mockPeer = { destroy: vi.fn() };
    (nm as any).peers.set("peer-4", mockPeer);

    // Also mock console.warn
    vi.spyOn(console, "warn").mockImplementation(() => {});

    const peerId = "peer-4";
    (nm as any).peerInfo.set(peerId, {
      peerId,
      connectedAt: Date.now(),
      bytesDownloaded: 0,
      bytesUploaded: 0,
      reputation: 1.0,
    });

    // Simulate peer downloading 6MB (over 5MB threshold) with 0 uploads
    (nm as any).updateReputation(peerId, 6 * 1024 * 1024, 0);
    
    expect(mockPeer.destroy).toHaveBeenCalled();
  });
});
