import type { KvPrimitives, KvQueryOptions } from "./kv_primitives.ts";
import { deleteDB, type IDBPDatabase, openDB, unwrap } from "idb";

import type { KV, KvKey } from "../../plug-api/types/datastore.ts";

const sep = "\0";
const objectStoreName = "data";
// Rows per `query` chunk: the first chunk covers a message queue poll, later
// ones double up to the maximum
const minQueryChunk = 16;
const maxQueryChunk = 1024;

export type IndexedDBKvOptions = {
  /**
   * For a database holding only disposable data, such as the object index:
   * `clear()` deletes the whole database, which unlike clearing a store does
   * not take time proportional to its size. Once the database was deleted, by
   * this or another window, connections reopen it on next use, as long as
   * `canReconnect` allows it.
   */
  disposable?: { canReconnect: () => boolean };
};

/**
 * Per-session counters of IndexedDB traffic, for boot/perf analysis. Exposed
 * as globalThis.sbIdbStats (also inside the service worker's context).
 */
export const idbStats = {
  batchGetCalls: 0,
  keysRequested: 0,
  scans: 0,
  rowsScanned: 0,
  writes: 0,
};
(globalThis as any).sbIdbStats = idbStats;

export class IndexedDBKvPrimitives implements KvPrimitives {
  db!: IDBPDatabase<any>;
  // Pending deletion and reopening of a disposable database, which
  // operations wait for
  private reopening?: Promise<void>;
  // The connection was closed because the database was deleted (or reopening
  // it failed); a disposable database reopens it on next use
  private deleted = false;
  // Closed by its owner: stays closed, even when a reopen was pending
  private closed = false;

  constructor(
    private dbName: string,
    private options: IndexedDBKvOptions = {},
  ) {}

  /**
   * True once another window deleted this database, as on logout, until this
   * connection reopens it
   */
  get wasDeleted(): boolean {
    return this.deleted;
  }

  async init() {
    const db: IDBPDatabase<any> = await openDB(this.dbName, 1, {
      blocking: (_currentVersion, blockedVersion) => {
        // Close the connection the event is for, which a reopen may have
        // replaced since
        db.close();
        // No new version: another window is deleting the database
        if (blockedVersion === null && this.db === db) {
          this.deleted = true;
        }
      },
      upgrade: (db) => {
        db.createObjectStore(objectStoreName);
      },
    });
    this.db = db;
    this.deleted = false;
  }

  async clear(): Promise<void> {
    if (this.options.disposable) {
      return this.reopen(async () => {
        this.db.close();
        await deleteDB(this.dbName, {
          blocked: () =>
            console.warn("Waiting for other windows to close", this.dbName),
        });
      });
    }
    const tx = await this.transaction("readwrite");
    await Promise.all([tx.store.clear(), tx.done]);
  }

  async batchGet(keys: KvKey[]): Promise<any[]> {
    idbStats.batchGetCalls++;
    idbStats.keysRequested += keys.length;
    const tx = await this.transaction("readonly");
    return Promise.all(keys.map((key) => tx.store.get(this.buildKey(key))));
  }

  async batchSet(entries: KV[]): Promise<void> {
    idbStats.writes += entries.length;
    const keys = entries.map(({ key }) => this.buildKey(key));
    await this.writeBatch((store) => {
      for (let i = 0; i < entries.length; i++) {
        store.put(entries[i].value, keys[i]);
      }
    });
  }

  async batchDelete(keys: KvKey[]): Promise<void> {
    const builtKeys = keys.map((key) => this.buildKey(key));
    await this.writeBatch((store) => {
      for (const key of builtKeys) {
        store.delete(key);
      }
    });
  }

  // One range request instead of reading every key and deleting it
  // individually
  async deletePrefix(prefix: KvKey): Promise<void> {
    const tx = await this.transaction("readwrite");
    await Promise.all([tx.store.delete(this.prefixRange(prefix)), tx.done]);
  }

