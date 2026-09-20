import type { IFileSystem } from "./interface.js";

export function validateReadRange(offset: number, length: number): void {
  if (
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    !Number.isSafeInteger(length) ||
    length < 0 ||
    !Number.isSafeInteger(offset + length)
  ) {
    throw new RangeError("EINVAL: invalid byte range");
  }
}

/** Let the caller apply its full-file budget before using a legacy backend. */
export class RangeReadUnsupportedError extends Error {
  constructor() {
    super("ENOTSUP: filesystem does not support byte ranges");
  }
}

export async function readRangeFrom(
  fs: IFileSystem,
  path: string,
  offset: number,
  length: number,
): Promise<Uint8Array> {
  validateReadRange(offset, length);
  if (!fs.readFileRange) throw new RangeReadUnsupportedError();
  const bytes = await fs.readFileRange(path, offset, length);
  if (bytes.byteLength > length)
    throw new RangeError("EIO: byte range exceeded requested length");
  return bytes;
}
