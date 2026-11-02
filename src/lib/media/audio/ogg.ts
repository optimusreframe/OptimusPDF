/**
 * Ogg Opus (RFC 3533 + RFC 7845): empaqueta los paquetes que produce `AudioEncoder` ("opus") en un archivo `.opus`.
 * Solo escritura: es lo unico que hace falta para exportar.
 */

export type OpusPacket = {
  data: Uint8Array;
  /** Muestras a 48 kHz que cubre el paquete (960 para 20 ms). */
  samples: number;
};

/** Retraso del codificador Opus a 48 kHz que el decodificador descarta al principio (`OPUS_GET_LOOKAHEAD`). */
export const OPUS_PRE_SKIP = 312;

let crcTable: Uint32Array | null = null;
function crc32Ogg(bytes: Uint8Array): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let i = 0; i < 256; i += 1) {
      let r = i << 24;
      for (let k = 0; k < 8; k += 1) r = r & 0x80000000 ? (r << 1) ^ 0x04c11db7 : r << 1;
      crcTable[i] = r >>> 0;
    }
  }
  let crc = 0;
  for (let i = 0; i < bytes.length; i += 1) crc = ((crc << 8) ^ crcTable[((crc >>> 24) ^ bytes[i]) & 0xff]) >>> 0;
  return crc >>> 0;
}

/** Pagina Ogg con los paquetes dados completos (cada uno cabe entero, sin continuacion entre paginas). */
function buildPage(packets: Uint8Array[], granule: number, serial: number, sequence: number, flags: number): Uint8Array {
  const lacing: number[] = [];
  let bodyLength = 0;
  for (const packet of packets) {
    let remaining = packet.length;
    while (remaining >= 255) {
      lacing.push(255);
      remaining -= 255;
    }
    lacing.push(remaining);
    bodyLength += packet.length;
  }
  const page = new Uint8Array(27 + lacing.length + bodyLength);
  const view = new DataView(page.buffer);
  page.set([0x4f, 0x67, 0x67, 0x53], 0); // "OggS"
  page[4] = 0; // version
  page[5] = flags;
  // Posicion granular de 64 bits (little endian).
  view.setUint32(6, granule % 4294967296, true);
  view.setUint32(10, Math.floor(granule / 4294967296), true);
  view.setUint32(14, serial, true);
  view.setUint32(18, sequence, true);
  page[26] = lacing.length;
  page.set(lacing, 27);
  let offset = 27 + lacing.length;
  for (const packet of packets) {
    page.set(packet, offset);
    offset += packet.length;
  }
  view.setUint32(22, crc32Ogg(page), true);
  return page;
}

function opusHead(channels: number, inputRate: number, preSkip: number): Uint8Array {
  const head = new Uint8Array(19);
  const view = new DataView(head.buffer);
  head.set(Array.from("OpusHead", (c) => c.charCodeAt(0)), 0);
  head[8] = 1;
  head[9] = channels;
  view.setUint16(10, preSkip, true);
  view.setUint32(12, inputRate, true);
  view.setInt16(16, 0, true);
  head[18] = 0; // familia de canales 0: mono o estereo
  return head;
}

function opusTags(): Uint8Array {
  const vendor = "OptimusPDF";
  const tags = new Uint8Array(8 + 4 + vendor.length + 4);
  const view = new DataView(tags.buffer);
  tags.set(Array.from("OpusTags", (c) => c.charCodeAt(0)), 0);
  view.setUint32(8, vendor.length, true);
  tags.set(Array.from(vendor, (c) => c.charCodeAt(0)), 12);
  view.setUint32(12 + vendor.length, 0, true); // sin comentarios
  return tags;
}

/**
 * Construye el archivo. `inputFrames48k` es el numero de muestras REALES a 48 kHz (sin el relleno de la ultima trama):
 * la posicion granular de la ultima pagina las marca para que el decodificador recorte el sobrante.
 */
export function muxOggOpus(
  packets: OpusPacket[],
  options: { channels: number; inputSampleRate: number; inputFrames48k: number; preSkip?: number; serial?: number },
): Blob {
  const preSkip = options.preSkip ?? OPUS_PRE_SKIP;
  const serial = options.serial ?? 0x4f505453;
  const pages: Uint8Array[] = [];
  let sequence = 0;
  pages.push(buildPage([opusHead(options.channels, options.inputSampleRate, preSkip)], 0, serial, sequence, 0x02));
  sequence += 1;
  pages.push(buildPage([opusTags()], 0, serial, sequence, 0));
  sequence += 1;

  // Hasta ~48 paquetes (~1 s) por pagina y nunca mas de 255 segmentos de lacing.
  let index = 0;
  let decoded = 0;
  while (index < packets.length) {
    const group: Uint8Array[] = [];
    let segments = 0;
    let groupSamples = 0;
    while (index < packets.length && group.length < 48) {
      const need = Math.floor(packets[index].data.length / 255) + 1;
      if (segments + need > 255) break;
      group.push(packets[index].data);
      groupSamples += packets[index].samples;
      segments += need;
      index += 1;
    }
    decoded += groupSamples;
    const last = index >= packets.length;
    const granule = last ? preSkip + options.inputFrames48k : preSkip + decoded;
    pages.push(buildPage(group, Math.min(granule, preSkip + decoded), serial, sequence, last ? 0x04 : 0));
    sequence += 1;
  }
  return new Blob(pages as BlobPart[], { type: "audio/ogg" });
}