  /**
   * Reads the range in chunks, each one getAllKeys and one getAll request,
   * instead of a cursor step (a task and microtasks) per row. Chunks start
   * small for callers that stop early, such as the message queue's poll, and
   * grow from there. Each chunk is its own transaction, so consumers may
   * await between rows; writes in between can show up in later chunks.
   */
  async *query({ prefix }: KvQueryOptions): AsyncIterableIterator<KV> {
    idbStats.scans++;
    const range = this.prefixRange(prefix || []);
    let after: string | undefined;
    let chunkSize = minQueryChunk;
    while (true) {
      const tx = await this.transaction("readonly");
      const chunkRange =
        after === undefined
          ? range
          : IDBKeyRange.bound(after, range.upper, true, false);
      const [keys, values] = await Promise.all([
        tx.store.getAllKeys(chunkRange, chunkSize),
        tx.store.getAll(chunkRange, chunkSize),
      ]);
      for (let i = 0; i < keys.length; i++) {
        idbStats.rowsScanned++;
        yield { key: this.extractKey(keys[i] as string), value: values[i] };
      }
      if (keys.length < chunkSize) {
        return;
      }
      after = keys[keys.length - 1] as string;
      chunkSize = Math.min(chunkSize * 2, maxQueryChunk);
    }
  }

  async countQuery({ prefix }: KvQueryOptions): Promise<number> {
    const tx = await this.transaction("readonly");
    prefix = prefix || [];
    return tx.store.count(this.prefixRange(prefix));
  }

  /**
   * Issues the requests on the raw store and awaits only the transaction. A
   * failed request aborts it, so a promise per request (a task and microtasks
   * per row on the main thread) adds nothing.
   */
  private async writeBatch(
    issue: (store: IDBObjectStore) => void,
  ): Promise<void> {
    const tx = await this.transaction("readwrite");
    try {
      issue(unwrap(tx.store));
    } catch (e) {
      // Requests issued so far must not commit
      tx.done.catch(() => {});
      tx.abort();
      throw e;
    }
    await tx.done;
  }

  close() {
    this.closed = true;
    this.db.close();
  }

  /**
   * Starts a transaction once no reopening is pending, reopening a deleted
   * disposable database first. The transaction is created right after that
   * check, without yielding, so a concurrent `clear()` cannot close the
   * connection in between.
   */
  private async transaction<Mode extends IDBTransactionMode>(mode: Mode) {
    while (true) {
      if (this.deleted && !this.reopening && !this.closed) {
        if (!this.options.disposable?.canReconnect()) {
          throw new Error(`Database ${this.dbName} was deleted`);
        }
        void this.reopen(async () => {});
      }
      const pending = this.reopening;
      if (!pending) {
        return this.db.transaction(objectStoreName, mode);
      }
      // A failed reopen fails this operation too; the next one retries
      await pending;
    }
  }

  private reopen(beforeOpen: () => Promise<void>): Promise<void> {
    const reopening = (this.reopening ?? Promise.resolve())
      // A failed earlier reopen must not skip this one
      .catch(() => {})
      .then(beforeOpen)
      .then(() => {
        if (!this.closed) {
          return this.init();
        }
      })
      .catch((e) => {
        // Retried on next use
        this.deleted = true;
        throw e;
      });
    this.reopening = reopening;
    reopening
      .finally(() => {
        if (this.reopening === reopening) {
          this.reopening = undefined;
        }
      })
      .catch(() => {});
    return reopening;
  }

  // All keys under `prefix`, matching whole key parts
  private prefixRange(prefix: KvKey): IDBKeyRange {
    return IDBKeyRange.bound(
      this.buildKey([...prefix, ""]),
      this.buildKey([...prefix, "\uffff"]),
    );
  }

  private buildKey(key: KvKey): string {
    for (const k of key) {
      if (typeof k !== "string") {
        throw new Error(`Key needs to consists of strings: ${key}`);
      }
      if (k.includes(sep)) {
        throw new Error(`Key cannot contain ${sep}`);
      }
    }
    return key.join(sep);
  }

  private extractKey(key: string): KvKey {
    return key.split(sep);
  }
}
