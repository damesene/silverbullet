import { expect, test } from "vitest";
import type { Client } from "../../client.ts";
import { System } from "../system.ts";
import { editorSyscalls } from "./editor.ts";

function posAtCoordsFor(client: Partial<Client>) {
  const system = new System();
  system.registerSyscalls([], editorSyscalls(client as Client));
  return (x: unknown, y: unknown) =>
    system.localSyscall("editor.posAtCoords", [x, y]);
}

test("editor.posAtCoords asks the editor for the nearest position", async () => {
  const asked: unknown[] = [];
  // No layout in a test DOM: the view's own answer is CodeMirror's to give
  const editorView = {
    posAtCoords: (coords: { x: number; y: number }, precise: boolean) => {
      asked.push({ ...coords, precise });
      return 42;
    },
  };
  const posAt = posAtCoordsFor({ editorView } as unknown as Partial<Client>);
  await expect(posAt(10, 20)).resolves.toBe(42);
  expect(asked).toEqual([{ x: 10, y: 20, precise: false }]);

  await expect(posAt("10", 20)).resolves.toBe(undefined);
  await expect(posAt(10, Number.NaN)).resolves.toBe(undefined);
  await expect(posAt(undefined, undefined)).resolves.toBe(undefined);
  expect(asked).toHaveLength(1);
});

test("editor.posAtCoords returns undefined during boot", async () => {
  const posAt = posAtCoordsFor({});
  await expect(posAt(10, 20)).resolves.toBe(undefined);
});
