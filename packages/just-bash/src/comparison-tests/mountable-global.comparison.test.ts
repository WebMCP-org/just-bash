import { afterEach, beforeEach, describe, it } from "vitest";
import { Bash } from "../Bash.js";
import { InMemoryFs } from "../fs/in-memory-fs/in-memory-fs.js";
import { MountableFs } from "../fs/mountable-fs/mountable-fs.js";
import {
  cleanupTestDir,
  compareOutputs,
  createTestDir,
  setupFiles,
} from "./fixture-runner.js";

describe("Global virtual mounts - Real Bash Comparison", () => {
  let testDir: string;
  beforeEach(async () => {
    testDir = await createTestDir();
  });
  afterEach(async () => {
    await cleanupTestDir(testDir);
  });

  it("preserves global and relative links through shell IO, copies and moves", async () => {
    await setupFiles(testDir, {});
    const fs = new MountableFs({
      symlinkNamespace: "global",
      mounts: [
        { mountPoint: `${testDir}/mounted`, filesystem: new InMemoryFs() },
      ],
    });
    const bash = new Bash({ fs, cwd: testDir });
    await compareOutputs(
      bash,
      testDir,
      `
mkdir -p mounted/source
printf 'value\\n' > mounted/source/file
ln -s "$PWD/mounted/source/file" mounted/source/absolute
ln -s source/file mounted/relative
ln -s "$PWD/mounted/source" alias
cat alias/file mounted/source/absolute mounted/relative
cp -R mounted/source/absolute copied-link
cat copied-link
readlink mounted/relative
cp -R mounted/source mounted/copied
mv mounted/copied mounted/moved
cat mounted/moved/absolute
rm mounted/moved/absolute
cat mounted/source/file
`,
    );
  });
});
