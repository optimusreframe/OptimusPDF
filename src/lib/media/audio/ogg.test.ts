import { describe, expect, it } from "vitest";
import { muxOggOpus, OPUS_PRE_SKIP } from "@/lib/media/audio/ogg";
import { probeMedia } from "@/lib/media/audio/probe";

type Page = { flags: number; granule: number; serial: number; sequence: number; segments: number[]; body: Uint8Array; crcOk: boolean };

/** Lector de paginas Ogg para comprobar lo que escribe `muxOggOpus` (incluida la suma CRC). */
function readPages(bytes: Uint8Array): Page[] {
  const pages: Page[] = [];
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let r = i << 24;
    for (let k = 0; k < 8; k += 1) r = r & 0x80000000 ? (r << 1) ^ 0x04c11db7 : r << 1;
    table[i] = r >>> 0;
  }
  let pos = 0;
  while (pos < bytes.length) {
    expect(String.fromCharCode(...bytes.subarray(pos, pos + 4))).toBe("OggS");
    const view = new DataView(bytes.buffer, bytes.byteOffset + pos);
    const count = bytes[pos + 26];
    const segments = Array.from(bytes.subarray(pos + 27, pos + 27 + count));
    const bodyLength = segments.reduce((a, b) => a + b, 0);
    const length = 27 + count + bodyLength;
    const copy = bytes.slice(pos, pos + length);
    const stored = view.getUint32(22, true);
    new DataView(copy.buffer).setUint32(22, 0, true);
    let crc = 0;
    for (const byte of copy) crc = ((crc << 8) ^ table[((crc >>> 24) ^ byte) & 0xff]) >>> 0;
    pages.push({
      flags: bytes[pos + 5],
      granule: view.getUint32(6, true) + view.getUint32(10, true) * 4294967296,
      serial: view.getUint32(14, true),
      sequence: view.getUint32(18, true),
      segments,
      body: bytes.slice(pos + 27 + count, pos + length),
      crcOk: crc === stored,
    });
    pos += length;
  }
  return pages;
}

const packets = (count: number, size = 60) => Array.from({ length: count }, (_, i) => ({ data: Uint8Array.from({ length: size }, (_, k) => (i + k) & 255), samples: 960 }));

describe("muxOggOpus", () => {
  const frames48k = 100 * 960 - 400; // la ultima trama va rellena: 400 muestras de sobra
  const blob = muxOggOpus(packets(100), { channels: 2, inputSampleRate: 44100, inputFrames48k: frames48k });

  it("estructura: OpusHead (BOS), OpusTags y paginas de audio con la ultima marcada EOS, todas con CRC correcto y numeracion seguida", async () => {
    const pages = readPages(new Uint8Array(await blob.arrayBuffer()));
    expect(pages.length).toBeGreaterThanOrEqual(4);
    expect(pages.every((page) => page.crcOk)).toBe(true);
    expect(pages.map((page) => page.sequence)).toEqual(pages.map((_, i) => i));
    expect(new Set(pages.map((page) => page.serial)).size).toBe(1);
    expect(pages[0].flags).toBe(0x02);
    expect(String.fromCharCode(...pages[0].body.subarray(0, 8))).toBe("OpusHead");
    expect(pages[0].body[9]).toBe(2); // canales
    expect(new DataView(pages[0].body.buffer).getUint16(10, true)).toBe(OPUS_PRE_SKIP);
    expect(new DataView(pages[0].body.buffer).getUint32(12, true)).toBe(44100);
    expect(String.fromCharCode(...pages[1].body.subarray(0, 8))).toBe("OpusTags");
    expect(pages[pages.length - 1].flags).toBe(0x04);
    expect(pages.slice(0, -1).every((page) => (page.flags & 0x04) === 0)).toBe(true);
  });

  it("la posicion granular crece y la ultima pagina recorta el relleno (preskip + muestras reales)", async () => {
    const pages = readPages(new Uint8Array(await blob.arrayBuffer())).slice(2);
    for (let i = 1; i < pages.length; i += 1) expect(pages[i].granule).toBeGreaterThan(pages[i - 1].granule);
    expect(pages[pages.length - 1].granule).toBe(OPUS_PRE_SKIP + frames48k);
  });

  it("el contenido de los paquetes llega intacto y en orden", async () => {
    const pages = readPages(new Uint8Array(await blob.arrayBuffer())).slice(2);
    const body = new Uint8Array(pages.reduce((sum, page) => sum + page.body.length, 0));
    let offset = 0;
    for (const page of pages) {
      body.set(page.body, offset);
      offset += page.body.length;
    }
    packets(100).forEach((packet, i) => expect(Array.from(body.subarray(i * 60, (i + 1) * 60))).toEqual(Array.from(packet.data)));
  });

  it("un paquete de 255 bytes o mas usa lacing correcto (255 + resto, y un 0 si es multiplo)", async () => {
    const big = muxOggOpus([{ data: new Uint8Array(510), samples: 960 }, { data: new Uint8Array(300), samples: 960 }], { channels: 1, inputSampleRate: 48000, inputFrames48k: 1920 });
    const pages = readPages(new Uint8Array(await big.arrayBuffer()));
    expect(pages[2].segments).toEqual([255, 255, 0, 255, 45]);
    expect(pages.every((page) => page.crcOk)).toBe(true);
  });

  it("la sonda lo reconoce como Ogg Opus de 48 kHz con la duracion correcta", async () => {
    const probe = await probeMedia(blob);
    expect(probe.kind).toBe("ogg");
    expect(probe.sampleRate).toBe(48000);
    expect(probe.channels).toBe(2);
    expect(probe.durationSec).toBeCloseTo(frames48k / 48000, 3);
  });
});
