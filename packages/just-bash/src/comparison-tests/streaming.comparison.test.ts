import { afterEach, beforeEach, describe, it } from "vitest";
import {
  cleanupTestDir,
  compareOutputs,
  createTestDir,
  setupFiles,
} from "./fixture-runner.js";

describe("streamed filters - Real Bash Comparison", () => {
  let testDir: string;
  beforeEach(async () => {
    testDir = await createTestDir();
  });
  afterEach(async () => {
    await cleanupTestDir(testDir);
  });

  it("preserves stateful filters and byte ranges", async () => {
    const env = await setupFiles(testDir, {
      input: "alpha\nbeta\ngamma\ndelta\n",
    });
    await compareOutputs(
      env,
      testDir,
      "head -c 100 input | sed 'H;g' | awk 'length($0) {print ++n, $0}' | grep -E 'alpha|beta' | head -n 4",
    );
    await compareOutputs(env, testDir, "tail -c 12 input | head -c 5");
  });

  it("keeps END blocks, multiline sed and grep context", async () => {
    const env = await setupFiles(testDir, {
      input: "alpha\nbeta\ngamma\ndelta\n",
    });
    await compareOutputs(
      env,
      testDir,
      "head -c 100 input | sed 'N;s/\\n/:/' | awk '{ print NR, $0 } END {print NR}' | head -n 10",
    );
    await compareOutputs(
      env,
      testDir,
      "head -c 100 input | grep -A1 -B1 gamma | head -n 10",
    );
  });
});
