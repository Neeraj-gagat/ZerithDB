import SimplePeer from "simple-peer";
import type { ZerithDBConfig, PeerId, PeerInfo, MediaStreamMetadata } from "zerithdb-core";
import { EventEmitter, ZerithDBError, ErrorCode } from "zerithdb-core";
import type { AuthManager } from "zerithdb-auth";
import type { SignalingTransport } from "./signaling-transport.js";
import { WebSocketTransport } from "./transports/websocket-transport.js";
import { PollingTransport } from "./transports/polling-transport.js";

export interface MediaStreamMetadataInput {
  kind?: "camera" | "screen" | "custom";
  [key: string]: unknown;
}

export interface WebRtcBufferStats {
  peerCount: number;
  bufferedBytes: number;
  peers: Array<{ peerId: PeerId; bufferedAmount: number }>;
}

/** simple-peer exposes the underlying RTCDataChannel as a private field */
interface SimplePeerWithChannel {
  connected: boolean;
  _channel?: RTCDataChannel;
}

type NetworkEvents = {
  "peer:connected": PeerInfo;
  "peer:disconnected": { peerId: PeerId };
  message: { type: string; payload: Uint8Array | string; from: PeerId };
  error: { peerId: PeerId; error: Error };
  "transport:downgrade": { from: "websocket"; to: "polling"; reason: string };
  "media:stream": { peerId: PeerId; stream: MediaStream; metadata?: MediaStreamMetadata };
  "media:stream:removed": { peerId: PeerId; streamId: string };
};

export type MediaStreamMetadataInput = Partial<
  Omit<
    MediaStreamMetadata,
    "streamId" | "peerId" | "tracks" | "audioMuted" | "videoMuted" | "updatedAt"
  >
> & { kind?: MediaStreamKind };


interface SignalingMessage {
  type: "offer" | "answer" | "ice-candidate" | "peer-list" | "intro";
  from: string;
  to?: string;
  payload: unknown;
}

const DEFAULT_SIGNALING_URL = "wss://arpitkhandelwal810-zerith-signaling.hf.space";

/**
 * Manages WebRTC peer-to-peer connections for a ZerithDB app.
 *
 * Architecture: Full mesh — every peer connects to every other peer.
 * The signaling server only handles the initial WebRTC handshake (ICE/SDP).
 * After that, all data flows peer-to-peer over encrypted WebRTC data channels.
 *
 * Supports automatic transport fallback: if WebSocket signaling is blocked
 * (e.g. by corporate firewalls), the manager transparently downgrades to
 * HTTP long-polling.
 *
 * Supports multiple signaling server URLs with automatic failover:
 * if one server fails, the next URL in the list is tried automatically.
 */
export class NetworkManager extends EventEmitter<NetworkEvents> {
  private transport: SignalingTransport | null = null;
  private activeTransportType: "websocket" | "polling" | null = null;
  private readonly peers = new Map<PeerId, SimplePeer.Instance>();
  private readonly peerInfo = new Map<PeerId, PeerInfo>();
  private localPeerId: PeerId = crypto.randomUUID();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempts = 0;
  private disposed = false;
  private currentUrlIndex = 0;
  private readonly localMetadata = new Map<string, MediaStreamMetadata>();

