/**
 * «Caja con contraseña»: cifra unos bytes con una contraseña usando
 * PBKDF2-SHA256 (600 000 iteraciones) -> AES-GCM-256, con PARAMETROS FIJOS,
 * y los descifra. Es el cifrado que ya usaba `signVaultFile.ts` (archivo de
 * una firma), extraido para que lo reutilicen otros contenedores (el
 * paquete de respaldo) SIN cambiar el formato en disco: los archivos que
 * los usuarios ya exportaron siguen abriendose (prueba «dorada» en
 * `__fixtures__/`).
 *
 * Una caja cifrada son dos piezas:
 *  - `header`: un JSON en UTF-8 {version, kind, kdf:{name,hash,iterations,
 *    salt}, iv}. Sus bytes EXACTOS se usan como dato asociado (AAD) del
 *    AES-GCM: tocar la sal, el IV, los parametros o una sola coma invalida
 *    el descifrado. Quien guarda la caja debe conservar esos bytes tal cual
 *    (no re-serializarlos).
 *  - `payload`: el cifrado (texto cifrado + etiqueta de 16 bytes).
 *
 * Errores (`PasswordBoxError.code`), sin filtrar mas de lo necesario:
 *  - `wrongPassword`: el descifrado fallo la autenticacion. Contraseña
 *    incorrecta y datos manipulados son INDISTINGUIBLES a proposito (AES-GCM
 *    no permite saberlo y no se le dice a quien ataca cual de las dos fue).
 *  - `corrupt`: la caja no tiene forma valida (cabecera ilegible, parametros
 *    del KDF distintos de los fijos, sal/IV de longitud mala, payload mas
 *    corto que la etiqueta). Se detecta ANTES de derivar ninguna clave: un
 *    archivo hostil no puede clavar el navegador con iteraciones ajenas.
 *  - `unavailable`: este navegador no expone `crypto.subtle` (http no
 *    seguro).
 *  - `needsPassword` / `invalidPassword`: contraseña ausente/vacia al
 *    descifrar o al cifrar.
 * Los mensajes de error son fijos; nunca incluyen la contraseña ni bytes.
 */

export const PASSWORD_BOX_ITERATIONS = 600_000;
export const PASSWORD_BOX_SALT_BYTES = 16;
export const PASSWORD_BOX_IV_BYTES = 12;
export const PASSWORD_BOX_TAG_BYTES = 16;
/** Una cabecera real pesa ~200 bytes; mas de esto no es una cabecera. */
export const PASSWORD_BOX_MAX_HEADER_BYTES = 4 * 1024;

const DEFAULT_KIND = "password-box";
const DEFAULT_VERSION = 1;

export type PasswordBoxEnvelope = {
  /** Bytes EXACTOS de la cabecera JSON (tambien son el AAD). */
  header: Uint8Array;
  /** Texto cifrado + etiqueta GCM. */
  payload: Uint8Array;
};

export type PasswordBoxErrorCode =
  | "wrongPassword"
  | "corrupt"
  | "unavailable"
  | "needsPassword"
  | "invalidPassword";

export class PasswordBoxError extends Error {
  readonly code: PasswordBoxErrorCode;
  constructor(code: PasswordBoxErrorCode) {
    super(code);
    this.name = "PasswordBoxError";
    this.code = code;
  }
}

export type PasswordBoxOptions = {
  /** Etiqueta del contenedor que usa la caja (p. ej. "signature-vault-encrypted"). */
  kind?: string;
  /** Version de formato de la caja. */
  version?: number;
};

/** `true` si este navegador expone WebCrypto (`crypto.subtle` falta en http no seguro). */
export function passwordBoxAvailable(): boolean {
  try {
    return Boolean(globalThis.crypto?.subtle);
  } catch {
    return false;
  }
}

const encoder = new TextEncoder();

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/** `null` si no es base64 canonico. */
function fromBase64(text: string): Uint8Array | null {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(text) || text.length % 4 !== 0) return null;
  try {
    const binary = atob(text);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}

function randomBytes(length: number): Uint8Array {
  return globalThis.crypto.getRandomValues(new Uint8Array(length));
}

