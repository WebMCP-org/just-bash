import type { ByteString } from "../encoding.js";
import {
  decodeBytesToUtf8,
  latin1FromBytes,
  unsafeBytesFromLatin1,
} from "../encoding.js";
import { ExecutionLimitError } from "../interpreter/errors.js";
import type { RuntimeCommandContext } from "../types.js";

export async function readStdin(
  ctx: RuntimeCommandContext,
): Promise<ByteString> {
  if (!ctx.pipeline) return ctx.stdin;
  let bytes = "";
  for (;;) {
    const chunk = await ctx.pipeline.read();
    if (chunk === null) return unsafeBytesFromLatin1(bytes);
    bytes += latin1FromBytes(chunk.bytes);
    if (bytes.length > ctx.limits.maxStringLength)
      throw new ExecutionLimitError(
        "pipeline: input string size limit exceeded",
        "string_length",
      );
  }
}

/** Preserve whole-input invalid-UTF-8 fallback for unknown binary producers. */
async function* textChunks(ctx: RuntimeCommandContext): AsyncGenerator<string> {
  if (!ctx.pipeline) {
    yield decodeBytesToUtf8(ctx.stdin);
    return;
  }
  const first = await ctx.pipeline.read();
  if (first === null) return;
  if (!first.utf8) {
    const rest = await readStdin(ctx);
    const bytes = latin1FromBytes(first.bytes) + latin1FromBytes(rest);
    if (bytes.length > ctx.limits.maxStringLength)
      throw new ExecutionLimitError(
        "pipeline: input string size limit exceeded",
        "string_length",
      );
    yield decodeBytesToUtf8(unsafeBytesFromLatin1(bytes));
    return;
  }
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let chunk = first;
  for (;;) {
    if (!chunk.utf8)
      throw new Error("pipeline: mixed text and binary producer");
    yield decoder.decode(
      Uint8Array.from(latin1FromBytes(chunk.bytes), (char) =>
        char.charCodeAt(0),
      ),
      { stream: true },
    );
    const next = await ctx.pipeline.read();
    if (next === null) break;
    chunk = next;
  }
  const final = decoder.decode();
  if (final) yield final;
}

export async function* stdinLines(
  ctx: RuntimeCommandContext,
): AsyncGenerator<{ text: string; terminated: boolean }> {
  let pending = "";
  for await (const chunk of textChunks(ctx)) {
    let start = 0;
    for (;;) {
      const end = chunk.indexOf("\n", start);
      if (end === -1) break;
      const line = pending + chunk.slice(start, end);
      if (line.length > ctx.limits.maxStringLength)
        throw new ExecutionLimitError(
          "pipeline: input record size limit exceeded",
          "string_length",
        );
      await ctx.pipeline?.checkpoint();
      yield { text: line, terminated: true };
      pending = "";
      start = end + 1;
    }
    pending += chunk.slice(start);
    if (pending.length > ctx.limits.maxStringLength)
      throw new ExecutionLimitError(
        "pipeline: input record size limit exceeded",
        "string_length",
      );
  }
  await ctx.pipeline?.checkpoint();
  if (pending) yield { text: pending, terminated: false };
}
