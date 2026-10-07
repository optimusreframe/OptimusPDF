import type { NextConfig } from "next";

const isDev = process.env.NODE_ENV === "development";

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
  manifest-src 'self';
  upgrade-insecure-requests;
`;

const nextConfig: NextConfig = {
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
