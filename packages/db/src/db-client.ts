import { Dexie, type Table, liveQuery } from "dexie";
import { v7 as uuidv7 } from "uuid";

import type {
  ZerithDBConfig,
  Document,
  DocumentId,
  QueryFilter,
  QueryOptions,
  InsertResult,
  UpdateSpec,
  ValidatorRegistry,
} from "zerithdb-core";
import { ZerithDBError, ErrorCode } from "zerithdb-core";
import { BlobManager } from "./blob-manager.js";

/**
 * A handle to a single named collection within the ZerithDB local database.
 * All operations are async and backed by IndexedDB.
 */
export class CollectionClient<T extends Record<string, any> = Record<string, any>> {
  private readonly indexes = new Map<string, IndexState<T>>();
  private readonly docIndexKeys = new Map<DocumentId, Map<string, unknown>>();

  constructor(
    private readonly table: Table<Document<T>>,
    private readonly collectionName: string,
    private readonly blobManager: BlobManager
  ) {}

  private async checkBiometric(operationDescription: string): Promise<void> {
    if (this.auth?.biometric?.isBiometricRequiredForDB()) {
      const authorized = await this.auth.biometric.promptBiometric(
        `Authorize sensitive database operation: ${operationDescription} in collection "${this.collectionName}"`
      );
      if (!authorized) {
        throw new ZerithDBError(
          ErrorCode.AUTH_SIGN_FAILED,
          "Database operation cancelled or biometric authentication failed."
        );
      }
    }
  }

  /**
   * Subscribe to changes in the collection.
   * Uses Dexie's liveQuery to reactively notify when documents change.
   *
   * @param callback - Function called with the updated list of all documents
   * @returns An unsubscribe function
   */
  subscribe(callback: (documents: Document<T>[]) => void): () => void {
    const observable = liveQuery(() => this.find());
    const subscription = observable.subscribe({
      next: (docs) => callback(docs),
      error: (err) => console.error(`Error in collection subscription:`, err),
    });
    return () => subscription.unsubscribe();
  }

  /**
   * Attach a Zod (or compatible) schema to this collection for opt-in validation.
   * Returns `this` so calls can be chained directly after {@link DbClient.collection}.
   *
   * Validation runs before every `insert`, `insertMany`, and `update` call.
   * Collections without a schema continue to work exactly as before.
   *
   * @param schema - Any object with a `parse(data): T` method (e.g. a Zod schema)
   * @returns The same `CollectionClient` instance (fluent API)
   *
   * @example
   * ```typescript
   * import { z } from "zod";
   * const userSchema = z.object({ name: z.string(), age: z.number() });
   * const users = app.db("users").withSchema(userSchema);
   * await users.insert({ name: "Alice", age: 30 }); // validated ✓
   * ```
   */
  withSchema(schema: ZerithSchema<T>): this {
    this.schema = schema;
    return this;
  }

  /**
   * Validates `data` against the attached schema (if any).
   * Throws {@link ZerithValidationError} on failure.
   * @internal
   */
  private validateData(data: unknown, context: string): void {
    if (!this.schema) return;

    // For updates, we try to use a partial version of the schema if it's a Zod schema.
    // This allows $set payload to only contain a subset of fields.
    let schemaToUse = this.schema;
    if (context.startsWith("update") && typeof (this.schema as any).partial === "function") {
      schemaToUse = (this.schema as any).partial();
    }

    try {
      schemaToUse.parse(data);
    } catch (err: unknown) {
      // Check for Zod-shaped error (has `.errors` array)
      if (
        err !== null &&
        typeof err === "object" &&
        "errors" in err &&
        Array.isArray((err as { errors: unknown }).errors)
      ) {
        throw ZerithValidationError.fromZodError(
          err as {
            errors: ReadonlyArray<{ path: ReadonlyArray<string | number>; message: string }>;
          },
          `"${this.collectionName}" — ${context}`
        );
      }
      // Re-throw unknown validation errors as-is
      throw err;
    }
  }

