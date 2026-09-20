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

/** Keep older external filesystems working; native implementations avoid this full read. */
export async function readRangeFrom(
  fs: IFileSystem,
  path: string,
  offset: number,
  length: number,
): Promise<Uint8Array> {
  validateReadRange(offset, length);
  const bytes = fs.readFileRange
    ? await fs.readFileRange(path, offset, length)
    : (await fs.readFileBuffer(path)).slice(offset, offset + length);
  if (bytes.byteLength > length)
    throw new RangeError("EIO: byte range exceeded requested length");
  return bytes;
}
