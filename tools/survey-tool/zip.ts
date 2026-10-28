/**
 * 极简 ZIP 打包器（deflate / store 双模）。
 *
 * 为什么自己写而不是装依赖：这个工具要编译成单文件二进制，每多一个依赖就多
 * 一份打包体积和一条供应链。ZIP 的「多文件下载」需求只用得到最朴素的子集——
 * 不需要 ZIP64（导出的问卷 PDF 也就几 MB）、不需要加密、不需要分卷。90 行够了。
 *
 * 不写 ZIP 只逐个下载：浏览器会拦连续触发的多次下载，用户看到的是「只下到一个
 * 文件」，而这一整个功能的意义就是批量。
 */

import { deflateRawSync } from "node:zlib";

export interface ZipEntry {
  /** 归档内路径。用 `/` 分隔，不要以 `/` 开头。 */
  name: string;
  bytes: Uint8Array;
  /** 默认按扩展名判断；文本类走 deflate，已压缩过的（png/jpg/pdf/zip）走 store。 */
  compress?: boolean;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let index = 0; index < bytes.length; index += 1) {
    crc = CRC_TABLE[(crc ^ bytes[index]!) & 0xff]! ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** 已经压过的格式再 deflate 一次只是白烧 CPU，而且通常还会变大。 */
function shouldCompress(name: string): boolean {
  return !/\.(png|jpe?g|gif|webp|zip|gz|pdf|mp4|mp3)$/i.test(name);
}

/** MS-DOS 时间戳。ZIP 的老格式只认这个，1980 年以前会被钳住。 */
function dosDateTime(date: Date): { time: number; date: number } {
  const year = Math.max(1980, date.getFullYear());
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

class ByteWriter {
  private chunks: Uint8Array[] = [];
  private length = 0;

  get offset(): number {
    return this.length;
  }

  push(bytes: Uint8Array): void {
    this.chunks.push(bytes);
    this.length += bytes.length;
  }

  u16(value: number): void {
    const buffer = new Uint8Array(2);
    new DataView(buffer.buffer).setUint16(0, value & 0xffff, true);
    this.push(buffer);
  }

  u32(value: number): void {
    const buffer = new Uint8Array(4);
    new DataView(buffer.buffer).setUint32(0, value >>> 0, true);
    this.push(buffer);
  }

  concat(): Uint8Array {
    const out = new Uint8Array(this.length);
    let cursor = 0;
    for (const chunk of this.chunks) {
      out.set(chunk, cursor);
      cursor += chunk.length;
    }
    return out;
  }
}

export function buildZip(entries: ZipEntry[], now = new Date()): Uint8Array {
  const encoder = new TextEncoder();
  const { time, date } = dosDateTime(now);
  const body = new ByteWriter();
  const central = new ByteWriter();

  for (const entry of entries) {
    const nameBytes = encoder.encode(entry.name);
    const raw = entry.bytes;
    const wantDeflate = entry.compress ?? shouldCompress(entry.name);
    let method = 0;
    let payload = raw;
    if (wantDeflate && raw.length > 0) {
      try {
        // 必须用 `deflateRawSync`（无 zlib 头），ZIP 的 method 8 是 raw deflate。
        // Bun 的 `Bun.zlib` 在 1.4 里还不存在，`node:zlib` 是稳的。
        const deflated = deflateRawSync(raw, { level: 9 });
        // 只有真的更小才用压缩版本；对已经熵很高的内容 deflate 会略微变大。
        if (deflated.length < raw.length) {
          method = 8;
          payload = deflated;
        }
      } catch {
        method = 0;
      }
    }
    const checksum = crc32(raw);
    const localOffset = body.offset;

    body.u32(0x04034b50);
    body.u16(20);
    body.u16(0x0800); // UTF-8 文件名
    body.u16(method);
    body.u16(time);
    body.u16(date);
    body.u32(checksum);
    body.u32(payload.length);
    body.u32(raw.length);
    body.u16(nameBytes.length);
    body.u16(0);
    body.push(nameBytes);
    body.push(payload);

    central.u32(0x02014b50);
    central.u16(20);
    central.u16(20);
    central.u16(0x0800);
    central.u16(method);
    central.u16(time);
    central.u16(date);
    central.u32(checksum);
    central.u32(payload.length);
    central.u32(raw.length);
    central.u16(nameBytes.length);
    central.u16(0);
    central.u16(0);
    central.u16(0);
    central.u16(0);
    central.u32(0);
    central.u32(localOffset);
    central.push(nameBytes);
  }

  const centralOffset = body.offset;
  const centralBytes = central.concat();
  body.push(centralBytes);
  body.u32(0x06054b50);
  body.u16(0);
  body.u16(0);
  body.u16(entries.length);
  body.u16(entries.length);
  body.u32(centralBytes.length);
  body.u32(centralOffset);
  body.u16(0);

  return body.concat();
}