  /**
   * Internal: refresh the underlying Dexie table reference after a schema change.
   */
  setTable(table: Table<Document<T>>): void {
    this.table = table;
  }

  async createIndex(def: IndexDefinition<T>): Promise<void> {
    if (!def.name || typeof def.name !== "string") {
      throw new ZerithDBError(
        ErrorCode.SDK_INVALID_CONFIG,
        "Index name must be a non-empty string."
      );
    }
    if (!def.field || typeof def.field !== "string") {
      throw new ZerithDBError(
        ErrorCode.SDK_INVALID_CONFIG,
        "Index field must be a valid string key."
      );
    }
    if (def.compare !== undefined && typeof def.compare !== "function") {
      throw new ZerithDBError(
        ErrorCode.SDK_INVALID_CONFIG,
        "Index compare must be a function when provided."
      );
    }

    const comparator = (def.compare ?? defaultIndexCompare) as IndexComparator<unknown>;
    const existing = this.indexes.get(def.name);
    if (existing) {
      if (existing.field !== def.field || existing.compare !== comparator) {
        throw new ZerithDBError(
          ErrorCode.SDK_INVALID_CONFIG,
          `Index "${def.name}" already exists with different configuration.`
        );
      }
      return;
    }

    try {
      const docs = await this.table.toArray();
      const entries: IndexEntry[] = docs.map((doc) => ({
        key: (doc as Record<string, unknown>)[def.field as string],
        id: doc._id,
      }));

      if (!def.compare) {
        for (const entry of entries) {
          defaultIndexCompare(entry.key, entry.key);
        }
      }

      entries.sort((a, b) => compareEntries(comparator, a, b));
      this.indexes.set(def.name, {
        name: def.name,
        field: def.field,
        compare: comparator,
        entries,
      });

      for (const entry of entries) {
        if (!this.docIndexKeys.has(entry.id)) {
          this.docIndexKeys.set(entry.id, new Map());
        }
        this.docIndexKeys.get(entry.id)?.set(def.name, entry.key);
      }
    } catch (err) {
      if (err instanceof ZerithDBError && err.code === ErrorCode.SDK_INVALID_CONFIG) {
        throw err;
      }
      throw new ZerithDBError(
        ErrorCode.DB_READ_FAILED,
        `Failed to create index "${def.name}" on "${this.collectionName}"`,
        { cause: err }
      );
    }
  }

  private selectIndex(filter: QueryFilter<T>): { index: IndexState<T>; condition: IndexCondition } | undefined {
    for (const [field, rawCondition] of Object.entries(filter)) {
      const index = [...this.indexes.values()].find((i) => i.field === field);
      if (!index) continue;

      if (rawCondition === null || typeof rawCondition !== "object") {
        return { index, condition: { op: "$eq", value: rawCondition } };
      }

      const ops = rawCondition as Record<string, unknown>;
      if ("$eq" in ops) return { index, condition: { op: "$eq", value: ops["$eq"] } };
      if ("$gt" in ops) return { index, condition: { op: "$gt", value: ops["$gt"] } };
      if ("$gte" in ops) return { index, condition: { op: "$gte", value: ops["$gte"] } };
      if ("$lt" in ops) return { index, condition: { op: "$lt", value: ops["$lt"] } };
      if ("$lte" in ops) return { index, condition: { op: "$lte", value: ops["$lte"] } };
    }
    return undefined;
  }

  private getIndexCandidateIds(index: IndexState<T>, condition: IndexCondition): DocumentId[] {
    const { entries, compare } = index;
    let start = 0;
    let end = entries.length;
    switch (condition.op) {
      case "$gt":
        start = upperBound(entries, condition.value, compare);
        break;
      case "$gte":
        start = lowerBound(entries, condition.value, compare);
        break;
      case "$lt":
        end = lowerBound(entries, condition.value, compare);
        break;
      case "$lte":
        end = upperBound(entries, condition.value, compare);
        break;
      case "$eq":
        start = lowerBound(entries, condition.value, compare);
        end = upperBound(entries, condition.value, compare);
        break;
    }
    return entries.slice(start, end).map((entry) => entry.id);
  }

