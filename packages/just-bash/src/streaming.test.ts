import { describe, expect, it } from "vitest";
import { Bash } from "./Bash.js";

describe("streaming pipelines", () => {
  it("stops stateful awk when head has enough output", async () => {
    const bash = new Bash({
      files: { "/lines": "one\ntwo\nthree\nfour\n" },
      executionLimits: { maxAwkIterations: 2 },
    });
    expect(
      await bash.exec(
        "head -c 100 /lines | awk '{ print ++n, $0 }' | head -n 1",
      ),
    ).toMatchObject({ stdout: "1 one\n", stderr: "", exitCode: 0 });
  });

  it("preserves sed hold space and awk state across streamed records", async () => {
    const bash = new Bash({ files: { "/lines": "one\ntwo\nthree\n" } });
    expect(
      await bash.exec(
        "head -c 100 /lines | sed 'H;g' | awk 'length($0) { print ++n, $0 }' | head -n 4",
      ),
    ).toMatchObject({
      stdout: "1 one\n2 one\n3 two\n4 one\n",
      stderr: "",
      exitCode: 0,
    });
  });
});

it("propagates cancellation through sed, awk and grep before scanning all records", async () => {
  const bash = new Bash({
    files: { "/lines": "one\n".repeat(10000) },
    executionLimits: { maxAwkIterations: 50 },
  });
  const result = await bash.exec(
    "head -c 100000 /lines | sed 's/one/two/' | awk '{ print ++n, $0 }' | grep two | head -n 1",
  );
  expect(result).toMatchObject({ stdout: "1 two\n", stderr: "", exitCode: 0 });
});

it("keeps binary and split UTF-8 output intact", async () => {
  const bash = new Bash({
    files: {
      "/bytes": new Uint8Array([0, 255, 128, 10]),
      "/utf8": `${"🌍".repeat(20000)}\n`,
    },
  });
  expect(await bash.exec("head -c 4 /bytes | head -c 3")).toMatchObject({
    stdout: "\x00\xff\x80",
    stderr: "",
    exitCode: 0,
  });
  expect(
    await bash.exec(
      "head -c 100000 /utf8 | sed '' | awk '{print length($0)}' | head -n 1",
    ),
  ).toMatchObject({ stdout: "40000\n", stderr: "", exitCode: 0 });
});

it("supports getline on the same streamed AWK input cursor", async () => {
  const bash = new Bash({ files: { "/lines": "one\ntwo\nthree\n" } });
  expect(
    await bash.exec(
      "head -c 100 /lines | sed '' | awk '{ getline nextLine; print $0, nextLine }' | head -n 2",
    ),
  ).toMatchObject({ stdout: "one two\nthree two\n", stderr: "", exitCode: 0 });
});

it("counts streamed AWK records including getline against the array limit", async () => {
  const bash = new Bash({
    files: { "/lines": "one\ntwo\nthree\n".repeat(2) },
    executionLimits: { maxArrayElements: 5 },
  });
  for (const program of ["{}", "{ getline nextLine }"]) {
    expect(
      await bash.exec(`head -c 100 /lines | awk '${program}'`),
    ).toMatchObject({
      stdout: "",
      stderr: "awk: record array limit exceeded (5)\n",
      exitCode: 126,
    });
  }
});

it("keeps one grep matcher work budget across streamed lines", async () => {
  const bash = new Bash({
    files: { "/lines": "one\n".repeat(4) },
    executionLimits: { maxArrayElements: 5, maxLoopIterations: 1 },
  });
  expect(await bash.exec("head -c100 /lines | grep absent")).toMatchObject({
    stdout: "",
    stderr: "bash: search: matching work limit exceeded (5)\n",
    exitCode: 126,
  });
});

it("yields to caller cancellation and releases blocked pipe stages", async () => {
  const bash = new Bash({ files: { "/lines": "one\n".repeat(50000) } });
  const controller = new AbortController();
  const result = bash.exec(
    "head -c 200000 /lines | sed '' | awk 'length($0)' | grep absent | head -n 1",
    { signal: controller.signal },
  );
  const timer = setTimeout(() => controller.abort(), 10);
  try {
    expect((await result).exitCode).toBe(124);
  } finally {
    clearTimeout(timer);
  }
  expect(await bash.exec("echo ready")).toMatchObject({
    stdout: "ready\n",
    stderr: "",
    exitCode: 0,
  });
});

it("reports a stopped producer through pipefail", async () => {
  const bash = new Bash({ files: { "/lines": "one\n".repeat(10000) } });
  expect(
    await bash.exec(
      "set -o pipefail; head -c 100000 /lines | awk '{print}' | head -n 1",
    ),
  ).toMatchObject({ stdout: "one\n", stderr: "", exitCode: 141 });
});

it("shares the command budget across concurrently running stages", async () => {
  const bash = new Bash({
    files: { "/lines": "one\n" },
    executionLimits: { maxCommandCount: 2 },
  });
  expect(
    await bash.exec("head -c 4 /lines | awk '{print}' | head -n 1"),
  ).toMatchObject({
    stdout: "",
    stderr:
      "bash: too many commands executed (>2), increase executionLimits.maxCommandCount\n",
    exitCode: 126,
  });
});
