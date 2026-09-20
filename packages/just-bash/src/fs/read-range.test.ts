import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { InMemoryFs } from "./in-memory-fs/in-memory-fs.js";
import { OverlayFs } from "./overlay-fs/overlay-fs.js";
import { ReadWriteFs } from "./read-write-fs/read-write-fs.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    fs.rmSync(root, { recursive: true, force: true });
});

describe.each([
  "memory",
  "overlay",
  "read-write",
] as const)("%s byte ranges", (kind) => {
  function setup(maxFileReadSize = 0) {
    const root = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "byte-range-")),
    );
    roots.push(root);
    const bytes = Uint8Array.from({ length: 256 }, (_, i) => i);
    fs.writeFileSync(path.join(root, "data"), bytes);
    const memory = new InMemoryFs({ "/data": bytes });
    const disk =
      kind === "overlay"
        ? new OverlayFs({ root, mountPoint: "/", maxFileReadSize })
        : new ReadWriteFs({ root, maxFileReadSize });
    return { root, fileSystem: kind === "memory" ? memory : disk };
  }

  it("reads binary ranges, EOF, and zero length; rejects invalid ranges and directories", async () => {
    const { fileSystem } = setup();
    expect(await fileSystem.readFileRange("/data", 127, 3)).toEqual(
      new Uint8Array([127, 128, 129]),
    );
    expect(await fileSystem.readFileRange("/data", 254, 10)).toEqual(
      new Uint8Array([254, 255]),
    );
    expect(await fileSystem.readFileRange("/data", 300, 10)).toEqual(
      new Uint8Array(),
    );
    expect(await fileSystem.readFileRange("/data", 0, 0)).toEqual(
      new Uint8Array(),
    );
    await expect(fileSystem.readFileRange("/missing", 0, 0)).rejects.toThrow(
      "ENOENT",
    );
    await expect(fileSystem.readFileRange("/", 0, 0)).rejects.toThrow("EISDIR");
    for (const [offset, length] of [
      [-1, 1],
      [0, -1],
      [0.5, 1],
      [0, NaN],
      [Infinity, 1],
      [Number.MAX_SAFE_INTEGER, 1],
    ]) {
      await expect(
        fileSystem.readFileRange("/data", offset, length),
      ).rejects.toThrow("EINVAL");
    }
  });

  if (kind !== "memory") {
    it("preserves file-size limits and denies symlink escapes", async () => {
      const { fileSystem, root } = setup(128);
      await expect(fileSystem.readFileRange("/data", 0, 1)).rejects.toThrow(
        "EFBIG",
      );
      fs.symlinkSync(os.tmpdir(), path.join(root, "outside"));
      await expect(
        fileSystem.readFileRange("/outside/data", 0, 1),
      ).rejects.toThrow();
    });
  }
});
