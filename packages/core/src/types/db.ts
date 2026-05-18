/**
 * Unique identifier for a document.
 * - UUID v7 string (default — globally unique, sortable by insertion time)
 * - Auto-incrementing integer (opt-in via `{ idStrategy: "autoincrement" }`)
 */
export type DocumentId = string | number;

/** Name of a collection within ZerithDB */
export type CollectionName = string;

/** Metadata fields added to every document by ZerithDB */
type Metadata = {
  _id: DocumentId;
  /** Created-at timestamp in Unix milliseconds */
  _createdAt: number;
  /** Last-updated-at timestamp in Unix milliseconds */
  _updatedAt: number;
  /** Vector clock tracking causal dependencies per peer */
  _vclock: Record<string, number>;
  /** Lamport timestamp used for fallback conflict resolution */
  _lamport: number;
  /** Tombstone marker for logical deletes during P2P sync */
  _deleted?: boolean;
};

/** Internal helper to safely merge schema and metadata fields */
type MergeDocument<T extends Record<string, any>> = {
  [K in keyof T | keyof Metadata]: K extends keyof Metadata
    ? Metadata[K]
    : K extends keyof T
      ? T[K]
      : never;
};

/** Base document shape. All stored documents have metadata fields added automatically. */
export type Document<T extends Record<string, any> = Record<string, any>> = MergeDocument<T>;

/**
 * MongoDB-style query filter operators.
 * Supports filtering on both schema fields and metadata.
 */
export type QueryFilter<T extends Record<string, any>> = {
  [K in keyof Document<T>]?:
    | Document<T>[K]
    | { $eq: Document<T>[K] }
    | { $ne: Document<T>[K] }
    | { $gt: Document<T>[K] }
    | { $gte: Document<T>[K] }
    | { $lt: Document<T>[K] }
    | { $lte: Document<T>[K] }
    | { $in: Document<T>[K][] }
    | { $nin: Document<T>[K][] }
    | { $regex: RegExp | string };
};

/** Partial update spec — only user-defined fields are modified */
export type UpdateSpec<T extends Record<string, any>> = {
  $set?: Partial<T>;
  $unset?: { [K in keyof T]?: true };
};

export type InsertResult = {
  id: DocumentId;
};

export type QueryOptions<T extends Record<string, any> = Record<string, any>> = {
  limit?: number;

  /**
   * Number of matching documents to skip.
   * `offset` is kept for backward compatibility.
   */
  skip?: number;
  offset?: number;

  /**
   * Sort matching documents by field.
   */
  sort?: {
    field: keyof Document<T>;
    order?: "asc" | "desc";
  };
};

export type FindResult<T extends Record<string, any>> = {
  documents: Document<T>[];
  count: number;
};

/**
 * A generic schema validator interface.
 * Any object with a `parse(data: unknown): T` method satisfies this interface.
 * This is compatible with Zod schemas out of the box:
 *
 * @example
 * ```typescript
 * import { z } from "zod";
 * const schema = z.object({ text: z.string(), done: z.boolean() });
 * const todos = app.db("todos", { schema });
 * ```
 */
export interface SchemaValidator<T> {
  parse(data: unknown): T;
}

/**
 * Options for configuring a collection instance.
 */
export interface CollectionOptions<T extends Record<string, any>> {
  /** Optional schema validator. If provided, all inserts and updates are validated before being written. */
  schema?: SchemaValidator<T>;
}
