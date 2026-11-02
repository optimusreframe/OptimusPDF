/**
 * Clasificacion de direcciones IP para la defensa anti-SSRF de `POST /api/html-snapshot`.
 *
 * Es codigo PURO (sin `node:net`): analiza el texto a mano para no depender de como cada version de Node interprete formas
 * raras, y para que el navegador pueda usarlo en la validacion en vivo del campo. Ante cualquier duda, la direccion se
 * considera BLOQUEADA (falla cerrado): una IP que no se pueda analizar no es publica.
 *
 * Que se bloquea:
 *   IPv4: 0/8, 10/8, 100.64/10 (CGNAT), 127/8, 169.254/16 (enlace local, incluye metadatos 169.254.169.254), 172.16/12,
 *         192.0.0/24, 192.0.2/24, 192.88.99/24, 192.168/16, 198.18/15, 198.51.100/24, 203.0.113/24, 224/4 (multicast),
 *         240/4 (reservadas, incluye 255.255.255.255).
 *   IPv6: TODO lo que no sea unicast global 2000::/3 (asi caen ::, ::1, fc00::/7 ULA, fe80::/10, ff00::/8, ::ffff:0:0/96
 *         mapeadas IPv4, 64:ff9b::/96 NAT64, ...) y, dentro de 2000::/3, la documentacion (2001:db8::/32), los protocolos
 *         IETF/Teredo (2001::/23), 6to4 (2002::/16, lleva una IPv4 dentro) y 3fff::/20.
 */

export type ParsedIp = { family: 4; bytes: number[] } | { family: 6; bytes: number[] };

/** IPv4 en decimal con puntos, estricta: cuatro partes 0-255 sin ceros a la izquierda ambiguos. */
export function parseIPv4(text: string): number[] | null {
  const parts = text.split(".");
  if (parts.length !== 4) return null;
  const bytes: number[] = [];
  for (const part of parts) {
    if (!/^(0|[1-9]\d{0,2})$/.test(part)) return null;
    const value = Number(part);
    if (value > 255) return null;
    bytes.push(value);
  }
  return bytes;
}

/** IPv6 en cualquiera de sus formas de texto (con `::`, con cola IPv4). Sin zona (`%eth0`): se rechaza. */
export function parseIPv6(input: string): number[] | null {
  let text = input;
  if (text.startsWith("[") && text.endsWith("]")) text = text.slice(1, -1);
  if (text.includes("%") || !/^[0-9a-fA-F:.]+$/.test(text)) return null;

  const doubleColon = text.indexOf("::");
  if (doubleColon !== text.lastIndexOf("::")) return null;

  const expandSide = (side: string): number[] | null => {
    if (side === "") return [];
    const groups = side.split(":");
    const words: number[] = [];
    for (let index = 0; index < groups.length; index += 1) {
      const group = groups[index];
      if (group.includes(".")) {
        // Cola IPv4: solo puede ir en la ultima posicion del texto completo.
        if (index !== groups.length - 1) return null;
        const v4 = parseIPv4(group);
        if (!v4) return null;
        words.push((v4[0] << 8) | v4[1], (v4[2] << 8) | v4[3]);
      } else {
        if (!/^[0-9a-fA-F]{1,4}$/.test(group)) return null;
        words.push(parseInt(group, 16));
      }
    }
    return words;
  };

  let words: number[];
  if (doubleColon === -1) {
    const all = expandSide(text);
    if (!all || all.length !== 8) return null;
    words = all;
  } else {
    const head = expandSide(text.slice(0, doubleColon));
    const tailText = text.slice(doubleColon + 2);
    const tail = expandSide(tailText);
    if (!head || !tail) return null;
    // Una cola IPv4 solo es valida al final del texto; `head` no puede contenerla.
    if (text.slice(0, doubleColon).includes(".")) return null;
    const missing = 8 - head.length - tail.length;
    if (missing < 1) return null;
    words = [...head, ...new Array<number>(missing).fill(0), ...tail];
  }

  const bytes: number[] = [];
  for (const word of words) bytes.push((word >> 8) & 0xff, word & 0xff);
  return bytes;
}

