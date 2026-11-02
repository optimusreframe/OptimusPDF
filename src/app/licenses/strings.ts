import type { Language } from "@/lib/i18n";

export type LinkItem = { label: string; href: string };

/** Algo que se incluye en la aplicacion y NO es un paquete de package.json (fuentes, decodificadores WebAssembly). */
export type AssetEntry = {
  name: string;
  /** Licencias tal como las indican los archivos de licencia que acompanan a cada cosa. */
  license: string;
  purpose: string;
  links: LinkItem[];
};

export type LicensesStrings = {
  title: string;
  subtitle: string;
  /** «Se actualiza con cada version…»: de donde salen los datos. */
  provenance: string;

  mp3: {
    title: string;
    intro: string;
    /** Texto de la mencion que pide LAME: se muestra en ingles, tal cual (con `lang="en"`). */
    noticeCaption: string;
    componentsTitle: string;
    /** Que hace cada componente, por nombre. */
    roles: { mediabunny: string; encoder: string; lame: string };
    lameLicense: string;
    complianceTitle: string;
    /** `{sha}` y `{tarball}` se rellenan con los datos de `lame.ts`. */
    compliance: string[];
    sourceTitle: string;
    sourceIntro: string;
    labelRepo: string;
    labelNpm: string;
    labelTarball: string;
    labelLameSite: string;
    labelLameSource: string;
    /** `{sha}` (SHA-256 del tar.gz de LAME 3.100). */
    lameSourceNote: string;
    textsTitle: string;
    replaceTitle: string;
    replace: string[];
  };

  packagesTitle: string;
  packagesIntro: string;
  packagesNote: string;
  fields: {
    version: string;
    license: string;
    usedUnder: string;
    onServer: string;
    repository: string;
    licenseText: string;
    npm: string;
    openInNewTab: string;
  };
  purposes: Record<string, string>;

  assetsTitle: string;
  assetsIntro: string;
  assets: AssetEntry[];

  modelsTitle: string;
  modelsBody: string;
  modelsLinkLabel: string;

  contactTitle: string;
  contactBody: string;
  contactLinkLabel: string;

  /** Enlace desde «El proyecto». */
  aboutTitle: string;
  aboutBody: string;
  aboutLinkLabel: string;
};

