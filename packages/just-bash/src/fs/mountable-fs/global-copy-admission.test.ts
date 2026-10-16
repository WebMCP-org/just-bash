import { describe, expect, it } from "vitest";
import { InMemoryFs } from "../in-memory-fs/in-memory-fs.js";
import { MountableFs } from "./mountable-fs.js";

/** A virtual backend whose symlinks must remain in its configured namespace. */
class LocalSymlinkFs extends InMemoryFs {
  override symlink(target: string, path: string): Promise<void> {
    if (!target.startsWith("/destination/")) {
      return Promise.reject(
        new Error("EXDEV: symlink target leaves this backend"),
      );
    }
    return super.symlink(target, path);
  }
}

describe("global cross-mount copy admission", () => {
  it("preserves an existing file when the destination rejects the copied link", async () => {
    const source = new InMemoryFs({ "/file": "source" });
    await source.symlink("/source/file", "/link");
    const destination = new LocalSymlinkFs({ "/keep": "keep" });
    const fs = new MountableFs({
      symlinkNamespace: "global",
      mounts: [
        { mountPoint: "/source", filesystem: source },
        { mountPoint: "/destination", filesystem: destination },
      ],
    });
    await expect(fs.cp("/source/link", "/destination/keep")).rejects.toThrow(
      "EXDEV",
    );
    expect(await destination.readFile("/keep")).toBe("keep");
    expect(await source.readFile("/file")).toBe("source");
    expect(await destination.readdir("/")).toEqual(["keep"]);
  });

  it("retains an existing destination link when reading the source fails", async () => {
    const source = new InMemoryFs({
      "/unreadable": () => {
        throw new Error("source unavailable");
      },
    });
    const destination = new InMemoryFs({ "/target": "keep" });
    await destination.symlink("/destination/target", "/link");
    const fs = new MountableFs({
      symlinkNamespace: "global",
      mounts: [
        { mountPoint: "/source", filesystem: source },
        { mountPoint: "/destination", filesystem: destination },
      ],
    });
    await expect(
      fs.cp("/source/unreadable", "/destination/link"),
    ).rejects.toThrow("source unavailable");
    expect(await fs.readlink("/destination/link")).toBe("/destination/target");
    expect(await fs.readFile("/destination/link")).toBe("keep");
    expect(await destination.readdir("/")).toEqual(["link", "target"]);
  });

  it("does not replace a populated destination directory with a source link", async () => {
    const source = new InMemoryFs();
    await source.symlink("/destination/target", "/link");
    const destination = new InMemoryFs({
      "/directory/keep": "keep",
      "/target": "target",
    });
    const fs = new MountableFs({
      symlinkNamespace: "global",
      mounts: [
        { mountPoint: "/source", filesystem: source },
        { mountPoint: "/destination", filesystem: destination },
      ],
    });
    await expect(
      fs.cp("/source/link", "/destination/directory"),
    ).rejects.toThrow("EISDIR");
    expect(await fs.readFile("/destination/directory/keep")).toBe("keep");
  });
});