  private insertIndexEntry(index: IndexState<T>, entry: IndexEntry): void {
    const entries = index.entries;
    let lo = 0;
    let hi = entries.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (compareEntries(index.compare, entries[mid]!, entry) <= 0) {
        lo = mid + 1;
      } else {
        hi = mid;
      }
    }
    entries.splice(lo, 0, entry);
  }

  private findEntryIndex(index: IndexState<T>, key: unknown, id: DocumentId): number {
    const start = lowerBound(index.entries, key, index.compare);
    const end = upperBound(index.entries, key, index.compare);
    for (let i = start; i < end; i += 1) {
      if (index.entries[i]?.id === id) return i;
    }
    return -1;
  }

  private setDocIndexKey(id: DocumentId, indexName: string, key: unknown): void {
    if (!this.docIndexKeys.has(id)) {
      this.docIndexKeys.set(id, new Map());
    }
    this.docIndexKeys.get(id)?.set(indexName, key);
  }

  private removeDocIndexKey(id: DocumentId, indexName: string): void {
    const entry = this.docIndexKeys.get(id);
    if (!entry) return;
    entry.delete(indexName);
    if (entry.size === 0) this.docIndexKeys.delete(id);
  }

  private applyIndexInsert(doc: Document<T>): void {
    for (const index of this.indexes.values()) {
      const key = (doc as Record<string, unknown>)[index.field as string];
      if (index.compare === defaultIndexCompare) {
        defaultIndexCompare(key, key);
      }
      const entry = { key, id: doc._id };
      this.insertIndexEntry(index, entry);
      this.setDocIndexKey(doc._id, index.name, key);
    }
  }

  private applyIndexDelete(doc: Document<T>): void {
    for (const index of this.indexes.values()) {
      const key = this.docIndexKeys.get(doc._id)?.get(index.name);
      if (key === undefined) continue;
      const idx = this.findEntryIndex(index, key, doc._id);
      if (idx >= 0) index.entries.splice(idx, 1);
      this.removeDocIndexKey(doc._id, index.name);
    }
  }

  private applyIndexUpdate(oldDoc: Document<T>, newDoc: Document<T>): void {
    this.applyIndexDelete(oldDoc);
    this.applyIndexInsert(newDoc);
  }

  private async rebuildIndexes(): Promise<void> {
    if (this.indexes.size === 0) return;
    const docs = await this.table.toArray();
    this.docIndexKeys.clear();
    for (const index of this.indexes.values()) {
      const entries: IndexEntry[] = docs.map((doc) => ({
        key: (doc as Record<string, unknown>)[index.field as string],
        id: doc._id,
      }));
      entries.sort((a, b) => compareEntries(index.compare, a, b));
      index.entries = entries;
      for (const entry of entries) {
        this.setDocIndexKey(entry.id, index.name, entry.key);
      }
    }
  }

  /**
   * Insert a new document into the collection.
   * Automatically assigns `_id`, `_createdAt`, and `_updatedAt`.
   */
  async insert(document: T & { _id?: string }): Promise<InsertResult> {
    const now = Date.now();
    const id = document._id || uuidv7();
    const doc: Document<T> = {
      ...document,
      _id: id,
      _createdAt: now,
      _updatedAt: now,
    };

    try {
      this.applyIndexInsert(doc);
      await this.table.add(doc);
      return { id };
    } catch (err) {
      await this.rebuildIndexes();
      throw new ZerithDBError(
        ErrorCode.DB_WRITE_FAILED,
        `Failed to insert into collection "${this.collectionName}"`,
        { cause: err }
      );
    }
  }

  async insertMany(documents: T[]): Promise<InsertResult[]> {
    if (!Array.isArray(documents) || documents.length === 0) {
      throw new ZerithDBError(ErrorCode.DB_WRITE_FAILED, "Documents must be a non-empty array");
    }
    await this.checkBiometric("Bulk Insert Documents");
    
    // Validate each document before writing
    for (let i = 0; i < documents.length; i++) {
      const doc = documents[i];
      if (doc === null || doc === undefined) {
        throw new ZerithDBError(
          ErrorCode.DB_WRITE_FAILED,
          "Documents array cannot contain null or undefined"
        );
      }
      this.validateData(doc, `insertMany[${i}]`);
    }
    const now = Date.now();

    const docs = documents.map((doc) => ({
      ...doc,
      _id: uuidv7(),
      _createdAt: now,
      _updatedAt: now,
    })) as Document<T>[];

    try {
      for (const doc of docs) {
        this.applyIndexInsert(doc);
      }
      await this.table.bulkAdd(docs);
      return docs.map((d) => ({ id: d._id }));
    } catch (err) {
      await this.rebuildIndexes();
      throw new ZerithDBError(
        ErrorCode.DB_WRITE_FAILED,
        `Failed to bulk insert into collection "${this.collectionName}"`,
        { cause: err }
      );
    }
  }

  async find(filter: QueryFilter<T> = {}): Promise<Document<T>[]> {
    try {
      const indexMatch = this.selectIndex(filter);
      if (!indexMatch) {
        const all = await this.table.toArray();
        return all.filter((doc) => this.matchesFilter(doc, filter));
      }

      const { index, condition } = indexMatch;
      const candidateIds = this.getIndexCandidateIds(index, condition);
      if (candidateIds.length === 0) return [];

      const docs = await Promise.all(candidateIds.map((id) => this.table.get(id)));
      const comparatorOverrides = new Map<string, IndexComparator<unknown>>([
        [index.field as string, index.compare],
      ]);

      return (docs as (Document<T> | undefined)[])
        .filter((doc): doc is Document<T> => Boolean(doc))
        .filter((doc) => this.matchesFilter(doc, filter, comparatorOverrides));
    } catch (err) {
      throw new ZerithDBError(
        ErrorCode.DB_READ_FAILED,
        `Failed to query collection "${this.collectionName}"`,
        { cause: err }
      );
    }
  }

  async findById(id: string): Promise<Document<T> | undefined> {
    const table = await this.getTable();
    return wrapIDBOperation(
      ErrorCode.DB_READ_FAILED,
      `Failed to get document "${id}" from "${this.collectionName}"`,
      () => table.get(id)
    );
  }

  async update(filter: QueryFilter<T>, spec: UpdateSpec<T>): Promise<number> {
    try {
      const matches = await this.find(filter);
      const now = Date.now();

      const updatedDocs = matches.map((doc) => ({
        ...doc,
        ...(spec.$set ?? {}),
        _updatedAt: now,
      })) as Document<T>[];

      for (let i = 0; i < matches.length; i++) {
        this.applyIndexUpdate(matches[i]!, updatedDocs[i]!);
      }

      await this.table.bulkPut(updatedDocs);

      return matches.length;
    } catch (err) {
      await this.rebuildIndexes();
      throw new ZerithDBError(
        ErrorCode.DB_WRITE_FAILED,
        `Failed to update documents in "${this.collectionName}"`,
        { cause: err }
      );
    }
  }

  async delete(filter: QueryFilter<T>): Promise<number> {
    try {
      const matches = await this.find(filter);
      for (const doc of matches) {
        this.applyIndexDelete(doc);
      }
      await this.table.bulkDelete(matches.map((d) => d._id));
      return matches.length;
    } catch (err) {
      await this.rebuildIndexes();
      throw new ZerithDBError(
        ErrorCode.DB_DELETE_FAILED,
        `Failed to delete documents from "${this.collectionName}"`,
        { cause: err }
      );
    }
  }

  async clearAll(): Promise<void> {
    try {
      this.docIndexKeys.clear();
      for (const index of this.indexes.values()) {
        index.entries = [];
      }
      await this.table.clear();
    } catch (err) {
      await this.rebuildIndexes();
      throw new ZerithDBError(
        ErrorCode.DB_DELETE_FAILED,
        `Failed to clear collection "${this.collectionName}"`,
        { cause: err }
      );
    }
  }

  /**
   * Count documents matching a filter.
   * Uses Dexie's native count when possible for better performance.
   *
   * @example
   * ```typescript
   * const total = await todos.count();
   * const pending = await todos.count({ done: false });
   * const highPriority = await todos.count({ priority: { $gte: 3 } });
   * ```
   */
  async count(filter: QueryFilter<T> = {}): Promise<number> {
    try {
      // Fast path: no filter - use Dexie's built-in count
      if (Object.keys(filter).length === 0) {
        return await this.table.count();
      }

      // Detect complex operators like $gt, $lt, $in, $nin, etc.
      const hasComplexOps = Object.values(filter).some(
        (v) =>
          v && typeof v === "object" && Object.keys(v).some((k) => k !== "$eq" && k.startsWith("$"))
      );

      // Simple equality filters - filter in memory (fast enough for most datasets)
      if (!hasComplexOps) {
        // Fix: Change type from Table to any or Collection
        let collection: any = this.table;

        for (const [key, value] of Object.entries(filter)) {
          const targetValue =
            value && typeof value === "object" && "$eq" in value ? value.$eq : value;
          collection = collection.filter((doc: Document<T>) => doc[key] === targetValue);
        }

        const allDocs = await collection.toArray();
        return allDocs.length;
      }

      // Complex operators - must fetch all and filter in memory
      const allDocs = await this.table.toArray();
      return allDocs.filter((doc: Document<T>) => this.matchesFilter(doc, filter)).length;
    } catch (err) {
      throw new ZerithDBError(
        ErrorCode.DB_READ_FAILED,
        `Failed to count documents in "${this.collectionName}"`,
        { cause: err }
      );
    }
  }

  /**
   * Upload a large binary object (Blob or Uint8Array) to IPFS.
   * Returns a Content Identifier (CID).
   */
  async putBlob(data: Blob | Uint8Array): Promise<string> {
    return this.blobManager.upload(data);
  }

  /**
   * Download a blob from IPFS by its CID.
   */
  async getBlob(cid: string): Promise<Blob> {
    return this.blobManager.download(cid);
  }

  private matchesFilter(doc: Document<T>, filter: QueryFilter<T>): boolean {
    for (const [key, condition] of Object.entries(filter)) {
      const fieldValue = (doc as Record<string, any>)[key];
      const comparator = comparators?.get(key);

      if (condition === null || typeof condition !== "object") {
        if (value !== condition) return false;
        continue;
      }

      const ops = condition as Record<string, any>;
      if ("$eq" in ops && fieldValue !== ops["$eq"]) return false;
      if ("$ne" in ops && fieldValue === ops["$ne"]) return false;
      if ("$gt" in ops && !(comparator ? comparator(fieldValue, ops["$gt"]) > 0 : (fieldValue as any) > (ops["$gt"] as never)))
        return false;
      if ("$gte" in ops && !(comparator ? comparator(fieldValue, ops["$gte"]) >= 0 : (fieldValue as any) >= (ops["$gte"] as never)))
        return false;
      if ("$lt" in ops && !(comparator ? comparator(fieldValue, ops["$lt"]) < 0 : (fieldValue as any) < (ops["$lt"] as never)))
        return false;
      if ("$lte" in ops && !(comparator ? comparator(fieldValue, ops["$lte"]) <= 0 : (fieldValue as any) <= (ops["$lte"] as never)))
        return false;
      if ("$in" in ops && !(ops["$in"] as unknown[]).includes(fieldValue)) return false;
      if ("$nin" in ops && (ops["$nin"] as unknown[]).includes(fieldValue)) return false;
    }

    return true;
  }

  private applyUpdateSpec(
    doc: Document<T>,
    spec: UpdateSpec<T>,
    now: number
  ): Document<T> {
    return {
      ...doc,
      ...(spec.$set ?? {}),
      _updatedAt: now,
    };
  }
}

