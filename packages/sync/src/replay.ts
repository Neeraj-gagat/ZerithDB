import type { DbClient } from "zerithdb-db";
import type { SyncLog } from "zerithdb-core";

/**
 * Utility for Conflict Replay Debugging.
 * Allows developers to inspect historical conflicts and their resolutions.
 */
export class ConflictReplayManager {
  constructor(private readonly db: DbClient) {}

  /**
   * Retrieves all recorded sync logs (conflicts and resolutions).
   */
  async getLogs(): Promise<SyncLog[]> {
    return await this.db.getSyncLogs();
  }

  /**
   * Replays a specific conflict to analyze the resolution logic.
   * Useful for debugging custom merge policies.
   */
  async debugConflict(logId: string): Promise<{
    local: any;
    remote: any;
    resolved: any;
    strategy: string;
  } | undefined> {
    const logs = await this.getLogs();
    const log = logs.find(l => (l as any)._id === logId || l.docId === logId);
    
    if (!log) return undefined;
    
    return {
      local: log.localDoc,
      remote: log.remoteDoc,
      resolved: log.resolvedDoc,
      strategy: log.strategy
    };
  }

  /**
   * Clears the sync logs.
   */
  async clearLogs(): Promise<void> {
    // Note: We'd need to add a clear method to DbClient if we wanted this
    // but for now we can just leave them.
  }
}
