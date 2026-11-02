/**
 * Dependencias DIRECTAS de ejecucion (`dependencies` de package.json) con la version y la licencia que declara cada paquete
 * instalado (`node_modules/<paquete>/package.json`). Generado una vez a partir de ellos; `licenses.test.ts` comprueba que esta
 * lista coincide con package.json y con lo instalado, asi que al subir una version o anadir un paquete la prueba falla hasta
 * actualizarla. Los datos no son inventados: se copian tal cual de los paquetes.
 */

export type PackageEntry = {
  name: string;
  version: string;
  /** Expresion SPDX tal como la declara el paquete. */
  license: string;
  /** Repositorio del proyecto (la carpeta, si vive dentro de un monorepo). */
  repo: string;
};

export const PACKAGES: readonly PackageEntry[] = [
  { name: "@cantoo/pdf-lib", version: "2.7.4", license: "MIT", repo: "https://github.com/cantoo-scribe/pdf-lib" },
  { name: "@huggingface/transformers", version: "4.2.0", license: "Apache-2.0", repo: "https://github.com/huggingface/transformers.js" },
  { name: "@mediabunny/mp3-encoder", version: "1.65.0", license: "MPL-2.0", repo: "https://github.com/Vanilagy/mediabunny/tree/HEAD/packages/mp3-encoder" },
  { name: "@mlc-ai/web-llm", version: "0.2.84", license: "Apache-2.0", repo: "https://github.com/mlc-ai/web-llm" },
  { name: "@pdf-lib/fontkit", version: "1.1.1", license: "MIT", repo: "https://github.com/Hopding/fontkit" },
  { name: "docx", version: "9.7.1", license: "MIT", repo: "https://github.com/dolanmiu/docx" },
  { name: "exceljs", version: "4.4.0", license: "MIT", repo: "https://github.com/exceljs/exceljs" },
  { name: "html-to-pdfmake", version: "2.5.33", license: "MIT", repo: "https://github.com/Aymkdn/html-to-pdfmake" },
  { name: "html2canvas", version: "1.4.1", license: "MIT", repo: "https://github.com/niklasvh/html2canvas" },
  { name: "jspdf", version: "4.2.1", license: "MIT", repo: "https://github.com/parallax/jsPDF" },
  { name: "jszip", version: "3.10.1", license: "(MIT OR GPL-3.0-or-later)", repo: "https://github.com/Stuk/jszip" },
  { name: "lucide-react", version: "1.27.0", license: "ISC", repo: "https://github.com/lucide-icons/lucide/tree/HEAD/packages/lucide-react" },
  { name: "mammoth", version: "1.12.0", license: "BSD-2-Clause", repo: "https://github.com/mwilliamson/mammoth.js" },
  { name: "mediabunny", version: "1.65.0", license: "MPL-2.0", repo: "https://github.com/Vanilagy/mediabunny" },
  { name: "motion", version: "14.0.0", license: "MIT", repo: "https://github.com/motiondivision/motion" },
  { name: "next", version: "16.2.12", license: "MIT", repo: "https://github.com/vercel/next.js" },
  { name: "parse5", version: "8.0.1", license: "MIT", repo: "https://github.com/inikulin/parse5" },
  { name: "pdfjs-dist", version: "6.1.200", license: "Apache-2.0", repo: "https://github.com/mozilla/pdf.js" },
  { name: "pdfmake", version: "0.3.11", license: "MIT", repo: "https://github.com/bpampuch/pdfmake" },
  { name: "pptxgenjs", version: "4.0.1", license: "MIT", repo: "https://github.com/gitbrent/PptxGenJS" },
  { name: "react", version: "19.2.4", license: "MIT", repo: "https://github.com/facebook/react/tree/HEAD/packages/react" },
  { name: "react-dom", version: "19.2.4", license: "MIT", repo: "https://github.com/facebook/react/tree/HEAD/packages/react-dom" },
  { name: "scanic", version: "1.5.1", license: "MIT", repo: "https://github.com/marquaye/scanic" },
  { name: "tesseract.js", version: "7.0.0", license: "Apache-2.0", repo: "https://github.com/naptha/tesseract.js" },
];
