import { expect, test } from "vitest";
import "fake-indexeddb/auto";
import { deleteDB } from "idb";
import { IndexedDBKvPrimitives } from "./indexeddb_kv_primitives.ts";
import { allTests } from "./kv_primitives.test.ts";

test("Test IDB key primitives", async () => {
  const db = new IndexedDBKvPrimitives("test");
  await db.init();
  await allTests(db);
  db.close();
});

async function databaseNames() {
  return (await indexedDB.databases()).map((db) => db.name);
}

test("clear() on a disposable database drops it and keeps working", async () => {
  const db = new IndexedDBKvPrimitives("disposable", {
    disposable: { canReconnect: () => true },
  });
  await db.init();
  await db.batchSet([{ key: ["a"], value: 1 }]);

  await db.clear();
  expect(await db.batchGet([["a"]])).toEqual([undefined]);
  await db.batchSet([{ key: ["b"], value: 2 }]);
  expect(await db.batchGet([["b"]])).toEqual([2]);
  db.close();
});

test("other connections reopen a disposable database dropped elsewhere", async () => {
  const options = { disposable: { canReconnect: () => true } };
  const mine = new IndexedDBKvPrimitives("shared-disposable", options);
  const other = new IndexedDBKvPrimitives("shared-disposable", options);
  await mine.init();
  await other.init();
  await other.batchSet([{ key: ["a"], value: 1 }]);

  await mine.clear();
  expect(await other.batchGet([["a"]])).toEqual([undefined]);
  await other.batchSet([{ key: ["b"], value: 2 }]);
  expect(await mine.batchGet([["b"]])).toEqual([2]);
  mine.close();
  other.close();
});

test("a disposable database is not recreated when reconnecting is refused", async () => {
  let canReconnect = true;
  const db = new IndexedDBKvPrimitives("refused-disposable", {
    disposable: { canReconnect: () => canReconnect },
  });
  await db.init();
  await db.batchSet([{ key: ["a"], value: 1 }]);

  // As on logout: the database is deleted for good
  canReconnect = false;
  await deleteDB("refused-disposable");
  await expect(db.batchSet([{ key: ["b"], value: 2 }])).rejects.toThrow(
    "was deleted",
  );
  expect(await databaseNames()).not.toContain("refused-disposable");
});

test("operations racing a disposable clear() wait for it instead of failing", async () => {
  const db = new IndexedDBKvPrimitives("racing-disposable", {
    disposable: { canReconnect: () => true },
  });
  await db.init();
  await db.batchSet([{ key: ["a"], value: 1 }]);

  const before = db.batchGet([["a"]]);
  const cleared = db.clear();
  const after = db.batchGet([["a"]]);
  await cleared;
  expect(await before).toEqual([1]);
  expect(await after).toEqual([undefined]);
  db.close();
});

test("wasDeleted reports a database deleted by another window", async () => {
  const db = new IndexedDBKvPrimitives("deleted-elsewhere");
  await db.init();
  expect(db.wasDeleted).toBe(false);
  await deleteDB("deleted-elsewhere");
  expect(db.wasDeleted).toBe(true);
});

test("a reopen that keeps failing fails operations instead of hanging", async () => {
  const db = new IndexedDBKvPrimitives("failing-reopen", {
    disposable: { canReconnect: () => true },
  });
  await db.init();
  const init = db.init.bind(db);
  db.init = () => Promise.reject(new Error("quota exceeded"));
  await expect(db.clear()).rejects.toThrow("quota exceeded");
  await expect(db.batchGet([["a"]])).rejects.toThrow("quota exceeded");
  // Recovers once opening works again
  db.init = init;
  expect(await db.batchGet([["a"]])).toEqual([undefined]);
  db.close();
});

test("close() during a pending reopen leaves no open connection", async () => {
  const db = new IndexedDBKvPrimitives("close-during-reopen", {
    disposable: { canReconnect: () => true },
  });
  await db.init();
  const cleared = db.clear();
  db.close();
  await cleared;
  // A live connection would accept a new transaction
  expect(() => db.db.transaction("data", "readonly")).toThrow();
});

test("a batch write that fails part way writes nothing", async () => {
  const db = new IndexedDBKvPrimitives("atomic-batch");
  await db.init();
  await db.batchSet([{ key: ["kept"], value: 1 }]);

  // Functions cannot be stored: the second put throws
  await expect(
    db.batchSet([
      { key: ["a"], value: 1 },
      { key: ["b"], value: () => {} },
    ]),
  ).rejects.toThrow();
  await expect(
    db.batchSet([
      { key: ["c"], value: 1 },
      { key: ["d", 1 as any], value: 1 },
    ]),
  ).rejects.toThrow("Key needs to consists of strings");
  expect(await db.batchGet([["kept"], ["a"], ["c"]])).toEqual([
    1,
    undefined,
    undefined,
  ]);

  await db.batchDelete([["kept"]]);
  expect(await db.batchGet([["kept"]])).toEqual([undefined]);
  db.close();
});
