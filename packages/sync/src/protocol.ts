export interface SyncMessage {
  collectionName: string;
  update: Uint8Array;
}

/**
 * Defines how sync updates are encoded and decoded for transmission.
 * Swapping this allows for "hot-reloading" P2P protocols.
 */
export interface SyncProtocol {
  name: string;
  version: string;
  encode(message: SyncMessage): string | Uint8Array;
  decode(payload: string | Uint8Array): SyncMessage | null;
}

/**
 * Default binary protocol for ZerithDB.
 * Encodes: [nameLen (1 byte), collectionName (N bytes), update (M bytes)]
 */
export class DefaultProtocol implements SyncProtocol {
  readonly name = "default";
  readonly version = "1.0.0";

  encode({ collectionName, update }: SyncMessage): Uint8Array {
    const nameBytes = new TextEncoder().encode(collectionName);
    const header = new Uint8Array([nameBytes.length]);
    const combined = new Uint8Array(1 + nameBytes.length + update.length);
    combined.set(header, 0);
    combined.set(nameBytes, 1);
    combined.set(update, 1 + nameBytes.length);
    return combined;
  }

  decode(payload: string | Uint8Array): SyncMessage | null {
    try {
      const bytes = typeof payload === "string" ? this.base64ToBytes(payload) : payload;
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

  private base64ToBytes(b64: string): Uint8Array {
    return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  }
}
