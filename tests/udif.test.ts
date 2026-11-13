import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { readUdif, writeUdif } from '../scripts/macos/udif.mjs';

const dir = mkdtempSync(path.join(tmpdir(), 'udif-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('UDIF (.dmg) writer', () => {
  // 2.5 MiB: random data, a zero-filled stretch and a partial final chunk.
  const raw = Buffer.concat([randomBytes(1024 * 1024), Buffer.alloc(1024 * 1024), randomBytes(512 * 1024)]);
  const rawPath = path.join(dir, 'disk.raw');
  const dmgPath = path.join(dir, 'disk.dmg');
  writeFileSync(rawPath, raw);

  it('round-trips a disk image with valid checksums', () => {
    const info = writeUdif(rawPath, dmgPath);
    expect(info).toMatchObject({ sectors: raw.length / 512, partitions: 1 });
    const dmg = readFileSync(dmgPath);
    expect(dmg.toString('latin1', dmg.length - 512, dmg.length - 508)).toBe('koly');
    const back = readUdif(dmg);
    expect(back.problems).toEqual([]);
    expect(Buffer.compare(back.disk, raw)).toBe(0);
  });

  it('supports several partitions', () => {
    const multi = path.join(dir, 'multi.dmg');
    writeUdif(rawPath, multi, {
      partitions: [
        { name: 'first', startSector: 0, sectorCount: 100 },
        { name: 'rest', startSector: 100, sectorCount: raw.length / 512 - 100 },
      ],
    });
    const back = readUdif(readFileSync(multi));
    expect(back.partitions).toBe(2);
    expect(back.problems).toEqual([]);
    expect(Buffer.compare(back.disk, raw)).toBe(0);
  });

  it('detects corruption', () => {
    const dmg = readFileSync(dmgPath);
    dmg[10] ^= 0xff; // inside the first compressed chunk
    expect(() => {
      const r = readUdif(dmg);
      if (r.problems.length) throw new Error(r.problems.join('; '));
    }).toThrow();
  });

  it('rejects images that are not whole sectors', () => {
    const odd = path.join(dir, 'odd.raw');
    writeFileSync(odd, Buffer.alloc(1000));
    expect(() => writeUdif(odd, path.join(dir, 'odd.dmg'))).toThrow(/multiple of 512/);
  });
});
