import { deflateRawSync } from "node:zlib";
import { crc32 } from "@/app/sign-pdf/signVault";

/**
 * Forja de zips A MANO para las pruebas hostiles: JSZip no deja escribir un
 * directorio central que mienta, y la importacion tiene que sobrevivir a
 * justo eso. Solo lo usan las pruebas (usa `node:zlib`).
 */

export type ForgeEntry = {
  name: string;
  /** Contenido real (antes de comprimir). */
  data?: Uint8Array;
  method?: 0 | 8;
  /** Tamaños que declara el directorio central (por defecto, los reales). */
  declaredCompressed?: number;
  declaredUncompressed?: number;
  flags?: number;
  /** Campo extra del registro central. */
  extra?: Uint8Array;
  /** Bytes ya comprimidos a usar tal cual (para bombas sin generar el original). */
  rawPayload?: Uint8Array;
  crc?: number;
};

export type ForgeOptions = {
  /** Sobrescribe el numero de entradas del EOCD. */
  eocdEntries?: number;
  /** Sobrescribe el offset del directorio central. */
  eocdCdOffset?: number;
};

const encoder = new TextEncoder();

function u16(view: DataView, offset: number, value: number) {
  view.setUint16(offset, value, true);
}
function u32(view: DataView, offset: number, value: number) {
  view.setUint32(offset, value >>> 0, true);
}

export function forgeZip(entries: ForgeEntry[], opts: ForgeOptions = {}): Uint8Array {
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const entry of entries) {
    const data = entry.data ?? new Uint8Array();
    const method = entry.method ?? 8;
    const payload =
      entry.rawPayload ?? (method === 8 ? new Uint8Array(deflateRawSync(data)) : data);
    const name = encoder.encode(entry.name);
    const extra = entry.extra ?? new Uint8Array();
    const crc = entry.crc ?? crc32(data);
    const flags = entry.flags ?? 0x800;
    const cSize = entry.declaredCompressed ?? payload.length;
    const uSize = entry.declaredUncompressed ?? data.length;

    const local = new Uint8Array(30 + name.length);
    const lv = new DataView(local.buffer);
    u32(lv, 0, 0x04034b50);
    u16(lv, 4, 20);
    u16(lv, 6, flags);
    u16(lv, 8, method);
    u32(lv, 14, crc);
    u32(lv, 18, payload.length);
    u32(lv, 22, data.length);
    u16(lv, 26, name.length);
    u16(lv, 28, 0);
    local.set(name, 30);
    parts.push(local, payload);

    const cd = new Uint8Array(46 + name.length + extra.length);
    const cv = new DataView(cd.buffer);
    u32(cv, 0, 0x02014b50);
    u16(cv, 4, 20);
    u16(cv, 6, 20);
    u16(cv, 8, flags);
    u16(cv, 10, method);
    u32(cv, 16, crc);
    u32(cv, 20, cSize);
    u32(cv, 24, uSize);
    u16(cv, 28, name.length);
    u16(cv, 30, extra.length);
    u32(cv, 42, offset);
    cd.set(name, 46);
    cd.set(extra, 46 + name.length);
    central.push(cd);
    offset += local.length + payload.length;
  }
  const cdSize = central.reduce((sum, c) => sum + c.length, 0);
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  u32(ev, 0, 0x06054b50);
  u16(ev, 8, opts.eocdEntries ?? entries.length);
  u16(ev, 10, opts.eocdEntries ?? entries.length);
  u32(ev, 12, cdSize);
  u32(ev, 16, opts.eocdCdOffset ?? offset);
  const all = [...parts, ...central, eocd];
  const out = new Uint8Array(all.reduce((sum, p) => sum + p.length, 0));
  let pos = 0;
  for (const part of all) {
    out.set(part, pos);
    pos += part.length;
  }
  return out;
}