const es: LicensesStrings = {
  title: "Licencias y avisos de código abierto",
  subtitle:
    "OptimusPDF se apoya en software libre y de código abierto. Esta página dice, sin rodeos, qué componentes de terceros lleva la aplicación, con qué licencia, para qué se usan y dónde está su código.",
  provenance: "La lista sale de package.json y de los paquetes instalados; una prueba automática impide que se desactualice sin que nadie lo note.",

  mp3: {
    title: "Salida MP3",
    intro:
      "Cuando eliges MP3 como formato de salida (Convertidor de audio, Extraer audio y Audio Studio), el audio se codifica en tu dispositivo con tres componentes de código abierto. Se cargan solo en ese momento, desde nuestro propio servidor como el resto de la aplicación, y tu audio no sale de tu navegador.",
    noticeCaption: "Mención que pide el proyecto LAME. El enlace lleva a su sitio.",
    componentsTitle: "Componentes",
    roles: {
      mediabunny: "Arma el archivo .mp3 (tramas y cabecera) con el audio que sale del codificador.",
      encoder: "Ejecuta LAME en un proceso aparte (Worker) para no bloquear la página y le pasa el audio por trozos.",
      lame: "El codificador de MP3 propiamente dicho, compilado a WebAssembly dentro del paquete anterior.",
    },
    lameLicense: "LGPL, versión 2 o posterior",
    complianceTitle: "Cumplimiento de las licencias",
    compliance: [
      "Archivos sin modificar. No hemos cambiado el código de mediabunny ni de @mediabunny/mp3-encoder: se instalan desde npm en la versión exacta indicada arriba (el archivo de bloqueo de dependencias la fija) y la aplicación los incluye tal cual salen del paquete; el empaquetador solo los agrupa y minifica, como al resto del código.",
      "Código fuente. La licencia MPL-2.0 se aplica a nivel de archivo: cubre esos archivos y no el resto de la aplicación. Su código fuente, en la versión exacta que usamos, está en los enlaces de más abajo, junto con el paquete de npm.",
      "LAME. Se distribuye bajo la LGPL, versión 2 o posterior. No lo hemos modificado: el WebAssembly incluido se compiló a partir de LAME {version} sin cambios, con Emscripten {emscripten}, según declara el README del paquete. Hemos comprobado que el binario incluido en el paquete tiene el SHA-256 que ese README indica ({sha}).",
    ],
    sourceTitle: "Dónde está el código fuente",
    sourceIntro: "Versión exacta que usa la aplicación:",
    labelRepo: "Código en GitHub (etiqueta de la versión)",
    labelNpm: "Paquete en npm",
    labelTarball: "Archivo .tgz exacto",
    labelLameSite: "Sitio oficial de LAME",
    labelLameSource: "Código fuente de LAME 3.100",
    lameSourceNote: "Archivo lame-3.100.tar.gz, SHA-256 {sha} (según el README del paquete).",
    textsTitle: "Textos de las licencias",
    replaceTitle: "Cómo sustituir LAME",
    replace: [
      "LAME no va como un archivo aparte: su WebAssembly está incrustado dentro de @mediabunny/mp3-encoder, en el código del Worker que crea el paquete. Para usar otra versión de LAME, o una modificada, hay que reconstruir ese paquete y, después, la aplicación.",
      "El paquete es de código abierto y su compilación se puede reproducir: el repositorio y el README describen paso a paso cómo compilar LAME {version} a WebAssembly (Emscripten {emscripten}, las opciones exactas y el pequeño puente en C) y cómo construir el paquete. Con eso se obtiene un @mediabunny/mp3-encoder con tu versión de LAME, que se pone en su lugar en las dependencias de la aplicación.",
      "Hoy la aplicación no ofrece cambiar el codificador desde el navegador. Si necesitas más información para ejercer tus derechos sobre LAME, escríbenos (ver «El proyecto»).",
    ],
  },

  packagesTitle: "Componentes incluidos en la aplicación",
  packagesIntro:
    "Estos son los paquetes de código abierto que OptimusPDF declara como dependencias directas. Casi todos se ejecutan en tu navegador; los que no, lo dicen.",
  packagesNote:
    "Cada paquete trae a su vez otros paquetes (dependencias indirectas), con sus propias licencias, que figuran dentro de cada uno de ellos. Aquí solo se listan los directos.",
  fields: {
    version: "Versión",
    license: "Licencia",
    usedUnder: "se usa bajo {license}",
    onServer: "En el servidor",
    repository: "Repositorio",
    licenseText: "Texto de la licencia",
    npm: "Paquete en npm",
    openInNewTab: "(se abre en otra pestaña)",
  },
  purposes: {
    "@cantoo/pdf-lib": "Crear y modificar PDF: unir, dividir, rotar, firmar, proteger y guardar cambios.",
    "@huggingface/transformers": "Ejecutar en tu navegador los modelos de traducción (los modelos se descargan al usarlos).",
    "@mediabunny/mp3-encoder": "Ejecutar LAME (codificador de MP3) en un Worker. Ver «Salida MP3».",
    "@mlc-ai/web-llm": "Ejecutar en tu navegador el modelo del resumen con IA (el modelo se descarga al usarlo).",
    "@pdf-lib/fontkit": "Leer fuentes TrueType y OpenType e incrustarlas en el PDF.",
    docx: "Crear archivos de Word (.docx) al convertir desde PDF.",
    exceljs: "Leer y crear hojas de cálculo de Excel (.xlsx).",
    "html-to-pdfmake": "Traducir HTML al formato de documento de pdfmake (Word a PDF).",
    html2canvas: "Dibujar una página HTML como imagen para convertirla en PDF.",
    jspdf: "Montar el PDF a partir de las imágenes de «HTML a PDF».",
    jszip: "Leer y crear archivos ZIP (varios archivos descargados juntos, copias de seguridad).",
    "lucide-react": "Los iconos de la interfaz.",
    mammoth: "Leer archivos de Word (.docx) y pasarlos a HTML.",
    mediabunny: "Leer y escribir contenedores de audio y video (convertidor de video; archivos .mp3 de la salida MP3).",
    motion: "Las animaciones de la interfaz.",
    next: "El armazón de la aplicación web (rutas, compilación y servidor).",
    parse5: "Leer el HTML de la página web que pides en «HTML a PDF» por dirección web. Corre en nuestro servidor.",
    "pdfjs-dist": "Abrir PDF y dibujar sus páginas.",
    pdfmake: "Generar PDF a partir de texto, documentos de Word y hojas de Excel.",
    pptxgenjs: "Crear presentaciones de PowerPoint (.pptx).",
    react: "La biblioteca con la que se construye la interfaz.",
    "react-dom": "La parte de React que dibuja la interfaz en el navegador.",
    scanic: "Detectar los bordes de un documento al escanearlo con la cámara.",
    "tesseract.js": "Reconocimiento de texto (OCR) en tu navegador.",
  },

  assetsTitle: "Fuentes y decodificadores incluidos",
  assetsIntro: "Archivos que viajan con la aplicación y no son paquetes de package.json. Cada uno trae su archivo de licencia dentro del proyecto.",
  assets: [
    {
      name: "Liberation Sans, Serif y Mono 2.1.5",
      license: "OFL-1.1",
      purpose: "Fuentes del editor de PDF; solo se incrustan en tu PDF las que uses (en forma de subconjunto).",
      links: [{ label: "Proyecto Liberation Fonts", href: "https://github.com/liberationfonts/liberation-fonts" }],
    },
    {
      name: "Fuentes de reemplazo de pdf.js (Foxit y Liberation Sans 1.07.4)",
      license: "BSD-3-Clause · OFL-1.1",
      purpose: "Se usan para dibujar PDF cuyas fuentes no vienen incrustadas. La aplicación no las guarda en ningún PDF.",
      links: [{ label: "pdf.js", href: "https://github.com/mozilla/pdf.js" }],
    },
    {
      name: "Decodificadores de imagen de pdf.js: OpenJPEG, JBIG2 y QCMS",
      license: "BSD-2-Clause · BSD-3-Clause · MIT · Apache-2.0",
      purpose: "WebAssembly que dibuja imágenes JPEG 2000 y JBIG2 y convierte perfiles de color en los PDF.",
      links: [{ label: "pdf.js", href: "https://github.com/mozilla/pdf.js" }],
    },
    {
      name: "Caveat",
      license: "OFL-1.1",
      purpose: "Letra manuscrita para las firmas escritas en «Firmar PDF».",
      links: [{ label: "Caveat en Google Fonts", href: "https://fonts.google.com/specimen/Caveat" }],
    },
    {
      name: "JetBrains Mono",
      license: "OFL-1.1",
      purpose: "Letra de ancho fijo para códigos y huellas de verificación.",
      links: [{ label: "JetBrains Mono", href: "https://www.jetbrains.com/lp/mono/" }],
    },
  ],

  modelsTitle: "Lo que no se incluye",
  modelsBody:
    "Los modelos de inteligencia artificial de «Resumen con IA» y «Informe de traducción» no forman parte de la aplicación: se descargan la primera vez que usas esas herramientas, con la licencia que cada modelo declara en su página. Para saber qué se descarga y de dónde, mira la política de privacidad.",
  modelsLinkLabel: "Política de privacidad",

  contactTitle: "¿Dudas sobre estos avisos?",
  contactBody: "Escríbenos desde la página del proyecto y te respondemos.",
  contactLinkLabel: "El proyecto",

  aboutTitle: "Licencias y código abierto",
  aboutBody: "Qué componentes de terceros lleva OptimusPDF, con qué licencia y dónde está su código, incluida la salida MP3 con LAME.",
  aboutLinkLabel: "Ver licencias y avisos",
};

