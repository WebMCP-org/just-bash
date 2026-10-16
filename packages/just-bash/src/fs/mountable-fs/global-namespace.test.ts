import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { InMemoryFs } from "../in-memory-fs/in-memory-fs.js";
import { OverlayFs } from "../overlay-fs/overlay-fs.js";
import { ReadWriteFs } from "../read-write-fs/read-write-fs.js";
import { MountableFs } from "./mountable-fs.js";

function globalFilesystem() {
  return new MountableFs({
    symlinkNamespace: "global",
    base: new InMemoryFs({
      "/base.txt": "base",
      "/shared/child.txt": "shared",
    }),
    mounts: [
      {
        mountPoint: "/bin",
        filesystem: new InMemoryFs({ "/target.txt": "binary" }),
      },
      {
        mountPoint: "/nested/data",
        filesystem: new InMemoryFs({ "/value.txt": "nested" }),
      },
    ],
  });
}

describe("MountableFs global virtual symlinks", () => {
  it("resolves literal absolute, relative and intermediate targets across mounts", async () => {
    const fs = globalFilesystem();
    await fs.symlink("/bin/target.txt", "/bin/absolute");
    await fs.symlink("target.txt", "/bin/relative");
    await fs.symlink("../base.txt", "/bin/base");
    await fs.symlink("/shared", "/bin/directory");
    await fs.symlink("/nested/data", "/alias");

    expect(await fs.readFile("/bin/absolute")).toBe("binary");
    expect(await fs.readFile("/bin/relative")).toBe("binary");
    expect(await fs.readFile("/bin/base")).toBe("base");
    expect(await fs.readFile("/bin/directory/child.txt")).toBe("shared");
    expect(await fs.readFile("/alias/value.txt")).toBe("nested");
    expect(await fs.realpath("/alias/value.txt")).toBe(
      "/nested/data/value.txt",
    );
    expect(await fs.readlink("/bin/absolute")).toBe("/bin/target.txt");
    expect(await fs.readlink("/bin/relative")).toBe("target.txt");
    expect((await fs.lstat("/bin/absolute")).isSymbolicLink).toBe(true);
  });

  it("routes IO through linked parents without removing the final link target", async () => {
    const fs = globalFilesystem();
    await fs.symlink("/shared", "/bin/directory");
    await fs.writeFile("/bin/directory/new.txt", "abc");
    await fs.appendFile("/bin/directory/new.txt", "def");
    expect(await fs.readFileRange("/bin/directory/new.txt", 1, 3)).toEqual(
      new Uint8Array([98, 99, 100]),
    );
    expect(await fs.readdir("/bin/directory")).toEqual([
      "child.txt",
      "new.txt",
    ]);
    await fs.rm("/bin/directory/new.txt");
    await fs.rm("/bin/directory");
    expect(await fs.readFile("/shared/child.txt")).toBe("shared");
    expect(await fs.exists("/bin/directory")).toBe(false);
  });

  it("retains link text through recursive copies, overwrites, merges and moves", async () => {
    const fs = globalFilesystem();
    await fs.mkdir("/bin/source");
    await fs.symlink("/bin/target.txt", "/bin/source/absolute");
    await fs.symlink("../target.txt", "/bin/source/relative");
    await fs.cp("/bin/source", "/bin/copied", { recursive: true });
    await fs.mv("/bin/copied", "/bin/moved");
    await fs.cp("/bin/source/absolute", "/nested/data/copied-link");
    expect(await fs.readlink("/nested/data/copied-link")).toBe(
      "/bin/target.txt",
    );
    expect(await fs.readFile("/nested/data/copied-link")).toBe("binary");

    await fs.writeFile("/bin/replacement", "replacement");
    await fs.cp("/bin/replacement", "/bin/moved/absolute");
    expect((await fs.lstat("/bin/moved/absolute")).isSymbolicLink).toBe(false);
    expect(await fs.readFile("/bin/moved/absolute")).toBe("replacement");
    await fs.cp("/bin/source", "/bin/moved", { recursive: true });

    const reopened = new MountableFs({
      symlinkNamespace: "global",
      mounts: [...fs.getMounts()],
    });
    expect(await reopened.readlink("/bin/moved/absolute")).toBe(
      "/bin/target.txt",
    );
    expect(await reopened.readlink("/bin/moved/relative")).toBe(
      "../target.txt",
    );
    expect(await reopened.readFile("/bin/moved/relative")).toBe("binary");
    expect(await fs.exists("/bin/copied")).toBe(false);
  });

  it("replaces destination links across mounts without modifying their targets", async () => {
    const fs = globalFilesystem();
    await fs.symlink("/base.txt", "/nested/data/destination");
    await fs.cp("/bin/target.txt", "/nested/data/destination");
    expect((await fs.lstat("/nested/data/destination")).isFile).toBe(true);
    expect(await fs.readFile("/nested/data/destination")).toBe("binary");
    expect(await fs.readFile("/base.txt")).toBe("base");
    await fs.symlink("/bin/target.txt", "/bin/link");
    await fs.cp("/bin/link", "/nested/data/destination");
    expect(await fs.readlink("/nested/data/destination")).toBe(
      "/bin/target.txt",
    );
    await fs.mv("/bin/link", "/nested/data/destination");
    expect(await fs.readlink("/nested/data/destination")).toBe(
      "/bin/target.txt",
    );
    expect(await fs.exists("/bin/link")).toBe(false);
  });

  it("retains the destination when a nonrecursive directory copy is rejected", async () => {
    const fs = globalFilesystem();
    await fs.mkdir("/bin/directory");
    await fs.symlink("/base.txt", "/nested/data/existing-link");
    await expect(
      fs.cp("/bin/directory", "/nested/data/existing-link"),
    ).rejects.toThrow("directory");
    expect(await fs.readlink("/nested/data/existing-link")).toBe("/base.txt");
    expect(await fs.readFile("/nested/data/existing-link")).toBe("base");
  });

  it("merges typed root and virtual parent listings with mount directories", async () => {
    const fs = globalFilesystem();
    expect(await fs.readdirWithFileTypes("/nested")).toEqual([
      { name: "data", isDirectory: true, isFile: false, isSymbolicLink: false },
    ]);
    expect(await fs.readdirWithFileTypes("/")).toEqual([
      {
        name: "base.txt",
        isDirectory: false,
        isFile: true,
        isSymbolicLink: false,
      },
      { name: "bin", isDirectory: true, isFile: false, isSymbolicLink: false },
      {
        name: "nested",
        isDirectory: true,
        isFile: false,
        isSymbolicLink: false,
      },
      {
        name: "shared",
        isDirectory: true,
        isFile: false,
        isSymbolicLink: false,
      },
    ]);
  });

  it("reports dangling links and bounds loops that cross mounts", async () => {
    const fs = globalFilesystem();
    await fs.symlink("/missing", "/bin/dangling");
    expect(await fs.exists("/bin/dangling")).toBe(false);
    await fs.symlink("/nested/data/loop", "/bin/loop");
    await fs.symlink("/bin/loop", "/nested/data/loop");
    await expect(fs.readFile("/bin/loop")).rejects.toThrow("ELOOP");
    await expect(fs.exists("/bin/loop")).rejects.toThrow("ELOOP");
  });

  it.each([
    {
      name: "ReadWriteFs",
      create: (root: string) => new ReadWriteFs({ root }),
      replacesLink: false,
    },
    {
      name: "OverlayFs",
      create: (root: string) => new OverlayFs({ root, mountPoint: "/" }),
      replacesLink: true,
    },
  ])("preserves $name default symlink policy in global mode", async ({
    create,
    replacesLink,
  }) => {
    const root = await mkdtemp(join(tmpdir(), "mountable-global-deny-"));
    try {
      await writeFile(join(root, "file.txt"), "unchanged");
      await symlink("file.txt", join(root, "link"));
      const fs = new MountableFs({
        symlinkNamespace: "global",
        mounts: [{ mountPoint: "/native", filesystem: create(root) }],
      });
      await expect(fs.readFile("/native/link")).rejects.toThrow();
      expect(await fs.readlink("/native/link")).toBe("file.txt");
      if (!replacesLink) {
        await fs.writeFile("/source", "source");
        await fs.symlink("/source", "/source-link");
        await expect(fs.cp("/source", "/native/link")).rejects.toThrow();
        await expect(
          fs.cp("/source-link", "/native/file.txt"),
        ).rejects.toThrow();
        expect(await fs.readlink("/native/link")).toBe("file.txt");
      }
      if (replacesLink) {
        // Overlay writes replace the link in memory without following it.
        await fs.writeFile("/native/link", "changed");
        expect(await fs.readFile("/native/link")).toBe("changed");
      } else {
        await expect(fs.writeFile("/native/link", "changed")).rejects.toThrow();
      }
      expect(await fs.readFile("/native/file.txt")).toBe("unchanged");
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });
});
