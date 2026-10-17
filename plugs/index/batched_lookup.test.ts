import { expect, test } from "vitest";
import { createMockSystem } from "../../plug-api/system_mock.ts";
import { lookupPathsBatched } from "./batched_lookup.ts";

test("concurrent lookups go out as one syscall, each caller gets its own paths", async () => {
  const { space } = createMockSystem();
  await space.writePage("A", "");
  await space.writePage("docs/B", "");

  const calls: string[][] = [];
  const original = (globalThis as any).syscall;
  (globalThis as any).syscall = (name: string, ...args: any[]) => {
    if (name === "space.lookupPaths") calls.push(args[0]);
    return original(name, ...args);
  };
  try {
    const [first, second] = await Promise.all([
      lookupPathsBatched(["A.md"]),
      lookupPathsBatched(["B.md", "A.md"]),
    ]);
    expect(calls).toHaveLength(1);
    expect(Object.keys(first)).toEqual(["A.md"]);
    expect(first["A.md"].exact).toBe(true);
    expect(Object.keys(second).sort()).toEqual(["A.md", "B.md"]);
    expect(second["B.md"].exact).toBe(false);
    expect(second["B.md"].candidates).toEqual(["docs/B.md"]);

    // A lookup after that one went out is a new syscall
    await lookupPathsBatched(["A.md"]);
    expect(calls).toHaveLength(2);
  } finally {
    (globalThis as any).syscall = original;
  }
});
