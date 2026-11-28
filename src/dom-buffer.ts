/**
 * DOM buffer-view casts.
 *
 * TypeScript 5.7+ made `Uint8Array` generic over its backing buffer
 * (`Uint8Array<ArrayBufferLike>`) and tightened the DOM lib types so that
 * `BufferSource` / `BlobPart` / `FileSystemWriteChunkType` / `bufferData` /
 * `createImageData` accept only `ArrayBuffer`-backed views, explicitly
 * excluding `SharedArrayBuffer`.
 *
 * Keep these casts localized to the DOM boundary; do not widen them into
 * general `any` usage.
 */

export const asBufferSource = (v: ArrayBufferView): BufferSource =>
  v as unknown as BufferSource;

export const asBlobPart = (v: ArrayBufferView): BlobPart =>
  v.buffer instanceof ArrayBuffer
    ? asBufferSource(v)
    : new Uint8Array(v.buffer, v.byteOffset, v.byteLength).slice();

export const asWriteChunk = (v: ArrayBufferView): FileSystemWriteChunkType =>
  v as unknown as FileSystemWriteChunkType;

/**
 * Cast a typed-array view for the `ImageData` constructor / `createImageData` /
 * WebGL `bufferData` / `texImage2D` overloads that require an
 * `ArrayBuffer`-backed view.
 *
 * The `ImageData` constructor (and `ImageDataArray`) demand the *nominal*
 * `Uint8ClampedArray<ArrayBuffer>`, not merely a view whose `.buffer` is an
 * `ArrayBuffer` — a structural intersection (`T & { buffer: ArrayBuffer }`) is
 * rejected because inherited methods like `subarray()` still carry the
 * `ArrayBufferLike` parameter. So map the element-buffer type param to
 * `ArrayBuffer` on the way out.
 */
export const asArrayBufferView = <T extends ArrayBufferView>(
  v: T,
): T extends Uint8ClampedArray<ArrayBufferLike>
  ? Uint8ClampedArray<ArrayBuffer>
  : T extends Uint8Array<ArrayBufferLike>
    ? Uint8Array<ArrayBuffer>
    : T & { buffer: ArrayBuffer } => v as never;

/** Cast a SAB-or-ArrayBuffer to `ArrayBuffer` for sinks typed `ArrayBuffer`. */
export const asArrayBuffer = (b: ArrayBufferLike): ArrayBuffer =>
  b as ArrayBuffer;