/**
 * Internal Dexie subclass that manages dynamic collection creation.
 * Collections are added lazily via schema version upgrades.
 */
class ZerithDBDexie extends Dexie {
  private readonly tableMap = new Map<string, Table>();
  private _currentSchema: Record<string, string> = {};
  private _initPromise: Promise<void> | null = null;
  private _pendingVersion = 0;

  constructor(appId: string) {
    super(`zerithdb_${appId}`);
  }

  /**
   * Ensure a named collection exists, creating it via a Dexie version
   * upgrade if it has not been registered yet.
   *
   * @param name - The collection name to create or retrieve
   * @returns A promise that resolves to the Dexie {@link Table} handle for the collection
   */
  async ensureCollectionAsync(name: string): Promise<Table> {
    if (this.tableMap.has(name)) {
      return this.tableMap.get(name)!;
    }

    return this.tableMap.get(name)!;
  }

  private async _performSchemaUpgrade(name: string): Promise<void> {
    this._currentSchema[name] = "_id, _createdAt, _updatedAt";

    // Obtain the actual database version from IndexedDB
    let actualVersion = this.verno;
    if (!this.isOpen()) {
      try {
        await this.open();
        actualVersion = this.verno;
      } catch (e) {
        // If the DB doesn't exist yet, open() will succeed and set verno to 1
        actualVersion = this.verno || 0;
      }
    }

    // Determine the next version, ensuring it strictly increases
    const nextVersion = Math.max(actualVersion, this._pendingVersion) + 1;
    this._pendingVersion = nextVersion;

    if (this.isOpen()) {
      this.close();
    }

    this.version(nextVersion).stores(this._currentSchema);
    this.tableMap.set(name, this.table(name));

    await this.open();
  }
}