  // ─── Self-healing peer mesh ───────────────────────────────────────────────
  // Tracks every peer ID we've ever seen in the room so we can detect
  // missing connections and re-initiate them automatically.
  private readonly knownPeerIds = new Set<PeerId>();
  private readonly peerCreationTimes = new Map<PeerId, number>();
  private peerCheckInterval: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly config: ZerithDBConfig,
    private readonly auth: AuthManager
  ) {
    super();
  }

  /** The local peer ID assigned to this instance */
  get peerId(): PeerId {
    return this.localPeerId;
  }

  addMediaStream(
    stream: MediaStream,
    metadata: MediaStreamMetadataInput = {}
  ): MediaStreamMetadata {
    const tracks = stream.getTracks().map((track) => ({
      trackId: track.id,
      kind: track.kind as "audio" | "video",
      label: track.label,
      enabled: track.enabled,
      muted: track.muted,
      readyState: track.readyState,
    }));

    const normalized: MediaStreamMetadata = {
      streamId: stream.id,
      peerId: this.peerId,
      kind: (metadata.kind as "camera" | "screen" | "custom") ?? "camera",
      audioMuted: tracks.filter((t) => t.kind === "audio").every((t) => !t.enabled),
      videoMuted: tracks.filter((t) => t.kind === "video").every((t) => !t.enabled),
      tracks,
      updatedAt: Date.now(),
    };
    this.localMetadata.set(normalized.streamId, normalized);
    return normalized;
  }

  removeMediaStream(streamOrId: MediaStream | string): void {
    const streamId = typeof streamOrId === "string" ? streamOrId : streamOrId.id;
    this.localMetadata.delete(streamId);
  }

  updateMediaStreamMetadata(
    streamId: string,
    metadata: MediaStreamMetadataInput
  ): MediaStreamMetadata | undefined {
    const existing = this.localMetadata.get(streamId);
    if (!existing) return undefined;
    const updated = {
      ...existing,
      kind: (metadata.kind as "camera" | "screen" | "custom") ?? existing.kind,
      updatedAt: Date.now(),
    };
    this.localMetadata.set(streamId, updated);
    return updated;
  }

  setMediaTrackEnabled(kind: "audio" | "video", enabled: boolean, streamId?: string): void {
    for (const metadata of this.localMetadata.values()) {
      if (streamId !== undefined && metadata.streamId !== streamId) continue;
      for (const track of metadata.tracks) {
        if (track.kind === kind) {
          track.enabled = enabled;
        }
      }
      metadata.audioMuted = metadata.tracks
        .filter((track) => track.kind === "audio")
        .every((track) => !track.enabled);
      metadata.videoMuted = metadata.tracks
        .filter((track) => track.kind === "video")
        .every((track) => !track.enabled);
    }
  }

  getLocalMediaStreamMetadata(): MediaStreamMetadata[] {
    return [...this.localMetadata.values()];
  }

  /** The transport type currently in use, or null if not connected */
  get transportType(): "websocket" | "polling" | null {
    return this.activeTransportType;
  }

  /** The local peer's unique identifier within the current P2P session. */
  get peerId(): PeerId {
    return this.localPeerId;
  }

  /**
   * Returns the ordered list of signaling URLs to try.
   * Supports both signalingUrls (array) and signalingUrl (single).
   * Falls back to the default URL if neither is set.
   */
  private getSignalingUrls(): string[] {
    if (this.config.sync?.signalingUrls && this.config.sync.signalingUrls.length > 0) {
      return this.config.sync.signalingUrls;
    }
    return [this.config.sync?.signalingUrl ?? DEFAULT_SIGNALING_URL];
  }

  /**
   * Connect to the signaling server and join the P2P room.
   * Tries each URL in order — automatically fails over to the next on failure.
   *
   * Transport selection per URL:
   * - `"auto"` (default): Try WebSocket first, fall back to HTTP long-polling.
   * - `"websocket"`: WebSocket only.
   * - `"polling"`: HTTP long-polling only.
   */
  async connect(roomId: string): Promise<void> {
    const urls = this.getSignalingUrls();

    for (let i = 0; i < urls.length; i++) {
      const index = (this.currentUrlIndex + i) % urls.length;
      const url = urls[index];

      try {
        await this.connectToUrl(url, roomId);
        this.currentUrlIndex = index;
        return;
      } catch {
        console.warn(`[ZerithDB] Signaling server failed: ${url}. Trying next...`);
      }
    }

    throw new ZerithDBError(
      ErrorCode.NETWORK_SIGNALING_FAILED,
      `All signaling servers failed. Tried: ${urls.join(", ")}`
    );
  }

  /**
   * Try connecting to a single signaling URL using the configured transport.
   */
  private async connectToUrl(signalingUrl: string, roomId: string): Promise<void> {
    const transportPref = this.config.sync?.transport ?? "auto";

    if (transportPref === "websocket") {
      await this.connectWebSocket(signalingUrl, roomId);
    } else if (transportPref === "polling") {
      await this.connectPolling(signalingUrl, roomId);
    } else {
      // "auto" — try WebSocket first, fall back to polling
      try {
        await this.connectWebSocket(signalingUrl, roomId);
      } catch (wsError) {
        const reason = wsError instanceof Error ? wsError.message : "WebSocket connection failed";

        this.emit("transport:downgrade", {
          from: "websocket",
          to: "polling",
          reason,
        });

        console.warn(
          `[ZerithDB] WebSocket signaling failed (${reason}). ` +
            `Falling back to HTTP long-polling.`
        );

        await this.connectPolling(signalingUrl, roomId);
      }
    }
  }

  /**
   * Broadcast a message to all connected peers.
   */
  broadcast(message: { type: string; payload: string | Uint8Array }): void {
    const data = JSON.stringify(message);
    const bytesLength = typeof TextEncoder !== "undefined" ? new TextEncoder().encode(data).length : data.length;
    for (const [peerId, peer] of this.peers) {
      if (peer.connected) {
        this.throttledSend(peerId, peer, data, bytesLength);
      }
    }
  }

  /**
   * Send a message to a specific peer.
   */
  sendTo(peerId: PeerId, message: { type: string; payload: string | Uint8Array }): void {
    const peer = this.peers.get(peerId);
    if (peer?.connected) {
      const data = JSON.stringify(message);
      const bytesLength = typeof TextEncoder !== "undefined" ? new TextEncoder().encode(data).length : data.length;
      this.throttledSend(peerId, peer, data, bytesLength);
    }
  }

  /**
   * Send data with reputation-based throttling.
   */
  private throttledSend(peerId: PeerId, peer: SimplePeer.Instance, data: string, bytesLength: number): void {
    const info = this.peerInfo.get(peerId);
    const rep = info ? info.reputation : 1.0;

    if (rep > 0.5) {
      peer.send(data);
      this.updateReputation(peerId, 0, bytesLength);
    } else {
      // Throttle peers with low reputation (0.0 to 0.5)
      // Delay scales from 500ms (rep 0.5) to 1000ms (rep 0.0)
      const delay = Math.floor((1 - rep) * 1000);
      const peerState = peer as any;
      
      if (!peerState._sendQueue) peerState._sendQueue = [];
      
      // Prevent memory exhaustion DoS
      if (peerState._sendQueue.length > 50) {
        console.warn(`[ZerithDB] Dropping messages to leech peer ${peerId} (queue full)`);
        return;
      }
      
      peerState._sendQueue.push({ data, bytesLength });
      
      // Ensure only one timer is running per peer
      if (!peerState._sendTimer) {
        const drain = () => {
          if (!peer.connected) {
            peerState._sendTimer = null;
            return;
          }
          
          const msg = peerState._sendQueue.shift();
          if (msg) {
            peer.send(msg.data);
            this.updateReputation(peerId, 0, msg.bytesLength);
          }
          
          if (peerState._sendQueue.length > 0) {
            peerState._sendTimer = setTimeout(drain, delay);
          } else {
            peerState._sendTimer = null;
          }
        };
        
        peerState._sendTimer = setTimeout(drain, delay);
      }
    }
  }

  /**
   * Update a peer's reputation based on data given/taken.
   */
  private updateReputation(peerId: PeerId, downloaded: number, uploaded: number): void {
    const info = this.peerInfo.get(peerId);
    if (!info) return;

    info.bytesDownloaded += downloaded;
    info.bytesUploaded += uploaded;

    // Grace period: first 1MB of download is "free"
    const GRACE_BYTES = 1024 * 1024; // 1 MB
    if (info.bytesDownloaded === 0 || info.bytesDownloaded < GRACE_BYTES) {
      info.reputation = 1.0;
    } else {
      // Give / Take ratio (safeguarded against division by zero)
      info.reputation = info.bytesDownloaded > 0 ? info.bytesUploaded / info.bytesDownloaded : 1.0;
    }

    // Leech protection: Disconnect if taking > 5MB and giving < 5%
    const LEECH_THRESHOLD = 0.05;
    const DISCONNECT_BYTES = 5 * 1024 * 1024; // 5 MB
    
    if (info.bytesDownloaded > DISCONNECT_BYTES && info.reputation < LEECH_THRESHOLD) {
      console.warn(`[ZerithDB] Disconnecting leech peer ${peerId}. Reputation: ${info.reputation}`);
      const peer = this.peers.get(peerId);
      if (peer) {
        peer.destroy(); // This triggers 'close' event and cleanup
      }
    }
  }

  // Replaced by sendTo above

  /** Number of currently connected peers */
  get connectedPeerCount(): number {
    let count = 0;
    for (const [, peer] of this.peers) {
      if (peer.connected) count++;
    }
    return count;
  }

  /** List of all connected peer infos */
  get connectedPeers(): PeerInfo[] {
    return [...this.peerInfo.values()];
  }

  /**
   * Reads `bufferedAmount` from each peer's WebRTC data channel.
   * Used by the DevTools memory collector.
   */
  getBufferStats(): WebRtcBufferStats {
    const peers: WebRtcBufferStats["peers"] = [];
    let bufferedBytes = 0;

    for (const [peerId, peer] of this.peers) {
      const channel = (peer as SimplePeerWithChannel)._channel;
      if (!peer.connected || channel === undefined) continue;

      const bufferedAmount = channel.bufferedAmount;
      peers.push({ peerId, bufferedAmount });
      bufferedBytes += bufferedAmount;
    }

    return {
      peerCount: peers.length,
      bufferedBytes,
      peers,
    };
  }

  // ─── Media stream API (WebRTC media tracks) ───────────────────────────────

  /**
   * Publish a local MediaStream to all connected peers.
   * Returns the normalised metadata record for this stream.
   *
   * @see {@link VideoConferenceManager.publishStream}
   */
  addMediaStream(
    stream: MediaStream,
    metadata: MediaStreamMetadataInput = {}
  ): MediaStreamMetadata {
    return {
      streamId: stream.id,
      label: typeof metadata.label === "string" ? metadata.label : undefined,
      audioMuted: false,
      videoMuted: false,
      tracks: stream
        .getTracks()
        .map((t) => ({ kind: t.kind as "audio" | "video", muted: !t.enabled })),
      ...metadata,
    };
  }

  /**
   * Stop sending a local MediaStream to peers.
   */
  removeMediaStream(_streamOrId: MediaStream | string): void {
    // no-op — full implementation tracked separately
  }

  /**
   * Update metadata for a stream that has already been published.
   * Returns the updated metadata, or `undefined` if the stream is not found.
   */
  updateMediaStreamMetadata(
    _streamId: string,
    _metadata: MediaStreamMetadataInput
  ): MediaStreamMetadata | undefined {
    return undefined;
  }

  /**
   * Enable or disable audio/video tracks in a published stream.
   */
  setMediaTrackEnabled(_kind: "audio" | "video", _enabled: boolean, _streamId?: string): void {
    // no-op — full implementation tracked separately
  }

  /**
   * Returns metadata for all locally published streams.
   */
  getLocalMediaStreamMetadata(): MediaStreamMetadata[] {
    return [];
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.stopPeerHealthCheck();
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    for (const [, peer] of this.peers) {
      peer.destroy();
    }
    this.peers.clear();
    this.peerInfo.clear();
    this.knownPeerIds.clear();
    this.peerCreationTimes.clear();
    if (this.transport !== null) {
      this.transport.close();
      this.transport = null;
    }
    this.activeTransportType = null;
  }


  // ─── Private — Transport setup ────────────────────────────────────────────

  private async connectWebSocket(signalingUrl: string, roomId: string): Promise<void> {
    const proofOfWork = await this.createProofOfWork(signalingUrl, roomId);
    const url = new URL(signalingUrl);
    url.searchParams.set("room", roomId);
    url.searchParams.set("peer", this.localPeerId);
    if (proofOfWork !== null) {
      url.searchParams.set("powChallenge", proofOfWork.challenge);
      url.searchParams.set("powNonce", proofOfWork.nonce);
    }

    const wsTransport = new WebSocketTransport();
    await wsTransport.connect(url.toString(), 5000);

    this.attachTransport(wsTransport, roomId);
    this.activeTransportType = "websocket";
    this.reconnectAttempts = 0;
  }

  private async connectPolling(signalingUrl: string, roomId: string): Promise<void> {
    const httpUrl = this.wsUrlToHttp(signalingUrl);
    const proofOfWork = await this.createProofOfWork(signalingUrl, roomId);

    const pollTransport = new PollingTransport(httpUrl);
    await pollTransport.connect(roomId, this.localPeerId, proofOfWork);

    this.attachTransport(pollTransport, roomId);
    this.activeTransportType = "polling";
    this.reconnectAttempts = 0;
  }

  private attachTransport(transport: SignalingTransport, roomId: string): void {
    if (this.transport !== null) {
      this.transport.close();
    }

    this.transport = transport;

    transport.onMessage((data: string) => {
      this.handleSignalingMessage(JSON.parse(data) as SignalingMessage);
    });

    transport.onClose(() => {
      this.stopPeerHealthCheck();
      if (!this.disposed && this.config.network?.autoReconnect !== false) {
        this.scheduleReconnect(roomId);
      }
    });

    transport.onError((err) => {
      console.error("[ZerithDB] Signaling transport error:", err);
    });

    // Start the self-healing peer mesh scan now that the transport is live
    this.startPeerHealthCheck();
  }

  private wsUrlToHttp(wsUrl: string): string {
    if (wsUrl.startsWith("wss://")) {
      return "https://" + wsUrl.slice(6);
    }
    if (wsUrl.startsWith("ws://")) {
      return "http://" + wsUrl.slice(5);
    }
    return wsUrl;
  }

  // ─── Private — Signaling message handling ─────────────────────────────

  private async handleSignalingMessage(msg: SignalingMessage): Promise<void> {
    // ─── Identity enrichment (Phase 1) ───
    // Attach human-readable name if provided during signaling
    if (msg.from && msg.name) {
      const existing = this.peerInfo.get(msg.from);

      this.peerInfo.set(msg.from, {
        ...(existing ?? {
          peerId: msg.from,
          did: "",
          publicKey: "",
          connectedAt: Date.now(),
          bytesDownloaded: 0,
          bytesUploaded: 0,
          reputation: 1.0,
        }),
        name: msg.name ?? existing?.name,
        ens: msg.ens ?? existing?.ens,
      });

      this.nameRegistry.register({
        name: msg.name,
        peerId: msg.from,
        ens: msg.ens,
        timestamp: Date.now(),
      });
    }

  private handleSignalingMessage(msg: SignalingMessage): void {
    switch (msg.type) {
      case "announcement":
        console.warn(`[ZerithDB] System Announcement: ${msg.payload}`);
        this.emit("announcement", msg.payload as string);
        break;

      case "peer-list":
        for (const peerId of msg.payload as PeerId[]) {
          if (peerId !== this.localPeerId) {
            this.knownPeerIds.add(peerId);
            // Deterministic initiator: only smaller ID initiates connection.
            // Larger ID sends an introduction so the smaller ID learns they exist.
            if (this.localPeerId < peerId) {
              this.createPeer(peerId, true);
            } else {
              this.transport?.send(
                JSON.stringify({
                  type: "intro",
                  from: this.localPeerId,
                  to: peerId,
                })
              );
            }
          }

          const existing = this.peerInfo.get(msg.from);

          this.peerInfo.set(msg.from, {
            ...(existing ?? {
              peerId: msg.from,
              did: "",
              publicKey: "",
              connectedAt: Date.now(),
              bytesDownloaded: 0,
              bytesUploaded: 0,
              reputation: 1.0,
            }),
            name: msg.name ?? existing?.name,
            ens: msg.ens ?? existing?.ens,
          });
        }
        break;

      case "intro":
        if (msg.to === this.localPeerId) {
          this.knownPeerIds.add(msg.from);
          // Since we received intro, we must be the smaller ID (initiator).
          // Initiate connection if we haven't already.
          if (this.localPeerId < msg.from) {
            this.createPeer(msg.from, true);
          }
        }
        break;

      case "offer":
        if (msg.to === this.localPeerId) {
          this.knownPeerIds.add(msg.from);
          const existingPeer = this.peers.get(msg.from);
          if (existingPeer) {
            existingPeer.destroy();
            this.peers.delete(msg.from);
            this.peerInfo.delete(msg.from);
          }
          this.createPeer(msg.from, false, msg.payload);
        }
        break;

      case "answer":
        this.peers.get(msg.from)?.signal(msg.payload as any);
        break;

      case "ice-candidate":
        this.peers.get(msg.from)?.signal(msg.payload as any);
        break;
    }
  }

  private createPeer(remotePeerId: PeerId, initiator: boolean, offerPayload?: unknown): void {
    if (this.peers.has(remotePeerId)) return;

    const maxPeers = this.config.sync?.maxPeers ?? 10;
    if (this.peers.size >= maxPeers) return;

    this.peerCreationTimes.set(remotePeerId, Date.now());

    const peer = new SimplePeer({
      initiator,
      trickle: true,
      config: {
        iceServers: this.config.sync?.iceServers ?? [
          { urls: "stun:stun.l.google.com:19302" },
          { urls: "stun:stun1.l.google.com:19302" },
        ],
      },
    });

    if (!initiator && offerPayload !== undefined) {
      peer.signal(offerPayload as any);
    }

    peer.on("signal", (data) => {
      // simple-peer fires 'signal' for offers, answers, AND trickle ICE candidates.
      // We must use data.type to send the correct signaling message type.
      const signalingType =
        data.type === "offer" ? "offer" : data.type === "answer" ? "answer" : "ice-candidate";
      this.transport?.send(
        JSON.stringify({
          type: signalingType,
          from: this.localPeerId,
          to: remotePeerId,
          payload: data,
        })
      );
    });

    peer.on("connect", () => {
      const info: PeerInfo = {
        peerId: remotePeerId,
        did: "",
        publicKey: "",
        connectedAt: Date.now(),
        bytesDownloaded: 0,
        bytesUploaded: 0,
        reputation: 1.0,
      };
      this.peerInfo.set(remotePeerId, info);
      this.emit("peer:connected", info);
    });

    peer.on("data", (data: Uint8Array | string) => {
      try {
        const bytesLength = typeof data === "string" 
          ? (typeof TextEncoder !== "undefined" ? new TextEncoder().encode(data).length : data.length)
          : data.byteLength;
        this.updateReputation(remotePeerId, bytesLength, 0);

        const msg = JSON.parse(
          typeof data === "string" ? data : new TextDecoder().decode(data)
        ) as { type: string; payload: string | Uint8Array };
        this.emit("message", { ...msg, from: remotePeerId });
      } catch {
        // Ignore malformed messages
      }
    });

    peer.on("close", () => {
      this.peers.delete(remotePeerId);
      this.peerInfo.delete(remotePeerId);
      this.peerCreationTimes.delete(remotePeerId);
      this.emit("peer:disconnected", { peerId: remotePeerId });
    });

    peer.on("error", (err: Error) => {
      this.emit("error", { peerId: remotePeerId, error: err });
      this.peers.delete(remotePeerId);
      this.peerInfo.delete(remotePeerId);
      this.peerCreationTimes.delete(remotePeerId);
    });

    this.peers.set(remotePeerId, peer);
  }


  addMediaStream(
    stream: MediaStream,
    metadata: MediaStreamMetadataInput = {}
  ): MediaStreamMetadata {
    const normalized = this.buildMediaStreamMetadata(stream, metadata);

    this.localStreams.set(stream.id, stream);
    this.localStreamMetadata.set(stream.id, normalized);

    for (const [, peer] of this.peers) {
      peer.addStream(stream);
    }

    this.broadcastMediaStreamMetadata(normalized);
    return normalized;
  }

  /**
   * Stop publishing a local stream and notify peers that its metadata is gone.
   */
  removeMediaStream(streamOrId: MediaStream | string): void {
    const streamId = typeof streamOrId === "string" ? streamOrId : streamOrId.id;
    const stream = typeof streamOrId === "string" ? this.localStreams.get(streamId) : streamOrId;

    if (stream !== undefined) {
      for (const [, peer] of this.peers) {
        peer.removeStream(stream);
      }
    }

    this.localStreams.delete(streamId);
    this.localStreamMetadata.delete(streamId);
    this.broadcast({
      type: "media-stream-removed",
      payload: JSON.stringify({ streamId }),
    });
  }

  /**
   * Update metadata for an already published local stream.
   */
  updateMediaStreamMetadata(
    streamId: string,
    metadata: MediaStreamMetadataInput
  ): MediaStreamMetadata | undefined {
    const stream = this.localStreams.get(streamId);
    if (stream === undefined) return undefined;

    const previous = this.localStreamMetadata.get(streamId);
    const next = this.buildMediaStreamMetadata(stream, {
      ...previous,
      ...metadata,
    });

    this.localStreamMetadata.set(streamId, next);
    this.broadcastMediaStreamMetadata(next);
    return next;
  }

  /**
   * Enable or disable local audio/video tracks and publish fresh stream metadata.
   */
  setMediaTrackEnabled(kind: "audio" | "video", enabled: boolean, streamId?: string): void {
    const entries =
      streamId === undefined
        ? [...this.localStreams.entries()]
        : [...this.localStreams.entries()].filter(([id]) => id === streamId);

    for (const [id, stream] of entries) {
      const tracks = kind === "audio" ? stream.getAudioTracks() : stream.getVideoTracks();
      for (const track of tracks) {
        track.enabled = enabled;
      }
      this.updateMediaStreamMetadata(id, {});
    }
  }

  /** Replace a track in every peer connection that receives a local stream. */
  replaceMediaTrack(
    streamId: string,
    oldTrack: MediaStreamTrack,
    newTrack: MediaStreamTrack
  ): void {
    const stream = this.localStreams.get(streamId);
    if (stream === undefined) return;

    for (const [, peer] of this.peers) {
      if (peer.connected) {
        peer.replaceTrack(oldTrack, newTrack, stream);
      }
    }
    this.updateMediaStreamMetadata(streamId, {});
  }

  /** Snapshot of local streams currently published to the mesh. */
  getLocalMediaStreams(): MediaStream[] {
    return [...this.localStreams.values()];
  }

  /** Snapshot of local stream metadata currently published to the mesh. */
  getLocalMediaStreamMetadata(streamId?: string): MediaStreamMetadata[] {
    if (streamId !== undefined) {
      const metadata = this.localStreamMetadata.get(streamId);
      return metadata === undefined ? [] : [metadata];
    }
    return [...this.localStreamMetadata.values()];
  }

  /** Snapshot of remote streams received from peers. */
  getRemoteMediaStreams(peerId?: PeerId): Array<{ peerId: PeerId; stream: MediaStream }> {
    const result: Array<{ peerId: PeerId; stream: MediaStream }> = [];
    for (const [remotePeerId, streams] of this.remoteStreams) {
      if (peerId !== undefined && remotePeerId !== peerId) continue;
      for (const [, stream] of streams) {
        result.push({ peerId: remotePeerId, stream });
      }
    }
    return result;
  }

  private handlePeerMessage(
    remotePeerId: PeerId,
    msg: { type: string; payload: string | Uint8Array }
  ): void {
    if (msg.type === "media-stream-metadata" && typeof msg.payload === "string") {
      const metadata = JSON.parse(msg.payload) as MediaStreamMetadata;
      let peerMetadata = this.remoteStreamMetadata.get(remotePeerId);
      if (peerMetadata === undefined) {
        peerMetadata = new Map();
        this.remoteStreamMetadata.set(remotePeerId, peerMetadata);
      }
      peerMetadata.set(metadata.streamId, metadata);
      this.emit("media:stream:metadata", { peerId: remotePeerId, metadata });
      return;
    }

    if (msg.type === "media-stream-removed" && typeof msg.payload === "string") {
      const payload = JSON.parse(msg.payload) as { streamId: string };
      this.remoteStreams.get(remotePeerId)?.delete(payload.streamId);
      this.remoteStreamMetadata.get(remotePeerId)?.delete(payload.streamId);
      this.emit("media:stream:removed", { peerId: remotePeerId, streamId: payload.streamId });
    }
  }

  private rememberRemoteStream(remotePeerId: PeerId, stream: MediaStream): void {
    let streams = this.remoteStreams.get(remotePeerId);
    if (streams === undefined) {
      streams = new Map();
      this.remoteStreams.set(remotePeerId, streams);
    }
    streams.set(stream.id, stream);
  }

  private broadcastMediaStreamMetadata(metadata: MediaStreamMetadata): void {
    this.broadcast({
      type: "media-stream-metadata",
      payload: JSON.stringify(metadata),
    });
  }

  private buildMediaStreamMetadata(
    stream: MediaStream,
    metadata: MediaStreamMetadataInput
  ): MediaStreamMetadata {
    const tracks = stream.getTracks().map((track) => ({
      trackId: track.id,
      kind: track.kind as "audio" | "video",
      label: track.label,
      enabled: track.enabled,
      muted: track.muted,
      readyState: track.readyState,
    }));

    const audioTracks = tracks.filter((track) => track.kind === "audio");
    const videoTracks = tracks.filter((track) => track.kind === "video");
    return {
      ...metadata,
      streamId: stream.id,
      peerId: this.localPeerId,
      kind: metadata.kind ?? "camera",
      audioMuted: audioTracks.length > 0 && audioTracks.every((track) => !track.enabled),
      videoMuted: videoTracks.length > 0 && videoTracks.every((track) => !track.enabled),
      tracks,
      updatedAt: Date.now(),
    };
  }

  private scheduleReconnect(roomId: string): void {
    const urls = this.getSignalingUrls();
    const delay = this.config.network?.reconnectDelay ?? 1000;
    const backoff = Math.min(delay * 2 ** this.reconnectAttempts, 30_000);
    // Eliminate jitter during tests (when reconnectDelay is very small, e.g. < 100ms)
    const jitter = delay < 100 ? 0 : Math.random() * 1000;

    this.currentUrlIndex = (this.currentUrlIndex + 1) % urls.length;
    this.reconnectAttempts++;

    this.reconnectTimer = setTimeout(() => {
      void this.connect(roomId);
    }, backoff + jitter);
  }

}