export function parseIp(text: string): ParsedIp | null {
  const v4 = parseIPv4(text);
  if (v4) return { family: 4, bytes: v4 };
  const v6 = parseIPv6(text);
  if (v6) return { family: 6, bytes: v6 };
  return null;
}

function inV4(bytes: number[], base: [number, number, number, number], prefix: number): boolean {
  let remaining = prefix;
  for (let index = 0; index < 4 && remaining > 0; index += 1) {
    const bits = Math.min(8, remaining);
    const mask = (0xff << (8 - bits)) & 0xff;
    if ((bytes[index] & mask) !== (base[index] & mask)) return false;
    remaining -= bits;
  }
  return true;
}

const BLOCKED_V4: ReadonlyArray<[[number, number, number, number], number]> = [
  [[0, 0, 0, 0], 8],
  [[10, 0, 0, 0], 8],
  [[100, 64, 0, 0], 10],
  [[127, 0, 0, 0], 8],
  [[169, 254, 0, 0], 16],
  [[172, 16, 0, 0], 12],
  [[192, 0, 0, 0], 24],
  [[192, 0, 2, 0], 24],
  [[192, 88, 99, 0], 24],
  [[192, 168, 0, 0], 16],
  [[198, 18, 0, 0], 15],
  [[198, 51, 100, 0], 24],
  [[203, 0, 113, 0], 24],
  [[224, 0, 0, 0], 4],
  [[240, 0, 0, 0], 4],
];

function inV6(bytes: number[], base: number[], prefix: number): boolean {
  let remaining = prefix;
  for (let index = 0; index < 16 && remaining > 0; index += 1) {
    const bits = Math.min(8, remaining);
    const mask = (0xff << (8 - bits)) & 0xff;
    if ((bytes[index] & mask) !== (base[index] & mask)) return false;
    remaining -= bits;
  }
  return true;
}

function v6Base(...words: number[]): number[] {
  const bytes: number[] = [];
  for (let index = 0; index < 8; index += 1) {
    const word = words[index] ?? 0;
    bytes.push((word >> 8) & 0xff, word & 0xff);
  }
  return bytes;
}

const GLOBAL_UNICAST_V6 = v6Base(0x2000);
const BLOCKED_INSIDE_GLOBAL_V6: ReadonlyArray<[number[], number]> = [
  [v6Base(0x2001, 0x0db8), 32], // documentacion
  [v6Base(0x2001, 0x0000), 23], // protocolos IETF, Teredo (2001::/32)
  [v6Base(0x2002), 16], // 6to4: lleva una IPv4 dentro
  [v6Base(0x3fff), 20], // documentacion
];

export function isBlockedParsedIp(ip: ParsedIp): boolean {
  if (ip.family === 4) return BLOCKED_V4.some(([base, prefix]) => inV4(ip.bytes, base, prefix));
  if (!inV6(ip.bytes, GLOBAL_UNICAST_V6, 3)) return true;
  return BLOCKED_INSIDE_GLOBAL_V6.some(([base, prefix]) => inV6(ip.bytes, base, prefix));
}

/** `true` si la direccion NO es publica o no se puede analizar (falla cerrado). */
export function isBlockedIp(text: string): boolean {
  const parsed = parseIp(text);
  return !parsed || isBlockedParsedIp(parsed);
}

/** Dos textos de IP son la misma direccion (compara bytes, no cadenas: `::1` == `0:0:0:0:0:0:0:1`). */
export function sameIp(a: string, b: string): boolean {
  const left = parseIp(a);
  const right = parseIp(b);
  if (!left || !right || left.family !== right.family) return false;
  return left.bytes.every((byte, index) => byte === right.bytes[index]);
}