/* ================= CLIENT ================= */

export class DbClient {
  private readonly dexie: ZerithDBDexie;
  private readonly blobManager: BlobManager;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private readonly collections = new Map<string, CollectionClient<any>>();

  constructor(config: ZerithDBConfig) {
    this.dexie = new ZerithDBDexie(config.appId);
    this.blobManager = new BlobManager(config.db);
  }

  collection<T extends Record<string, any>>(name: string): CollectionClient<T> {
    if (!this.collections.has(name)) {
      const table = this.dexie.ensureCollection(name);
      this.collections.set(
        name,
        new CollectionClient<T>(table as Table<Document<T>>, name, this.blobManager)
      );
    }
  }

  async importSnapshot(snapshot: BackupSnapshot, options: { overwrite?: boolean } = {}): Promise<void> {
    return wrapIDBOperation(
      ErrorCode.DB_WRITE_FAILED,
      "Failed to import local backup snapshot",
      async () => {
        if (!snapshot || snapshot.format !== "zerithdb.local-backup.v1") {
          throw new ZerithDBError(
            ErrorCode.DB_INIT_FAILED,
            "Invalid snapshot format. Must be 'zerithdb.local-backup.v1'"
          );
        }

        const overwrite = options.overwrite ?? true;

        for (const [name, documents] of Object.entries(snapshot.collections)) {
          const table = this.dexie.ensureCollection(name);
          if (overwrite) {
            await table.clear();
          }
          if (documents.length > 0) {
            await table.bulkPut(documents);
          }
        }
      }
    );
  }

  async dispose(): Promise<void> {
    // Remove all EventEmitter listeners before closing to prevent memory leaks
    // from dangling references to this DbClient instance after disposal.
    this.removeAllListeners();
    this.dexie.close();
  }
}