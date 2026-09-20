import type { CommandNode, PipelineNode, WordPart } from "../ast/types.js";
import {
  latin1FromBytes,
  stdoutAsBytes,
  unsafeBytesFromLatin1,
} from "../encoding.js";
import { ExecutionOutputAccumulator } from "../execution-output.js";
import { _setTimeout } from "../timers.js";
import type {
  ExecResult,
  PipelineChunk,
  PipelineIO,
  RuntimeCommand,
} from "../types.js";
import { resolveCommand } from "./command-resolution.js";
import {
  BadSubstitutionError,
  ErrexitError,
  ExecutionLimitError,
  ExitError,
  PipelineClosedError,
} from "./errors.js";
import type { InterpreterContext } from "./types.js";

function inertArgument(part: WordPart): boolean {
  switch (part.type) {
    case "Literal":
    case "SingleQuoted":
    case "Escaped":
      return true;
    case "DoubleQuoted":
      return part.parts.every(inertArgument);
    case "ParameterExpansion":
      return part.operation === null;
    default:
      return false;
  }
}

/** Stream bundled filters; other shell compositions retain the general executor. */
export async function streamPipeline(
  ctx: InterpreterContext,
  node: PipelineNode,
  execute: (node: CommandNode, io: PipelineIO) => Promise<ExecResult>,
): Promise<ExecResult[] | null> {
  if (
    node.commands.length < 2 ||
    node.timed ||
    node.pipeStderr?.some(Boolean) ||
    ctx.state.shoptOptions.lastpipe ||
    ctx.state.shoptOptions.expand_aliases ||
    ctx.state.groupStdin !== undefined ||
    ctx.state.fileDescriptors?.size ||
    ctx.state.closedStandardFds?.size
  )
    return null;
  for (const command of node.commands) {
    if (
      command.type !== "SimpleCommand" ||
      command.assignments.length ||
      command.redirections.length ||
      command.name?.parts.length !== 1 ||
      command.name.parts[0].type !== "Literal" ||
      !command.args.every((arg) => arg.parts.every(inertArgument))
    )
      return null;
    const name = command.name.parts[0].value;
    if (ctx.state.functions.has(name)) return null;
    const resolved = await resolveCommand(ctx, name);
    if (
      !resolved ||
      !("cmd" in resolved) ||
      !(resolved.cmd as RuntimeCommand).internalSupportsStreaming
    )
      return null;
  }

  const pipes = node.commands.slice(1).map(() => {
    let controller: TransformStreamDefaultController<PipelineChunk>;
    const stream = new TransformStream<PipelineChunk, PipelineChunk>({
      start(value) {
        controller = value;
      },
    });
    return {
      cancelled: false,
      reader: stream.readable.getReader(),
      writer: stream.writable.getWriter(),
      fail(error: unknown) {
        controller.error(error);
      },
    };
  });
  const cancelAll = (error: unknown) => {
    for (const pipe of pipes) pipe.fail(error);
  };
  const unregister = ctx.executionScope.registerCleanup(() =>
    cancelAll(new PipelineClosedError()),
  );
  let fatal: unknown;
  let lastYield = Date.now();
  try {
    const results = await Promise.all(
      node.commands.map(async (command, index) => {
        const input = pipes[index - 1];
        const output = pipes[index];
        let inputBytes = 0;
        let outputBytes = 0;
        const retained = new ExecutionOutputAccumulator(
          ctx.executionScope,
          "pipeline",
        );
        let closed: unknown;
        void output?.writer.closed.catch((error: unknown) => {
          closed = error;
        });
        const io: PipelineIO = {
          async checkpoint() {
            if (Date.now() - lastYield >= 8) {
              lastYield = Date.now();
              await new Promise<void>((resolve) => _setTimeout(resolve, 0));
            }
            ctx.executionScope.throwIfAborted("pipeline");
            if (output?.cancelled) throw new PipelineClosedError();
            if (closed !== undefined) throw closed;
          },
          async read() {
            await io.checkpoint();
            if (!input) return null;
            const chunk = await input.reader.read();
            if (chunk.done) return null;
            inputBytes += latin1FromBytes(chunk.value.bytes).length;
            if (inputBytes > ctx.limits.maxInputBytes) {
              throw new ExecutionLimitError(
                `pipeline: input size limit exceeded (${ctx.limits.maxInputBytes} bytes)`,
                "string_length",
              );
            }
            return chunk.value;
          },
          async write(bytes, utf8 = false) {
            const value = latin1FromBytes(bytes);
            outputBytes += value.length;
            if (
              outputBytes >
              Math.min(ctx.limits.maxOutputSize, ctx.limits.maxStringLength)
            ) {
              throw new ExecutionLimitError(
                `pipeline: output size limit exceeded (${ctx.limits.maxOutputSize} bytes)`,
                "string_length",
              );
            }
            for (let offset = 0; offset < value.length; offset += 65536) {
              await io.checkpoint();
              const part = value.slice(offset, offset + 65536);
              const lease = ctx.executionScope.reserveBytes(
                part.length,
                "pipeline",
              );
              try {
                if (output)
                  await output.writer.write({
                    bytes: unsafeBytesFromLatin1(part),
                    utf8,
                  });
                else retained.append("stdout", part, 0, "bytes");
              } finally {
                lease.release();
              }
            }
          },
        };
        try {
          ctx.state.commandCount = ctx.executionScope.chargeCommand();
          const result = await execute(command, io);
          if (result.stdout)
            await io.write(
              stdoutAsBytes(result),
              result.stdoutKind !== "bytes" &&
                result.stdoutEncoding !== "binary",
            );
          if (output && !output.cancelled) {
            await output.writer.close().catch((error: unknown) => {
              if (!output.cancelled) throw error;
            });
          }
          retained.append(
            "stderr",
            result.stderr,
            result.internalOutputAccounting?.stderr ?? 0,
          );
          return retained.build(result.exitCode, {
            stdoutKind: "bytes",
            stdoutEncoding: "binary",
          });
        } catch (error) {
          if (error instanceof PipelineClosedError)
            return retained.build(141, {
              stdoutKind: "bytes",
              stdoutEncoding: "binary",
            });
          if (
            error instanceof BadSubstitutionError ||
            error instanceof ExitError ||
            error instanceof ErrexitError
          ) {
            if (output && !output.cancelled) {
              await output.writer.close().catch((error: unknown) => {
                if (!output.cancelled) throw error;
              });
            }
            return {
              stdout: error.stdout,
              stderr: error.stderr,
              exitCode:
                error instanceof BadSubstitutionError ? 1 : error.exitCode,
            };
          }
          fatal ??= error;
          cancelAll(error);
          return { stdout: "", stderr: "", exitCode: 1 };
        } finally {
          if (input) input.cancelled = true;
          if (input)
            await input.reader
              .cancel(new PipelineClosedError())
              .catch(() => {});
        }
      }),
    );
    if (fatal !== undefined) throw fatal;
    return results;
  } finally {
    unregister();
    for (const pipe of pipes) {
      pipe.reader.releaseLock();
      pipe.writer.releaseLock();
    }
  }
}
