// Reads the tree-sitter executable out of a conda-forge package, for the
// glibc-compatible fallback in tree-sitter-cli-provision.ts (#4758). A .conda
// file is a zip whose entries are stored (not deflated); the executable sits in
// the zstd-compressed tar pkg-<name>.tar.zst at bin/tree-sitter.
// Dependency-free like the rest of the provisioning code, so the npx installer
// and the worker share it.
import * as zlib from "node:zlib";

const ZIP_END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const ZIP_CENTRAL_DIRECTORY_ENTRY = 0x02014b50;
const ZIP_LOCAL_FILE_HEADER = 0x04034b50;
const ZIP_STORED = 0;
const TAR_BLOCK = 512;

function storedZipEntry(archive: Buffer, matches: (name: string) => boolean): Buffer {
  // The end-of-central-directory record is the last 22 bytes plus a comment of
  // at most 64 KiB.
  let eocd = -1;
  for (let offset = archive.length - 22; offset >= Math.max(0, archive.length - 22 - 0xffff); offset--) {
    if (archive.readUInt32LE(offset) === ZIP_END_OF_CENTRAL_DIRECTORY) {
      eocd = offset;
      break;
    }
  }
  if (eocd < 0) throw new Error("not a zip archive (no end-of-central-directory record)");

  const entries = archive.readUInt16LE(eocd + 10);
  let offset = archive.readUInt32LE(eocd + 16);
  for (let entry = 0; entry < entries; entry++) {
    if (archive.readUInt32LE(offset) !== ZIP_CENTRAL_DIRECTORY_ENTRY) {
      throw new Error("corrupt zip central directory");
    }
    const method = archive.readUInt16LE(offset + 10);
    const compressedSize = archive.readUInt32LE(offset + 20);
    const nameLength = archive.readUInt16LE(offset + 28);
    const extraLength = archive.readUInt16LE(offset + 30);
    const commentLength = archive.readUInt16LE(offset + 32);
    const localHeader = archive.readUInt32LE(offset + 42);
    const name = archive.toString("utf-8", offset + 46, offset + 46 + nameLength);
    if (matches(name)) {
      if (method !== ZIP_STORED) throw new Error(`zip entry ${name} is compressed (method ${method}), expected stored`);
      if (archive.readUInt32LE(localHeader) !== ZIP_LOCAL_FILE_HEADER) throw new Error(`corrupt zip local header for ${name}`);
      const dataStart = localHeader + 30 + archive.readUInt16LE(localHeader + 26) + archive.readUInt16LE(localHeader + 28);
      return archive.subarray(dataStart, dataStart + compressedSize);
    }
    offset += 46 + nameLength + extraLength + commentLength;
  }
  throw new Error("the package has no pkg-*.tar.zst entry");
}

// Node has zlib.zstdDecompressSync from 22.15 / 23.8; Bun has both it and
// Bun.zstdDecompressSync. Node 20 has neither.
function zstdDecompressor(): ((input: Buffer) => Uint8Array) | undefined {
  const nodeZstd = (zlib as { zstdDecompressSync?: (input: Buffer) => Buffer }).zstdDecompressSync;
  if (typeof nodeZstd === "function") return nodeZstd;
  const bunZstd = (globalThis as { Bun?: { zstdDecompressSync?: (input: Uint8Array) => Uint8Array } }).Bun?.zstdDecompressSync;
  if (typeof bunZstd === "function") return bunZstd;
  return undefined;
}

/** Why this runtime cannot read a .conda package, or undefined when it can. */
export function condaPackageUnsupportedReason(): string | undefined {
  return zstdDecompressor()
    ? undefined
    : `this runtime cannot decompress zstd (${process.release?.name ?? "unknown"} ${process.version})`;
}

function zstdDecompress(data: Buffer): Buffer {
  const decompress = zstdDecompressor();
  if (!decompress) throw new Error(condaPackageUnsupportedReason());
  return Buffer.from(decompress(data));
}

function tarString(block: Buffer, start: number, length: number): string {
  const field = block.subarray(start, start + length);
  const end = field.indexOf(0);
  return field.toString("utf-8", 0, end < 0 ? field.length : end);
}

function tarRegularFile(tar: Buffer, wanted: string): Buffer {
  for (let offset = 0; offset + TAR_BLOCK <= tar.length;) {
    const header = tar.subarray(offset, offset + TAR_BLOCK);
    if (header.every((byte) => byte === 0)) break;
    const prefix = tarString(header, 345, 155);
    const name = prefix ? `${prefix}/${tarString(header, 0, 100)}` : tarString(header, 0, 100);
    const size = parseInt(tarString(header, 124, 12).trim() || "0", 8);
    const type = String.fromCharCode(header[156] || 0x30);
    const dataStart = offset + TAR_BLOCK;
    if ((type === "0" || type === "\0") && name.replace(/^\.\//, "") === wanted) {
      return tar.subarray(dataStart, dataStart + size);
    }
    offset = dataStart + Math.ceil(size / TAR_BLOCK) * TAR_BLOCK;
  }
  throw new Error(`the package has no ${wanted}`);
}

/** The bytes of bin/tree-sitter inside a conda-forge tree-sitter-cli package. */
export function treeSitterExecutableFromCondaPackage(archive: Buffer): Buffer {
  const pkgTarZst = storedZipEntry(archive, (name) => /^pkg-.*\.tar\.zst$/.test(name));
  return tarRegularFile(zstdDecompress(pkgTarZst), "bin/tree-sitter");
}
