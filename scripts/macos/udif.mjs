// Minimal writer/reader for Apple's UDIF disk-image format (.dmg), so the macOS
// installer can be built on Linux, where hdiutil doesn't exist.
//
// Layout of a UDIF file:
//   [data fork: zlib-compressed 1 MiB chunks of the raw disk]
//   [XML property list: "blkx" tables describing each chunk ("mish" blocks)]
//   [512-byte "koly" trailer pointing at both]
//
// Checksums (all CRC-32), as stored by hdiutil:
//   - each blkx table: CRC of the uncompressed bytes it describes
//   - koly data-fork checksum: CRC of the compressed data fork
//   - koly master checksum: CRC of the big-endian blkx checksums, concatenated
import { randomBytes } from 'node:crypto';
import { closeSync, fstatSync, openSync, readSync, writeSync } from 'node:fs';
import zlib from 'node:zlib';

const SECTOR = 512;
const CHUNK_SECTORS = 2048; // 1 MiB, like hdiutil
const BUFFERS_NEEDED = 2056; // decompression buffer (sectors) hdiutil uses for 1 MiB chunks
const CHUNK_ZLIB = 0x80000005;
const CHUNK_RAW = 0x00000001;
const CHUNK_ZERO = 0x00000000;
const CHUNK_IGNORE = 0x00000002;
const CHUNK_TERM = 0xffffffff;
const CHECKSUM_CRC32 = 2;

function checksumBlock(crc) {
  const b = Buffer.alloc(136); // type, size (bits), 128 bytes of data
  b.writeUInt32BE(CHECKSUM_CRC32, 0);
  b.writeUInt32BE(32, 4);
  b.writeUInt32BE(crc >>> 0, 8);
  return b;
}

