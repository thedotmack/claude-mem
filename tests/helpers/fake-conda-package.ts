import { crc32 } from 'zlib';

/**
 * Builds a .conda package in memory the way conda-forge lays one out: a zip
 * of stored (not deflated) entries, with the files in a zstd-compressed tar
 * named pkg-<name>.tar.zst. Lets the glibc-compatible tree-sitter fallback be
 * tested without the network.
 */

function tarHeader(name: string, size: number, type = '0'): Buffer {
  const header = Buffer.alloc(512);
  header.write(name, 0, 100, 'utf-8');
  header.write('0000755\0', 100, 8, 'ascii');
  header.write('0000000\0', 108, 8, 'ascii');
  header.write('0000000\0', 116, 8, 'ascii');
  header.write(`${size.toString(8).padStart(11, '0')}\0`, 124, 12, 'ascii');
  header.write('00000000000\0', 136, 12, 'ascii');
  header.write(type, 156, 1, 'ascii');
  header.write('ustar\0', 257, 6, 'ascii');
  header.write('00', 263, 2, 'ascii');
  header.fill(' ', 148, 156);
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
  return header;
}

/** A ustar archive of regular files, plus a directory entry first like conda's. */
export function tarOf(files: Record<string, Buffer>): Buffer {
  const parts: Buffer[] = [tarHeader('bin/', 0, '5')];
  for (const [name, data] of Object.entries(files)) {
    parts.push(tarHeader(name, data.length), data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  parts.push(Buffer.alloc(1024));
  return Buffer.concat(parts);
}

/** A zip of entries; each is stored unless listed in `deflated`. */
export function zipOf(entries: Record<string, Buffer>, deflated: string[] = []): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, data] of Object.entries(entries)) {
    const nameBytes = Buffer.from(name, 'utf-8');
    const method = deflated.includes(name) ? 8 : 0;
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBytes, data);
    centrals.push(central, nameBytes);
    offset += local.length + nameBytes.length + data.length;
  }
  const centralDirectory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(entries).length, 8);
  end.writeUInt16LE(Object.keys(entries).length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralDirectory, end]);
}

/** A .conda package whose pkg tarball holds bin/tree-sitter = `executable`. */
export function fakeCondaPackage(executable: Buffer): Buffer {
  const pkg = Buffer.from(Bun.zstdCompressSync(tarOf({ 'bin/tree-sitter': executable })));
  return zipOf({
    'metadata.json': Buffer.from('{"conda_pkg_format_version": 2}'),
    'pkg-tree-sitter-cli-0.26.9-test_0.tar.zst': pkg,
    'info-tree-sitter-cli-0.26.9-test_0.tar.zst': Buffer.from(Bun.zstdCompressSync(tarOf({}))),
  });
}
