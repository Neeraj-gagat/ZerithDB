import type { SyncProtocol } from "zerithdb-core";

/**
 * Default ZerithDB sync protocol.
 * Encodes messages as: [nameLen (1 byte)] + [collectionName (N bytes)] + [yjsUpdate (M bytes)]
 * Payload is base64 encoded for transmission.
 */
export class DefaultSyncProtocol implements SyncProtocol {
  readonly name = "default";
  readonly version = "1.0.0";

  encode(collectionName: string, update: Uint8Array): string {
    const nameBytes = new TextEncoder().encode(collectionName);
    const header = new Uint8Array([nameBytes.length]);
    const combined = new Uint8Array(1 + nameBytes.length + update.length);
    combined.set(header, 0);
    combined.set(nameBytes, 1);
    combined.set(update, 1 + nameBytes.length);
    return bytesToBase64(combined);
  }

  decode(data: string | Uint8Array): { collectionName: string; update: Uint8Array } | null {
    try {
      const bytes = typeof data === "string" ? base64ToBytes(data) : data;
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
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

export function bytesToBase64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

export function base64ToBytes(b64: string): Uint8Array {
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}
