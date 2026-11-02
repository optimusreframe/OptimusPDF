import { parseIp, isBlockedParsedIp } from "@/lib/htmlSnapshot/ipGuard";
import { SNAPSHOT_LIMITS, type SnapshotErrorCode } from "@/lib/htmlSnapshot/types";

/**
 * Validacion SINTACTICA de la direccion que se va a consultar (sin red ni DNS). La usan:
 *   - la ruta de servidor, como primera barrera y de nuevo en CADA redireccion y CADA recurso;
 *   - el navegador, para avisar en vivo mientras se escribe (la ruta repite todo: la del navegador es solo comodidad).
 *
 * Reglas: solo `http:`/`https:`, puertos 80/443 (el explicito o el de por defecto), sin usuario ni contrasena, sin
 * `localhost`, `*.local`, `*.internal`... ni nombres de una sola etiqueta (`intranet`), y sin IP literal privada o reservada.
 * El analizador de URL de WHATWG ya normaliza las formas raras de IPv4 (`http://2130706433/`, `http://0x7f.1/`,
 * `http://127.1/` -> `127.0.0.1`), asi que aqui se comprueba el nombre ya normalizado.
 */

export type UrlCheck =
  | { ok: true; url: URL; hostname: string; literalIp: string | null }
  | { ok: false; code: Extract<SnapshotErrorCode, "invalid-url" | "blocked-address"> };

const ALLOWED_PORTS = new Set(["", "80", "443"]);

/** Sufijos de nombres que nunca son publicos. */
const PRIVATE_SUFFIXES = [
  ".localhost",
  ".local",
  ".internal",
  ".localdomain",
  ".home.arpa",
  ".lan",
  ".intranet",
  ".corp",
  ".private",
  ".invalid",
  ".test",
  ".example",
];

/** Caracteres de control y espacios dentro de la direccion: el analizador los ignora y eso permite camuflar cosas. */
const HAS_CONTROL_OR_SPACE = new RegExp("[\\u0000-\\u0020\\u007f-\\u009f]");

/** Se comprueba DESPUES de la clase de direccion: `localhost:3000` se explica como privada, no como «puerto raro». */
function portAllowed(url: URL): boolean {
  return ALLOWED_PORTS.has(url.port);
}

export function validateSnapshotUrl(raw: string): UrlCheck {
  if (typeof raw !== "string") return { ok: false, code: "invalid-url" };
  const text = raw.trim();
  if (text === "" || text.length > SNAPSHOT_LIMITS.maxUrlLength) return { ok: false, code: "invalid-url" };
  if (HAS_CONTROL_OR_SPACE.test(text)) return { ok: false, code: "invalid-url" };

  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return { ok: false, code: "invalid-url" };
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") return { ok: false, code: "invalid-url" };
  if (url.username !== "" || url.password !== "") return { ok: false, code: "invalid-url" };

  // `URL.hostname` ya viene en minusculas y en punycode; el punto final (`example.com.`) se quita para comparar.
  let hostname = url.hostname;
  if (hostname === "") return { ok: false, code: "invalid-url" };
  if (hostname.endsWith(".") && !hostname.startsWith("[")) hostname = hostname.slice(0, -1);
  if (hostname === "" || hostname.length > 253) return { ok: false, code: "invalid-url" };

  // IP literal (IPv6 entre corchetes, IPv4 normalizada).
  const bare = hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
  const ip = parseIp(bare);
  if (ip) {
    if (isBlockedParsedIp(ip)) return { ok: false, code: "blocked-address" };
    return portAllowed(url) ? { ok: true, url, hostname: bare, literalIp: bare } : { ok: false, code: "invalid-url" };
  }
  // Algo con forma de IP que no se pudo analizar (p. ej. `[::ffff:zzzz]` ya lo habria rechazado `URL`): se bloquea.
  if (hostname.startsWith("[")) return { ok: false, code: "blocked-address" };

  if (hostname === "localhost" || PRIVATE_SUFFIXES.some((suffix) => hostname.endsWith(suffix))) {
    return { ok: false, code: "blocked-address" };
  }
  // Nombre de una sola etiqueta (`intranet`, `router`): solo se resuelve dentro de una red privada.
  if (!hostname.includes(".")) return { ok: false, code: "blocked-address" };

  return portAllowed(url) ? { ok: true, url, hostname, literalIp: null } : { ok: false, code: "invalid-url" };
}

/**
 * Lo que escribe una persona en el campo -> la direccion que se envia. Sin esquema se asume `https://` (` ejemplo.com/pagina `).
 * No decide nada de seguridad: eso es `validateSnapshotUrl`.
 */
export function normalizeTypedAddress(typed: string): string {
  const text = typed.trim();
  if (text === "") return "";
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) return text;
  // `javascript:...`, `data:...`, `mailto:...` y demas esquemas sin `//` NO se corrigen: se dejan para que fallen.
  if (/^[a-z][a-z0-9+.-]*:/i.test(text) && !/^[^/?#]*:\d+(?:[/?#]|$)/.test(text)) return text;
  return `https://${text.replace(/^\/\//, "")}`;
}