function plistXml(entries) {
  const blkx = entries
    .map(
      (e) => `\t\t\t<dict>
\t\t\t\t<key>Attributes</key>
\t\t\t\t<string>0x0050</string>
\t\t\t\t<key>CFName</key>
\t\t\t\t<string>${e.name}</string>
\t\t\t\t<key>Data</key>
\t\t\t\t<data>
${e.data.toString('base64').replace(/.{1,68}/g, (line) => `\t\t\t\t${line}\n`)}\t\t\t\t</data>
\t\t\t\t<key>ID</key>
\t\t\t\t<string>${e.id}</string>
\t\t\t\t<key>Name</key>
\t\t\t\t<string>${e.name}</string>
\t\t\t</dict>`,
    )
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
\t<key>resource-fork</key>
\t<dict>
\t\t<key>blkx</key>
\t\t<array>
${blkx}
\t\t</array>
\t</dict>
</dict>
</plist>
`;
}

/**
 * Compresses a raw disk image into a UDIF (UDZO-style) .dmg.
 * `partitions` splits the image into named blkx entries ({ name, startSector, sectorCount }),
 * covering the whole image in order; by default the whole image is one entry.
 */
export function writeUdif(rawPath, outPath, { partitions } = {}) {
  const input = openSync(rawPath, 'r');
  const size = fstatSync(input).size;
  if (size % SECTOR !== 0) throw new Error(`Raw image size ${size} is not a multiple of ${SECTOR}`);
  const totalSectors = size / SECTOR;
  const parts = partitions ?? [{ name: 'whole disk (Apple_HFS : 0)', startSector: 0, sectorCount: totalSectors }];
  let expected = 0;
  for (const p of parts) {
    if (p.startSector !== expected) throw new Error('Partitions must cover the image contiguously');
    expected += p.sectorCount;
  }
  if (expected !== totalSectors) throw new Error('Partitions must cover the whole image');

  const out = openSync(outPath, 'w');
  let dataOffset = 0;
  let dataCrc = 0;
  const entries = [];
  const buffer = Buffer.alloc(CHUNK_SECTORS * SECTOR);

  parts.forEach((part, index) => {
    const runs = [];
    let partCrc = 0;
    let done = 0;
    while (done < part.sectorCount) {
      const sectors = Math.min(CHUNK_SECTORS, part.sectorCount - done);
      const bytes = sectors * SECTOR;
      const chunk = buffer.subarray(0, bytes);
      let read = 0;
      while (read < bytes) {
        const n = readSync(input, chunk, read, bytes - read, (part.startSector + done) * SECTOR + read);
        if (n === 0) throw new Error('Unexpected end of raw image');
        read += n;
      }
      partCrc = zlib.crc32(chunk, partCrc);
      const compressed = zlib.deflateSync(chunk, { level: 9 });
      writeSync(out, compressed);
      dataCrc = zlib.crc32(compressed, dataCrc);
      runs.push({ type: CHUNK_ZLIB, sector: done, sectors, offset: dataOffset, length: compressed.length });
      dataOffset += compressed.length;
      done += sectors;
    }
    runs.push({ type: CHUNK_TERM, sector: done, sectors: 0, offset: dataOffset, length: 0 });

    const mish = Buffer.alloc(204 + runs.length * 40);
    mish.write('mish', 0, 'latin1');
    mish.writeUInt32BE(1, 4); // version
    mish.writeBigUInt64BE(BigInt(part.startSector), 8);
    mish.writeBigUInt64BE(BigInt(part.sectorCount), 16);
    mish.writeBigUInt64BE(0n, 24); // data offset
    mish.writeUInt32BE(BUFFERS_NEEDED, 32);
    mish.writeUInt32BE(index, 36); // block descriptors
    // 40..63 reserved
    checksumBlock(partCrc).copy(mish, 64);
    mish.writeUInt32BE(runs.length, 200);
    runs.forEach((r, i) => {
      const o = 204 + i * 40;
      mish.writeUInt32BE(r.type >>> 0, o);
      mish.writeUInt32BE(0, o + 4); // comment
      mish.writeBigUInt64BE(BigInt(r.sector), o + 8);
      mish.writeBigUInt64BE(BigInt(r.sectors), o + 16);
      mish.writeBigUInt64BE(BigInt(r.offset), o + 24);
      mish.writeBigUInt64BE(BigInt(r.length), o + 32);
    });
    entries.push({ name: part.name, id: String(index - 1), data: mish, crc: partCrc >>> 0 });
  });
  closeSync(input);

  const xml = Buffer.from(plistXml(entries), 'utf8');
  writeSync(out, xml);

  const masterInput = Buffer.alloc(entries.length * 4);
  entries.forEach((e, i) => masterInput.writeUInt32BE(e.crc, i * 4));

  const koly = Buffer.alloc(512);
  koly.write('koly', 0, 'latin1');
  koly.writeUInt32BE(4, 4); // version
  koly.writeUInt32BE(512, 8); // header size
  koly.writeUInt32BE(1, 12); // flags: flattened
  koly.writeBigUInt64BE(0n, 16); // running data fork offset
  koly.writeBigUInt64BE(0n, 24); // data fork offset
  koly.writeBigUInt64BE(BigInt(dataOffset), 32); // data fork length
  koly.writeBigUInt64BE(0n, 40); // resource fork offset
  koly.writeBigUInt64BE(0n, 48); // resource fork length
  koly.writeUInt32BE(1, 56); // segment number
  koly.writeUInt32BE(1, 60); // segment count
  randomBytes(16).copy(koly, 64); // segment ID
  checksumBlock(dataCrc).copy(koly, 80);
  koly.writeBigUInt64BE(BigInt(dataOffset), 216); // XML offset
  koly.writeBigUInt64BE(BigInt(xml.length), 224); // XML length
  // 232..351 reserved
  checksumBlock(zlib.crc32(masterInput)).copy(koly, 352);
  koly.writeUInt32BE(1, 488); // image variant
  koly.writeBigUInt64BE(BigInt(totalSectors), 492);
  writeSync(out, koly);
  closeSync(out);
  return { sectors: totalSectors, compressedBytes: dataOffset, partitions: entries.length };
}

/**
 * Reads a UDIF image, verifies every checksum, and returns the decompressed disk.
 * Used to check images built by writeUdif (and works on hdiutil-made images).
 */
export function readUdif(buf) {
  const k = buf.subarray(buf.length - 512);
  if (k.toString('latin1', 0, 4) !== 'koly') throw new Error('No koly trailer');
  const u32 = (b, o) => b.readUInt32BE(o);
  const u64 = (b, o) => Number(b.readBigUInt64BE(o));
  const dataOff = u64(k, 24);
  const dataLen = u64(k, 32);
  const xmlOff = u64(k, 216);
  const xmlLen = u64(k, 224);
  const sectors = u64(k, 492);
  const xml = buf.toString('utf8', xmlOff, xmlOff + xmlLen);
  const blkxStart = xml.indexOf('<key>blkx</key>');
  const blkxXml = xml.slice(blkxStart, xml.indexOf('</array>', blkxStart));
  const tables = [...blkxXml.matchAll(/<key>Data<\/key>\s*<data>([\s\S]*?)<\/data>/g)].map((m) =>
    Buffer.from(m[1].replace(/\s+/g, ''), 'base64'),
  );
  const disk = Buffer.alloc(sectors * SECTOR);
  const problems = [];
  const master = [];
  for (const t of tables) {
    if (t.toString('latin1', 0, 4) !== 'mish') throw new Error('Bad mish block');
    const first = u64(t, 8);
    let crc = 0;
    const count = u32(t, 200);
    for (let i = 0; i < count; i++) {
      const o = 204 + i * 40;
      const type = u32(t, o);
      const sector = first + u64(t, o + 8);
      const nSectors = u64(t, o + 16);
      const off = dataOff + u64(t, o + 24);
      const len = u64(t, o + 32);
      let data = null;
      if (type === CHUNK_ZLIB) data = zlib.inflateSync(buf.subarray(off, off + len));
      else if (type === CHUNK_RAW) data = buf.subarray(off, off + len);
      else if (type === CHUNK_ZERO) data = Buffer.alloc(nSectors * SECTOR);
      else if (type === CHUNK_IGNORE || type === CHUNK_TERM || type === 0x7ffffffe) continue;
      else throw new Error(`Unsupported chunk type 0x${type.toString(16)}`);
      if (data.length !== nSectors * SECTOR) problems.push(`chunk at sector ${sector} has ${data.length} bytes`);
      data.copy(disk, sector * SECTOR);
      crc = zlib.crc32(data, crc);
    }
    if (u32(t, 64) === CHECKSUM_CRC32 && u32(t, 72) !== crc >>> 0) problems.push(`blkx at sector ${first}: checksum mismatch`);
    master.push(t.subarray(72, 76));
  }
  if (u32(k, 80) === CHECKSUM_CRC32 && u32(k, 88) !== zlib.crc32(buf.subarray(dataOff, dataOff + dataLen)) >>> 0) {
    problems.push('data fork checksum mismatch');
  }
  if (u32(k, 352) === CHECKSUM_CRC32 && u32(k, 360) !== zlib.crc32(Buffer.concat(master)) >>> 0) {
    problems.push('master checksum mismatch');
  }
  return { disk, problems, sectors, partitions: tables.length };
}
