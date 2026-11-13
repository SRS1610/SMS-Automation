// Tidies an HFS+ volume image made by xorriso: libisofs leaves an allocation
// block or two marked "in use" that no file owns (padding). That is harmless,
// but Disk Utility's First Aid reports it, so release those blocks: clear them
// in the allocation bitmap and update the free-block count in both volume
// headers. Only volumes whose files fit in the catalog's own extent records
// are handled (true for xorriso output); anything else is left untouched.
import { readFileSync, writeFileSync } from 'node:fs';

const HEADER = 1024;
const ALT_HEADER_FROM_END = 1024;
const FORKS = { allocation: 112, extents: 192, catalog: 272, attributes: 352, startup: 432 };

function extentsAt(buf, forkOffset) {
  const list = [];
  for (let i = 0; i < 8; i++) {
    const start = buf.readUInt32BE(forkOffset + 16 + i * 8);
    const count = buf.readUInt32BE(forkOffset + 20 + i * 8);
    if (count) list.push([start, count]);
  }
  return list;
}

function readFork(img, blockSize, vh, forkOffset) {
  const size = Number(vh.readBigUInt64BE(forkOffset));
  const parts = extentsAt(vh, forkOffset).map(([s, c]) => img.subarray(s * blockSize, (s + c) * blockSize));
  return Buffer.concat(parts).subarray(0, size);
}

/** Returns how many orphaned blocks were released. */
export function releaseOrphanBlocks(path) {
  const img = readFileSync(path);
  const vh = img.subarray(HEADER, HEADER + 512);
  if (vh.toString('latin1', 0, 2) !== 'H+') throw new Error('Not an HFS+ volume');
  const blockSize = vh.readUInt32BE(40);
  const totalBlocks = vh.readUInt32BE(44);

  // Bail out if the extents-overflow file holds records: then not every extent is in the catalog.
  const overflow = readFork(img, blockSize, vh, FORKS.extents);
  if (overflow.length >= 14 + 10 && overflow.readUInt32BE(14 + 2) !== 0 && overflow.readUInt32BE(14 + 6) > 0) return 0;

  const used = new Uint8Array(totalBlocks);
  const mark = ([start, count]) => used.fill(1, start, Math.min(totalBlocks, start + count));
  for (const offset of Object.values(FORKS)) extentsAt(vh, offset).forEach(mark);
  used.fill(1, 0, Math.ceil((HEADER + 512) / blockSize)); // boot blocks + volume header
  used[Math.floor((img.length - ALT_HEADER_FROM_END) / blockSize)] = 1; // alternate volume header

  const catalog = readFork(img, blockSize, vh, FORKS.catalog);
  const nodeSize = catalog.readUInt16BE(14 + 18);
  let node = catalog.readUInt32BE(14 + 10); // first leaf
  while (node) {
    const base = node * nodeSize;
    const records = catalog.readUInt16BE(base + 10);
    for (let i = 0; i < records; i++) {
      const offset = base + catalog.readUInt16BE(base + nodeSize - 2 * (i + 1));
      const data = offset + 2 + catalog.readUInt16BE(offset);
      if (catalog.readUInt16BE(data) === 2) {
        // file record: data fork at +88, resource fork at +168
        extentsAt(catalog, data + 88).forEach(mark);
        extentsAt(catalog, data + 168).forEach(mark);
      }
    }
    node = catalog.readUInt32BE(base);
  }

  const bitmapExtents = extentsAt(vh, FORKS.allocation);
  const bitAddress = (block) => {
    let byte = block >> 3;
    for (const [start, count] of bitmapExtents) {
      const bytes = count * blockSize;
      if (byte < bytes) return start * blockSize + byte;
      byte -= bytes;
    }
    throw new Error('Allocation bitmap too small');
  };
  let released = 0;
  for (let block = 0; block < totalBlocks; block++) {
    const addr = bitAddress(block);
    const bit = 0x80 >> (block & 7);
    if (img[addr] & bit && !used[block]) {
      img[addr] &= ~bit;
      released += 1;
    }
  }
  if (released) {
    const free = vh.readUInt32BE(48) + released;
    img.writeUInt32BE(free, HEADER + 48);
    const alt = img.length - ALT_HEADER_FROM_END;
    if (img.toString('latin1', alt, alt + 2) === 'H+') img.writeUInt32BE(free, alt + 48);
    writeFileSync(path, img);
  }
  return released;
}
