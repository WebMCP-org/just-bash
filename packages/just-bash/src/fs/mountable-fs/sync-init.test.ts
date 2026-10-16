import { describe, expect, it } from "vitest";
import { Bash } from "../../Bash.js";
import { InMemoryFs } from "../in-memory-fs/in-memory-fs.js";
import type { IFileSystem } from "../interface.js";
import { MountableFs } from "./mountable-fs.js";

/** Expose only the supported async interface of a real backend. */
function asyncFilesystem(fs: InMemoryFs): IFileSystem {
  return {
    readFile: fs.readFile.bind(fs),
    readFileBuffer: fs.readFileBuffer.bind(fs),
    writeFile: fs.writeFile.bind(fs),
    appendFile: fs.appendFile.bind(fs),
    exists: fs.exists.bind(fs),
    stat: fs.stat.bind(fs),
    lstat: fs.lstat.bind(fs),
    mkdir: fs.mkdir.bind(fs),
    readdir: fs.readdir.bind(fs),
    rm: fs.rm.bind(fs),
    cp: fs.cp.bind(fs),
    mv: fs.mv.bind(fs),
    resolvePath: fs.resolvePath.bind(fs),
    getAllPaths: fs.getAllPaths.bind(fs),
    chmod: fs.chmod.bind(fs),
    symlink: fs.symlink.bind(fs),
    link: fs.link.bind(fs),
    readlink: fs.readlink.bind(fs),
    realpath: fs.realpath.bind(fs),
    utimes: fs.utimes.bind(fs),
  };
}

describe("MountableFs synchronous shell initialization", () => {
  it("initializes synchronous mounts while leaving the async workspace untouched", async () => {
    const workspace = new InMemoryFs({ "/tmp/live": "live workspace" });
    const fs = new MountableFs({
      symlinkNamespace: "global",
      base: asyncFilesystem(workspace),
      mounts: ["/bin", "/usr", "/dev", "/proc", "/sys"].map((mountPoint) => ({
        mountPoint,
        filesystem: new InMemoryFs(),
      })),
    });
    const bash = new Bash({ fs, cwd: "/" });
    expect(await fs.readFile("/bin/cat")).toBe(
      "#!/bin/bash\n# Built-in command: cat\n",
    );
    expect(await fs.readFile("/dev/null")).toBe("");
    expect(await fs.readFile("/proc/self/comm")).toBe("bash\n");
    expect(await bash.exec("cat /tmp/live")).toMatchObject({
      stdout: "live workspace",
      stderr: "",
      exitCode: 0,
    });
    expect(await workspace.readdir("/")).toEqual(["tmp"]);
  });

  it("falls back to eager process status when a sync mount has no lazy storage", async () => {
    const proc = new InMemoryFs();
    const syncProc = {
      ...asyncFilesystem(proc),
      mkdirSync: proc.mkdirSync.bind(proc),
      writeFileSync: proc.writeFileSync.bind(proc),
    };
    const fs = new MountableFs({
      base: asyncFilesystem(new InMemoryFs()),
      mounts: [
        {
          mountPoint: "/proc",
          filesystem: syncProc,
        },
      ],
    });
    new Bash({ fs, cwd: "/" });
    expect(await fs.readFile("/proc/self/comm")).toBe("bash\n");
    expect(await fs.readFile("/proc/self/status")).toBe(
      "Name:\tbash\nState:\tR (running)\nPid:\t1\nPPid:\t0\nUid:\t1000\t1000\t1000\t1000\nGid:\t1000\t1000\t1000\t1000\n",
    );
  });

  it("keeps asynchronous-only mountables usable by Bash", async () => {
    const workspace = new InMemoryFs({ "/file": "async" });
    const fs = new MountableFs({ base: asyncFilesystem(workspace) });
    const bash = new Bash({ fs, cwd: "/" });
    expect(await bash.exec("cat /file")).toMatchObject({
      stdout: "async",
      stderr: "",
      exitCode: 0,
    });
    expect(await workspace.readdir("/")).toEqual(["file"]);
    expect(() => fs.writeFileSync("/unsupported", "x")).toThrow("ENOTSUP");
  });
});