async function deriveKey(
  password: string,
  salt: Uint8Array,
  usage: "encrypt" | "decrypt",
): Promise<CryptoKey> {
  const subtle = globalThis.crypto.subtle;
  // NFKC: la misma contraseña escrita con otra composicion Unicode (macOS
  // vs Windows, teclado movil) tiene que derivar la misma clave.
  const base = await subtle.importKey(
    "raw",
    encoder.encode(password.normalize("NFKC")) as BufferSource,
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  return subtle.deriveKey(
    {
      name: "PBKDF2",
      hash: "SHA-256",
      salt: salt as BufferSource,
      iterations: PASSWORD_BOX_ITERATIONS,
    },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    [usage],
  );
}

/** Sin `instanceof`: entre dominios (jsdom) no es fiable. */
function isBytes(value: unknown): value is Uint8Array {
  return Object.prototype.toString.call(value) === "[object Uint8Array]";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

type ParsedHeader = {
  salt: Uint8Array;
  iv: Uint8Array;
  kind: unknown;
  version: unknown;
};

/**
 * Type-guard a mano de la cabecera. Los parametros del KDF son EXACTOS:
 * aceptar `iterations` ajenas permitiria a un archivo hostil clavar el
 * navegador. `null` = cabecera sin forma valida.
 */
function parseHeader(header: Uint8Array): ParsedHeader | null {
  if (
    !isBytes(header) ||
    header.byteLength === 0 ||
    header.byteLength > PASSWORD_BOX_MAX_HEADER_BYTES
  ) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(header));
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  const kdf = parsed.kdf;
  if (!isRecord(kdf)) return null;
  if (
    kdf.name !== "PBKDF2" ||
    kdf.hash !== "SHA-256" ||
    kdf.iterations !== PASSWORD_BOX_ITERATIONS ||
    typeof kdf.salt !== "string" ||
    typeof parsed.iv !== "string"
  ) {
    return null;
  }
  const salt = fromBase64(kdf.salt);
  const iv = fromBase64(parsed.iv);
  if (
    !salt ||
    salt.length !== PASSWORD_BOX_SALT_BYTES ||
    !iv ||
    iv.length !== PASSWORD_BOX_IV_BYTES
  ) {
    return null;
  }
  return { salt, iv, kind: parsed.kind, version: parsed.version };
}

/**
 * Comprueba la FORMA de la caja (cabecera, parametros fijos, payload con
 * al menos la etiqueta) sin tocar la contraseña ni derivar nada. Lanza
 * `PasswordBoxError("corrupt")`. Con `expect` exige ademas `kind`/`version`.
 */
export function assertPasswordBoxShape(
  envelope: PasswordBoxEnvelope,
  expect?: { kind: string; version: number },
): void {
  const header = isRecord(envelope) ? parseHeader(envelope.header) : null;
  if (
    !header ||
    !isBytes(envelope.payload) ||
    envelope.payload.byteLength < PASSWORD_BOX_TAG_BYTES
  ) {
    throw new PasswordBoxError("corrupt");
  }
  if (expect && (header.kind !== expect.kind || header.version !== expect.version)) {
    throw new PasswordBoxError("corrupt");
  }
}

/**
 * Cifra `bytes` con `password`. Sal e IV nuevos en cada llamada. Lanza
 * `PasswordBoxError` (`invalidPassword` si la contraseña esta vacia,
 * `unavailable` sin WebCrypto).
 */
export async function encryptWithPassword(
  bytes: Uint8Array,
  password: string,
  opts: PasswordBoxOptions = {},
): Promise<PasswordBoxEnvelope> {
  if (typeof password !== "string" || password === "") {
    throw new PasswordBoxError("invalidPassword");
  }
  if (!passwordBoxAvailable()) throw new PasswordBoxError("unavailable");

  const salt = randomBytes(PASSWORD_BOX_SALT_BYTES);
  const iv = randomBytes(PASSWORD_BOX_IV_BYTES);
  // `new Uint8Array(...)`: el `TextEncoder` de jsdom devuelve un Uint8Array de
  // OTRO dominio que JSZip no reconoce; copiarlo lo deja del dominio actual.
  const header = new Uint8Array(
    encoder.encode(
      JSON.stringify({
        version: opts.version ?? DEFAULT_VERSION,
        kind: opts.kind ?? DEFAULT_KIND,
        kdf: {
          name: "PBKDF2",
          hash: "SHA-256",
          iterations: PASSWORD_BOX_ITERATIONS,
          salt: toBase64(salt),
        },
        iv: toBase64(iv),
      }),
    ),
  );
  const key = await deriveKey(password, salt, "encrypt");
  const payload = new Uint8Array(
    await globalThis.crypto.subtle.encrypt(
      {
        name: "AES-GCM",
        iv: iv as BufferSource,
        additionalData: header as BufferSource,
      },
      key,
      bytes as BufferSource,
    ),
  );
  return { header, payload };
}

/**
 * Descifra una caja. Orden de comprobaciones (no cambiarlo: la UI depende
 * de el): forma (`corrupt`) -> WebCrypto (`unavailable`) -> contraseña
 * presente (`needsPassword`) -> autenticacion (`wrongPassword`).
 */
export async function decryptWithPassword(
  envelope: PasswordBoxEnvelope,
  password: string | undefined,
  expect?: { kind: string; version: number },
): Promise<Uint8Array> {
  assertPasswordBoxShape(envelope, expect);
  const header = parseHeader(envelope.header) as ParsedHeader;
  if (!passwordBoxAvailable()) throw new PasswordBoxError("unavailable");
  if (!password) throw new PasswordBoxError("needsPassword");

  try {
    const key = await deriveKey(password, header.salt, "decrypt");
    return new Uint8Array(
      await globalThis.crypto.subtle.decrypt(
        {
          name: "AES-GCM",
          iv: header.iv as BufferSource,
          // Los bytes EXACTOS de la cabecera del archivo, no una
          // re-serializacion: cualquier cambio rompe el descifrado.
          additionalData: envelope.header as BufferSource,
        },
        key,
        envelope.payload as BufferSource,
      ),
    );
  } catch {
    throw new PasswordBoxError("wrongPassword");
  }
}
