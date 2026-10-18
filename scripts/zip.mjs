// A plain zip writer for the extension package, so the build needs no zip tool. Files are
// deflated, stored with a fixed date so the same input gives the same zip. The reader lets
// the release script check the manifest inside the zip GitHub serves.

import { crc32, deflateRawSync, inflateRawSync } from 'node:zlib';

const DOS_DATE = ((2026 - 1980) << 9) | (1 << 5) | 1; // 2026-01-01
const DOS_TIME = 0;

// files: [{ name: 'path/in/zip', data: Buffer }]. Returns the zip as a Buffer.
export function zip(files) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const { name, data } of files) {
    const nameBytes = Buffer.from(name, 'utf8');
    const packed = deflateRawSync(data, { level: 9 });
    const crc = crc32(data);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4); // version needed
    header.writeUInt16LE(0x0800, 6); // UTF-8 names
    header.writeUInt16LE(8, 8); // deflate
    header.writeUInt16LE(DOS_TIME, 10);
    header.writeUInt16LE(DOS_DATE, 12);
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(packed.length, 18);
    header.writeUInt32LE(data.length, 22);
    header.writeUInt16LE(nameBytes.length, 26);
    header.writeUInt16LE(0, 28);
    locals.push(header, nameBytes, packed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4); // made by
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(packed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBytes);
    offset += header.length + nameBytes.length + packed.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

// Reads one file back out of a zip through its central directory, the way unzip tools do.
// Returns null when the zip has no such file, and throws when the zip is broken.
export function unzipFile(buffer, wanted) {
  const end = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (end === -1) throw new Error('no zip directory');
  const count = buffer.readUInt16LE(end + 10);
  let at = buffer.readUInt32LE(end + 16);
  for (let i = 0; i < count; i++) {
    if (buffer.readUInt32LE(at) !== 0x02014b50) throw new Error('broken zip directory');
    const nameLength = buffer.readUInt16LE(at + 28);
    const name = buffer.toString('utf8', at + 46, at + 46 + nameLength);
    if (name === wanted) {
      const method = buffer.readUInt16LE(at + 10);
      const local = buffer.readUInt32LE(at + 42);
      if (buffer.readUInt32LE(local) !== 0x04034b50) throw new Error(`broken zip entry for ${name}`);
      const start = local + 30 + buffer.readUInt16LE(local + 26) + buffer.readUInt16LE(local + 28);
      const packed = buffer.subarray(start, start + buffer.readUInt32LE(at + 20));
      if (method !== 0 && method !== 8) throw new Error(`${name} uses zip method ${method}`);
      const data = method === 8 ? inflateRawSync(packed) : Buffer.from(packed);
      if (crc32(data) !== buffer.readUInt32LE(at + 16)) throw new Error(`${name} fails its zip checksum`);
      return data;
    }
    at += 46 + nameLength + buffer.readUInt16LE(at + 30) + buffer.readUInt16LE(at + 32);
  }
  return null;
}
