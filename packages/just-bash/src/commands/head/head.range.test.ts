import { describe, expect, it } from "vitest";
import { Bash } from "../../Bash.js";
import { InMemoryFs } from "../../fs/in-memory-fs/in-memory-fs.js";
import { MountableFs } from "../../fs/mountable-fs/mountable-fs.js";

class RangeFileSystem extends InMemoryFs {
  readonly ranges: Array<{ path: string; offset: number; length: number }> = [];

  async readFileRange(path: string, offset: number, length: number) {
    this.ranges.push({ path, offset, length });
    return (await super.readFileBuffer(path)).slice(offset, offset + length);
  }

  override readFileBuffer(path: string): Promise<Uint8Array> {
    if (path === "/large.bin") throw new Error("Full-file read is forbidden");
    return super.readFileBuffer(path);
  }
}

describe("head/tail byte ranges", () => {
  it("reads only the requested prefix and suffix through a mount", async () => {
    const original = Uint8Array.from({ length: 256 }, (_, i) => i);
    const mounted = new RangeFileSystem({ "/large.bin": original });
    const fs = new MountableFs();
    fs.mount("/mnt", mounted);
    const bash = new Bash({ fs, executionLimits: { maxInputBytes: 8 } });

    const result = await bash.exec(
      "head -c 4 /mnt/large.bin > /head; tail -c 4 /mnt/large.bin > /tail",
    );
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
    expect(await fs.readFileBuffer("/head")).toEqual(original.slice(0, 4));
    expect(await fs.readFileBuffer("/tail")).toEqual(original.slice(-4));
    expect(mounted.ranges).toEqual([
      { path: "/large.bin", offset: 0, length: 4 },
      { path: "/large.bin", offset: 252, length: 4 },
    ]);
  });

  it("accepts an empty range without reading the file contents", async () => {
    const fs = new RangeFileSystem({ "/large.bin": "abcdef" });
    const result = await new Bash({ fs }).exec("head -c 0 /large.bin");
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
    expect(fs.ranges).toEqual([{ path: "/large.bin", offset: 0, length: 0 }]);
  });

  it("still enforces the shared input budget for consumed ranges", async () => {
    const fs = new RangeFileSystem({ "/large.bin": "abcdefghijk" });
    const result = await new Bash({
      fs,
      executionLimits: { maxInputBytes: 8 },
    }).exec("head -c 5 /large.bin; tail -c 5 /large.bin");
    expect(result.exitCode).toBe(126);
    expect(result.stdout).toBe("abcde");
    expect(result.stderr).toBe(
      "bash: tail: aggregate input size limit exceeded (8 bytes)\n",
    );
  });
});
