import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const packageRoot = resolve(__dirname, "..");

interface PackResult {
  files: Array<{ path: string }>;
}

describe("published package declarations", () => {
  it("includes declaration trees referenced by public declarations", async () => {
    const npmCache = await mkdtemp(resolve(tmpdir(), "just-bash-npm-cache-"));

    try {
      const { stdout } = await execFileAsync(
        "npm",
        ["pack", "--dry-run", "--json", "--ignore-scripts"],
        {
          cwd: packageRoot,
          env: { ...process.env, npm_config_cache: npmCache },
          maxBuffer: 10 * 1024 * 1024,
        },
      );
      const [pack] = JSON.parse(stdout) as PackResult[];
      const files = new Set(pack.files.map((file) => file.path));

      expect(files.has("dist/bundle/fs-encoding.js")).toBe(true);
      expect(files.has("dist/fs/encoding.d.ts")).toBe(true);
      expect(files.has("dist/security/index.d.ts")).toBe(true);
      expect(files.has("dist/security/types.d.ts")).toBe(true);
      expect(files.has("dist/transform/pipeline.d.ts")).toBe(true);
      expect(files.has("dist/transform/plugins/command-collector.d.ts")).toBe(
        true,
      );
      expect(files.has("dist/transform/plugins/tee-plugin.d.ts")).toBe(true);
    } finally {
      await rm(npmCache, { recursive: true, force: true });
    }
  }, 30_000);
  it("imports the filesystem codecs through the published package export", async () => {
    const { stdout } = await execFileAsync(
      "node",
      [
        "--input-type=module",
        "-e",
        `
      import { fromBuffer, getEncoding, toBuffer } from "just-bash/fs/encoding";
      const bytes = toBuffer("00ff80", "hex");
      console.log(JSON.stringify({
        bytes: [...bytes],
        hex: fromBuffer(bytes, "hex"),
        base64: fromBuffer(bytes, "base64"),
        encoding: getEncoding({ encoding: "latin1" }),
      }));
    `,
      ],
      { cwd: packageRoot },
    );
    expect(stdout).toBe(
      '{"bytes":[0,255,128],"hex":"00ff80","base64":"AP+A","encoding":"latin1"}\n',
    );
  });
});
