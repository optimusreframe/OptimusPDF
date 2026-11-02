import { createSnapshotHandler } from "@/lib/htmlSnapshot/handler";

/**
 * `POST /api/html-snapshot` · «HTML a PDF» consulta una direccion web DESDE EL SERVIDOR (el navegador no puede leer otras
 * webs por CORS) y devuelve una pagina HTML autocontenida y ya saneada. El PDF se sigue creando en el dispositivo.
 * Es un proxy hacia Internet: todas las defensas (anti-SSRF, limites, abuso) estan en `src/lib/htmlSnapshot/`.
 */

/** Necesita `node:dns`, `node:http(s)` y `node:zlib`: no puede ser Edge. */
export const runtime = "nodejs";
/** Siempre se evalua en cada peticion (y la respuesta lleva `no-store`). */
export const dynamic = "force-dynamic";
/** El plazo interno es de 10 s (`SNAPSHOT_LIMITS.totalTimeoutMs`); el resto es margen para construir la respuesta. */
export const maxDuration = 20;

const handle = createSnapshotHandler();

export function POST(request: Request): Promise<Response> {
  return handle(request);
}
