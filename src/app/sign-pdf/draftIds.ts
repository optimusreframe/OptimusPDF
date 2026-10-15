/*
 * Ids de borrador y de pestana de Firmar (F0-fix: D1 y D3 de la verificacion independiente de la Fase 0). Sin React ni
 * IndexedDB.
 *
 *  - D3: el borrador de UN documento suelto ya NO se llama como la huella del PDF (dos clientes con la misma plantilla
 *    se pisaban): cada sesion de trabajo tiene el suyo, `huella (mitad) + nonce de sesion`. Conserva la forma de una
 *    huella (64 caracteres hexadecimales) para que las URL (`?s=`, `?resume=`) y Recientes sigan validandolo igual, y
 *    la huella completa va aparte, como campo del borrador (`DraftMeta.fingerprint`).
 *  - D1: cada pestana tiene un id propio (`newTabId`) con el que firma sus escrituras: asi se distingue «escribi yo» de
 *    «escribio otra pestana» al comprobar versiones.
 */

/** `bytes` bytes aleatorios en hexadecimal (`crypto.getRandomValues`; sin el, `Math.random`). */
export function randomHex(bytes: number): string {
  const buffer = new Uint8Array(bytes);
  if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
    crypto.getRandomValues(buffer);
  } else {
    for (let index = 0; index < bytes; index += 1) buffer[index] = Math.floor(Math.random() * 256);
  }
  return Array.from(buffer, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Id de esta pestana: distinto en cada carga de pagina. */
export function newTabId(): string {
  return `t-${randomHex(8)}`;
}

/**
 * Id nuevo para el borrador de un documento suelto: los 32 primeros caracteres de la huella mas 32 de nonce aleatorio.
 * 64 hexadecimales, igual que una huella: pasa `isValidResumeId("sign", ...)` y no hace falta tocar ninguna URL.
 * Una huella que no sea hexadecimal (solo en pruebas) se rellena con ceros.
 */
export function newDocumentDraftId(fingerprint: string): string {
  const head = fingerprint.toLowerCase().replace(/[^0-9a-f]/g, "0").padEnd(32, "0").slice(0, 32);
  return head + randomHex(16);
}

/** Id nuevo para la copia aparte de una sesion (misma forma que `newSessionId`: `s-<tiempo>-<resto>`). */
export function newSessionCopyId(): string {
  return `s-${Date.now().toString(36)}-c${randomHex(6)}`;
}