const en: LicensesStrings = {
  title: "Licences and open-source notices",
  subtitle:
    "OptimusPDF is built on free and open-source software. This page says plainly which third-party components the app includes, under which licence, what they are used for and where their code lives.",
  provenance: "The list comes from package.json and the installed packages; an automated test stops it from going stale unnoticed.",

  mp3: {
    title: "MP3 output",
    intro:
      "When you pick MP3 as the output format (Audio Converter, Extract audio and Audio Studio), the audio is encoded on your device with three open-source components. They load only at that moment, from our own server like the rest of the app, and your audio never leaves your browser.",
    noticeCaption: "The credit the LAME project asks for. The link goes to their site.",
    componentsTitle: "Components",
    roles: {
      mediabunny: "Builds the .mp3 file (frames and header) from the audio the encoder produces.",
      encoder: "Runs LAME in a separate process (a Worker) so the page does not freeze, and feeds it the audio in chunks.",
      lame: "The MP3 encoder itself, compiled to WebAssembly inside the package above.",
    },
    lameLicense: "LGPL, version 2 or later",
    complianceTitle: "How the licences are met",
    compliance: [
      "Unmodified files. We have not changed the code of mediabunny or @mediabunny/mp3-encoder: they are installed from npm at the exact version shown above (the dependency lock file pins it) and the app includes them as they come in the package; the bundler only groups and minifies them, like the rest of the code.",
      "Source code. The MPL-2.0 licence applies file by file: it covers those files, not the rest of the app. Their source code, at the exact version we use, is linked below together with the npm package.",
      "LAME. It is distributed under the LGPL, version 2 or later. We have not modified it: the bundled WebAssembly was compiled from unchanged LAME {version} with Emscripten {emscripten}, as the package README states. We checked that the binary inside the package has the SHA-256 that README lists ({sha}).",
    ],
    sourceTitle: "Where the source code is",
    sourceIntro: "Exact version the app uses:",
    labelRepo: "Code on GitHub (version tag)",
    labelNpm: "Package on npm",
    labelTarball: "Exact .tgz file",
    labelLameSite: "Official LAME site",
    labelLameSource: "LAME 3.100 source code",
    lameSourceNote: "File lame-3.100.tar.gz, SHA-256 {sha} (as listed in the package README).",
    textsTitle: "Licence texts",
    replaceTitle: "How to replace LAME",
    replace: [
      "LAME is not a separate file: its WebAssembly is embedded inside @mediabunny/mp3-encoder, in the code of the Worker the package creates. To use another version of LAME, or a modified one, you have to rebuild that package and then the app.",
      "The package is open source and its build can be reproduced: the repository and the README describe step by step how to compile LAME {version} to WebAssembly (Emscripten {emscripten}, the exact options and the small C bridge) and how to build the package. That gives you an @mediabunny/mp3-encoder with your own LAME, which you put in place among the app's dependencies.",
      "Today the app does not offer a way to swap the encoder from the browser. If you need more information to exercise your rights over LAME, write to us (see “The project”).",
    ],
  },

  packagesTitle: "Components included in the app",
  packagesIntro: "These are the open-source packages OptimusPDF declares as direct dependencies. Almost all of them run in your browser; the ones that do not say so.",
  packagesNote:
    "Each package brings other packages of its own (indirect dependencies), under their own licences, which are listed inside each of them. Only the direct ones are listed here.",
  fields: {
    version: "Version",
    license: "Licence",
    usedUnder: "used under {license}",
    onServer: "On the server",
    repository: "Repository",
    licenseText: "Licence text",
    npm: "Package on npm",
    openInNewTab: "(opens in a new tab)",
  },
  purposes: {
    "@cantoo/pdf-lib": "Create and edit PDFs: merge, split, rotate, sign, protect and save changes.",
    "@huggingface/transformers": "Run the translation models in your browser (models are downloaded when you use them).",
    "@mediabunny/mp3-encoder": "Run LAME (an MP3 encoder) in a Worker. See “MP3 output”.",
    "@mlc-ai/web-llm": "Run the AI summary model in your browser (the model is downloaded when you use it).",
    "@pdf-lib/fontkit": "Read TrueType and OpenType fonts and embed them in the PDF.",
    docx: "Create Word files (.docx) when converting from PDF.",
    exceljs: "Read and create Excel spreadsheets (.xlsx).",
    "html-to-pdfmake": "Translate HTML into the pdfmake document format (Word to PDF).",
    html2canvas: "Draw an HTML page as an image so it can become a PDF.",
    jspdf: "Assemble the PDF from the images of “HTML to PDF”.",
    jszip: "Read and create ZIP files (several files downloaded together, backups).",
    "lucide-react": "The interface icons.",
    mammoth: "Read Word files (.docx) and turn them into HTML.",
    mediabunny: "Read and write audio and video containers (video converter; the .mp3 files of the MP3 output).",
    motion: "The interface animations.",
    next: "The web app framework (routes, build and server).",
    parse5: "Read the HTML of the web page you ask for in “HTML to PDF” by web address. It runs on our server.",
    "pdfjs-dist": "Open PDFs and draw their pages.",
    pdfmake: "Generate PDFs from text, Word documents and Excel sheets.",
    pptxgenjs: "Create PowerPoint presentations (.pptx).",
    react: "The library the interface is built with.",
    "react-dom": "The part of React that draws the interface in the browser.",
    scanic: "Detect the edges of a document when scanning it with the camera.",
    "tesseract.js": "Text recognition (OCR) in your browser.",
  },

  assetsTitle: "Fonts and decoders included",
  assetsIntro: "Files that ship with the app and are not packages from package.json. Each one comes with its own licence file inside the project.",
  assets: [
    {
      name: "Liberation Sans, Serif and Mono 2.1.5",
      license: "OFL-1.1",
      purpose: "Fonts of the PDF editor; only the ones you use are embedded in your PDF (as a subset).",
      links: [{ label: "Liberation Fonts project", href: "https://github.com/liberationfonts/liberation-fonts" }],
    },
    {
      name: "pdf.js replacement fonts (Foxit and Liberation Sans 1.07.4)",
      license: "BSD-3-Clause · OFL-1.1",
      purpose: "Used to draw PDFs whose fonts are not embedded. The app does not save them into any PDF.",
      links: [{ label: "pdf.js", href: "https://github.com/mozilla/pdf.js" }],
    },
    {
      name: "pdf.js image decoders: OpenJPEG, JBIG2 and QCMS",
      license: "BSD-2-Clause · BSD-3-Clause · MIT · Apache-2.0",
      purpose: "WebAssembly that draws JPEG 2000 and JBIG2 images and converts colour profiles in PDFs.",
      links: [{ label: "pdf.js", href: "https://github.com/mozilla/pdf.js" }],
    },
    {
      name: "Caveat",
      license: "OFL-1.1",
      purpose: "Handwriting-style font for typed signatures in “Sign PDF”.",
      links: [{ label: "Caveat on Google Fonts", href: "https://fonts.google.com/specimen/Caveat" }],
    },
    {
      name: "JetBrains Mono",
      license: "OFL-1.1",
      purpose: "Fixed-width font for codes and verification fingerprints.",
      links: [{ label: "JetBrains Mono", href: "https://www.jetbrains.com/lp/mono/" }],
    },
  ],

  modelsTitle: "What is not included",
  modelsBody:
    "The AI models behind “AI summary” and “Translation report” are not part of the app: they are downloaded the first time you use those tools, under the licence each model declares on its page. To see what is downloaded and from where, read the privacy policy.",
  modelsLinkLabel: "Privacy policy",

  contactTitle: "Questions about these notices?",
  contactBody: "Write to us from the project page and we will answer.",
  contactLinkLabel: "The project",

  aboutTitle: "Licences and open source",
  aboutBody: "Which third-party components OptimusPDF includes, under which licence and where their code is, including MP3 output with LAME.",
  aboutLinkLabel: "See licences and notices",
};

export const STRINGS: Record<Language, LicensesStrings> = { es, en };

export function fill(template: string, values: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) => values[key] ?? match);
}
