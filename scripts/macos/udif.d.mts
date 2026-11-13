export interface UdifPartition {
  name: string;
  startSector: number;
  sectorCount: number;
}
export function writeUdif(
  rawPath: string,
  outPath: string,
  options?: { partitions?: UdifPartition[] },
): { sectors: number; compressedBytes: number; partitions: number };
export function readUdif(buf: Buffer): { disk: Buffer; problems: string[]; sectors: number; partitions: number };
