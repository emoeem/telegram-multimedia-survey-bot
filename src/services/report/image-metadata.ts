export interface ReportImageMetadata { url: string; width?: number; height?: number; aspectRatio?: number; orientation?: "portrait" | "landscape" | "square"; pixelArea?: number; }

function bytes(url: string): Uint8Array | null {
  const match = /^data:image\/[^;]+;base64,(.+)$/.exec(url);
  if (!match) return null;
  try { const raw = atob(match[1]!); return Uint8Array.from(raw, (char) => char.charCodeAt(0)); } catch { return null; }
}

export function inspectReportImage(url: string): ReportImageMetadata {
  const result: ReportImageMetadata = { url };
  const data = bytes(url);
  if (!data) return result;
  let width: number | undefined; let height: number | undefined;
  if (data.length > 24 && data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47) {
    width = new DataView(data.buffer).getUint32(16); height = new DataView(data.buffer).getUint32(20);
  }
  if (!width && data.length > 4 && data[0] === 0xff && data[1] === 0xd8) {
    let offset = 2;
    while (offset + 8 < data.length) {
      if (data[offset] !== 0xff) { offset += 1; continue; }
      const marker = data[offset + 1]!;
      if (marker === 0xd8 || marker === 0xd9) { offset += 2; continue; }
      const length = (data[offset + 2]! << 8) | data[offset + 3]!;
      if (length < 2 || offset + length + 2 > data.length) break;
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
        height = (data[offset + 5]! << 8) | data[offset + 6]!;
        width = (data[offset + 7]! << 8) | data[offset + 8]!;
        break;
      }
      offset += length + 2;
    }
  }
  if (width && height) {
    const aspectRatio = width / height;
    return { ...result, width, height, aspectRatio, pixelArea: width * height, orientation: aspectRatio > 1.08 ? "landscape" : aspectRatio < .92 ? "portrait" : "square" };
  }
  return result;
}

export function reportImageByteSize(url: string): number {
  const comma = url.indexOf(",");
  if (comma < 0 || !url.slice(0, comma).includes(";base64")) return 0;
  const payload = url.slice(comma + 1).replace(/\s/g, "");
  return Math.max(0, Math.floor(payload.length * 3 / 4) - (payload.endsWith("==") ? 2 : payload.endsWith("=") ? 1 : 0));
}

export function reportImageHash(url: string): string {
  let hash = 2166136261;
  for (let index = 0; index < url.length; index += Math.max(1, Math.floor(url.length / 4096))) {
    hash ^= url.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `${url.length.toString(36)}-${(hash >>> 0).toString(36)}`;
}
