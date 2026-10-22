import { readFileSync } from "node:fs";
import type { NextConfig } from "next";

const isDev = process.env.NODE_ENV === "development";

/**
 * `upgrade-insecure-requests` solo tiene sentido sobre https. WebKit (Safari y el WebKit de Playwright) lo aplica
 * TAMBIEN a `http://localhost`: reescribe cada subrecurso a `https://localhost:<puerto>` (sin TLS), con lo que el CSS y
 * los scripts no cargan y la pagina queda en blanco. Chrome y Firefox exentan los origenes de bucle local. Por eso la
 * directiva se omite en desarrollo y, al construir, con `CSP_SKIP_UPGRADE_INSECURE=1` (pruebas E2E en WebKit contra una
 * build de produccion servida por http). Un despliegue normal (sin esa variable) emite la directiva igual que siempre.
 */
const skipUpgradeInsecure = isDev || process.env.CSP_SKIP_UPGRADE_INSECURE === "1";

/**
 * Dominios externos reales usados por este proyecto (verificados a mano
 * contra el codigo instalado y peticiones HTTP reales, no supuestos):
 *
 * - `huggingface.co` / `*.huggingface.co` / `*.hf.co`: pesos de los
 *   modelos de WebLLM (`pdf-summarizer`) y de Transformers.js
 *   (`translate-pdf`, pares Xenova/opus-mt-*). Los ficheros grandes (LFS)
 *   redirigen a subdominios de almacenamiento bajo `hf.co`, por ejemplo
 *   `us.aws.cdn.hf.co` -- cubierto por `*.hf.co`.
 * - `raw.githubusercontent.com`: binarios `.wasm` del motor de WebLLM
 *   (`mlc-ai/binary-mlc-llm-libs`).
 * - `cdn.jsdelivr.net`: tesseract.js (usado por `ocr-pdf` y como
 *   respaldo de OCR en `translate-pdf`) descarga desde aqui su script de
 *   worker, el nucleo WASM y los datos de idioma por defecto -- NO desde
 *   "tessdata.projectnaptha.com" (una CDN antigua que esta version del
 *   paquete ya no usa; confirmado leyendo
 *   `node_modules/tesseract.js/src/worker/browser/defaultOptions.js` y
 *   `node_modules/tesseract.js/src/worker-script/index.js`).
 *
 * `script-src` necesita ademas `blob:`: onnxruntime-web (el motor detras
 * de `@huggingface/transformers`) resuelve su backend WASM con un
 * `import()` dinamico de un modulo servido desde una blob: URL, no solo
 * desde un Worker -- confirmado en vivo contra el build de produccion:
 * sin `blob:` aqui, `translate-pdf` fallaba con "no available backend
 * found ... Failed to fetch dynamically imported module: blob:...".
 */
const contentSecurityPolicy = `
  default-src 'self';
  script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval' blob: https://cdn.jsdelivr.net${isDev ? " 'unsafe-eval'" : ""};
  style-src 'self' 'unsafe-inline';
  img-src 'self' blob: data:;
  font-src 'self' data:;
  connect-src
    'self'
    https://huggingface.co
    https://*.huggingface.co
    https://*.hf.co
    https://raw.githubusercontent.com
    https://cdn.jsdelivr.net;
  worker-src 'self' blob:;
  child-src 'self' blob:;
  media-src 'self' blob:;
  object-src 'none';
  base-uri 'self';
  form-action 'self';
  frame-ancestors 'none';
  manifest-src 'self';${skipUpgradeInsecure ? "" : "\n  upgrade-insecure-requests;"}
`;

/**
 * Version de pdf.js: la URL del worker lleva `?v=<version>` (`PDF_WORKER_SRC`), asi se puede cachear un año sin que
 * una actualizacion de la libreria sirva un worker de otra version.
 */
function pdfjsVersion(): string {
  try {
    return (JSON.parse(readFileSync("node_modules/pdfjs-dist/package.json", "utf8")) as { version: string }).version;
  } catch {
    return "0";
  }
}

const nextConfig: NextConfig = {
  env: { NEXT_PUBLIC_PDFJS_VERSION: pdfjsVersion() },
  async redirects() {
    return [
      // "/tools" era una copia exacta del catalogo que ya vive en "/"
      // (mismo `ToolCatalogGrid`) -- se elimino en vez de mantener dos
      // rutas. El navegador conserva el fragmento ("#organizar") del
      // enlace original al no haber uno propio en el destino.
      {
        source: "/tools",
        destination: "/",
        permanent: true,
      },
    ];
  },
  async headers() {
    return [
      // Sin conexion: el worker de pdf.js (uno por documento abierto) y sus fuentes de reemplazo salen de la cache.
      {
        source: "/pdf.worker.min.mjs",
        headers: [{ key: "Cache-Control", value: "public, max-age=31536000, immutable" }],
      },
      {
        source: "/standard_fonts/:path*",
        headers: [{ key: "Cache-Control", value: "public, max-age=2592000" }],
      },
      // Decodificadores WASM de pdf.js (JPX, JBIG2, ICC): los pide cada documento con imagenes de esos formatos.
      {
        source: "/pdfjs-wasm/:path*",
        headers: [{ key: "Cache-Control", value: "public, max-age=2592000" }],
      },
      {
        source: "/(.*)",
        headers: [
          {
            key: "Content-Security-Policy",
            value: contentSecurityPolicy.replace(/\s{2,}/g, " ").trim(),
          },
          {
            key: "Referrer-Policy",
            value: "strict-origin-when-cross-origin",
          },
          {
            key: "X-Content-Type-Options",
            value: "nosniff",
          },
          {
            key: "X-Frame-Options",
            value: "DENY",
          },
          {
            key: "Permissions-Policy",
            // camera=(self): necesario para scan-to-pdf. El resto se
            // deniega: esta app no usa microfono, geolocalizacion, pagos
            // ni USB.
            value:
              "camera=(self), microphone=(), geolocation=(), payment=(), usb=()",
          },
        ],
      },
    ];
  },
};

export default nextConfig;
