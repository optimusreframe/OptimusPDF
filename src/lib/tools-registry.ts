import {
  Archive,
  ArrowRightLeft,
  AudioWaveform,
  Boxes,
  ScanLine,
  ArrowDownToLine,
  ArrowUpFromLine,
  Braces,
  Camera,
  Code,
  Combine,
  Crop,
  Droplets,
  EyeOff,
  FileCode,
  FileImage,
  FileOutput,
  FileSpreadsheet,
  FileText,
  FileType,
  GitCompare,
  Hash,
  AudioLines,
  Download,
  FileAudio,
  FileVideo,
  Image,
  ImageDown,
  Mic2,
  Repeat,
  Languages,
  Layers,
  LayoutGrid,
  Lock,
  LockOpen,
  Minimize2,
  PenTool,
  Presentation,
  RotateCw,
  ScanText,
  Scissors,
  ShieldCheck,
  Signature,
  Sparkles,
  Table,
  Trash2,
  Wrench,
  type LucideIcon,
} from "lucide-react";

/** Categorias del blueprint §4. */
export type ToolCategory =
  | "organize"
  | "optimize"
  | "convert-to"
  | "convert-from"
  | "edit"
  | "security";

/** Acentos de color por familia de categoria (blueprint §7). */
export type ToolAccent =
  | "organize"
  | "optimize"
  | "convert"
  | "edit"
  | "security"
  /** Acento propio de PDF Pro (la herramienta destacada; ninguna categoria lo usa). */
  | "pro";

export type ToolStatus = "live" | "soon";

/**
 * Suites del producto (docs/PLAN-OPTIMUSTOOLS.md): `pdf` = OptimusPDF (las seis categorias de siempre), `scan` = OptimusSCAN
 * (Escanear a PDF) y `tools` = OptimusTOOLS (convertidores, Audio Studio y el Downloader). Cada herramienta pertenece a UNA.
 */
export type ToolSuite = "pdf" | "scan" | "tools";

/** Grupos de OptimusTOOLS (solo la suite `tools` los usa; las otras dos no tienen grupos). */
export type ToolGroup = "downloader" | "audio-studio" | "converter";

export type Tool = {
  slug: ToolSlug;
  icon: LucideIcon;
  /**
   * Categoria de PDF. Solo organiza el catalogo de la suite `pdf` (`getToolsByCategory`); en `scan` y `tools` es la afinidad
   * historica (acento de color y orden de «Sigue con estas») y no define ninguna seccion.
   */
  category: ToolCategory;
  /** Suite a la que pertenece (barra lateral, Inicio y menus se agrupan por ella). */
  suite: ToolSuite;
  /** Grupo dentro de OptimusTOOLS; `undefined` en `pdf` y `scan`. */
  group?: ToolGroup;
  accent: ToolAccent;
  status: ToolStatus;
  /** Tipos MIME aceptados en la entrada. */
  accept: string[];
  /** Extensiones aceptadas (fallback cuando el navegador no informa MIME). */
  extensions: string[];
  /** Acepta varios archivos a la vez. */
  multiple: boolean;
  /**
   * Herramienta DESTACADA (Wave 7): no pertenece a ninguna seccion de categoria
   * (`getToolsByCategory` no la devuelve); Home la pinta como tarjeta grande
   * antes del catalogo y los menus (cabecera, barra lateral) la ponen primera.
   * Sigue contando como cualquier otra para el buscador, «Mas usadas» y los
   * recuentos. `category` solo sirve de etiqueta de busqueda.
   */
  featured?: boolean;
};

export const TOOL_SLUGS = [
  // Destacada (sin categoria propia): la suite todo-en-uno va PRIMERA.
  "pdf-pro",
  // Organizar
  "merge-pdf",
  "split-pdf",
  "remove-pages",
  "extract-pages",
  "organize-pdf",
  "rotate-pdf",
  "pdfs-to-zip",
  // Optimizar
  "compress-pdf",
  "repair-pdf",
  "ocr-pdf",
  // Convertir a PDF
  "jpg-to-pdf",
  "word-to-pdf",
  "powerpoint-to-pdf",
  "excel-to-pdf",
  "html-to-pdf",
  "scan-to-pdf",
  // Convertir desde PDF
  "pdf-to-jpg",
  "pdf-to-word",
  "pdf-to-powerpoint",
  "pdf-to-excel",
  "pdf-to-csv",
  "pdf-to-pdfa",
  "pdf-to-markdown",
  "pdf-to-text",
  "pdf-to-json",
  // Editar y analizar
  "add-page-numbers",
  "add-watermark",
  "crop-pdf",
  "edit-pdf",
  "sign-pdf",
  "compare-pdf",
  "extract-assets",
  "pdf-summarizer",
  "translate-pdf",
  // Seguridad
  "protect-pdf",
  "unlock-pdf",
  "redact-pdf",
  // OptimusTOOLS (fuera de las categorias de PDF; ver docs/PLAN-OPTIMUSTOOLS.md)
  "image-converter",
  "audio-converter",
  "video-converter",
  "audio-studio",
  "audio-extractor",
  "downloader",
] as const;

export type ToolSlug = (typeof TOOL_SLUGS)[number];

/** Orden de las suites en la barra lateral, Inicio y los menus. */
export const SUITE_ORDER: ToolSuite[] = ["pdf", "scan", "tools"];

/**
 * Plataformas del Downloader. Son nombres de marca (datos, no texto de interfaz) y NO tienen pagina: se pintan como entradas
 * deshabilitadas, nunca como enlaces. Si algun dia el Downloader existe, esta lista pasa a ser de enlaces reales.
 */
export const DOWNLOADER_PLATFORMS = ["Instagram", "Facebook", "TikTok", "X", "Threads", "Telegram"] as const;

/** Orden de los grupos de OptimusTOOLS. */
export const GROUP_ORDER: ToolGroup[] = ["downloader", "audio-studio", "converter"];

export const CATEGORY_ORDER: ToolCategory[] = [
  "organize",
  "optimize",
  "convert-to",
  "convert-from",
  "edit",
  "security",
];

/**
 * Secciones ancladas de Inicio (`/#id`): las seis categorias de PDF, la suite OptimusSCAN (`scan`, sin subsecciones) y los
 * grupos de OptimusTOOLS. Sus ids no chocan entre si. El orden es el de la pagina, de arriba abajo.
 */
export type SectionId = ToolCategory | "scan" | ToolGroup;

export const SECTION_ORDER: SectionId[] = [...CATEGORY_ORDER, "scan", ...GROUP_ORDER];

export const CATEGORY_ACCENT: Record<ToolCategory, ToolAccent> = {
  organize: "organize",
  optimize: "optimize",
  "convert-to": "convert",
  "convert-from": "convert",
  edit: "edit",
  security: "security",
};

/** Icono representativo por categoria, para navegacion (sidebar, etc). */
export const CATEGORY_ICON: Record<ToolCategory, LucideIcon> = {
  organize: LayoutGrid,
  optimize: Minimize2,
  "convert-to": ArrowDownToLine,
  "convert-from": ArrowUpFromLine,
  edit: PenTool,
  security: ShieldCheck,
};

/** Icono de cada suite y de cada grupo, para navegacion (barra lateral, Inicio). */
export const SUITE_ICON: Record<ToolSuite, LucideIcon> = {
  pdf: FileText,
  scan: ScanLine,
  tools: Boxes,
};

export const GROUP_ICON: Record<ToolGroup, LucideIcon> = {
  downloader: Download,
  "audio-studio": AudioWaveform,
  converter: ArrowRightLeft,
};

/**
 * Clases Tailwind por acento. Se escriben como literales para que el
 * escaneo de Tailwind las detecte; nunca se componen dinamicamente.
 */
export const ACCENT_TEXT: Record<ToolAccent, string> = {
  organize: "text-accent-organize",
  optimize: "text-accent-optimize",
  convert: "text-accent-convert",
  edit: "text-accent-edit",
  security: "text-accent-security",
  pro: "text-accent-pro",
};

export const ACCENT_BG_SOFT: Record<ToolAccent, string> = {
  organize: "bg-accent-organize/12",
  optimize: "bg-accent-optimize/12",
  convert: "bg-accent-convert/12",
  edit: "bg-accent-edit/12",
  security: "bg-accent-security/12",
  pro: "bg-accent-pro/12",
};

export const ACCENT_RING: Record<ToolAccent, string> = {
  organize: "ring-accent-organize/25",
  optimize: "ring-accent-optimize/25",
  convert: "ring-accent-convert/25",
  edit: "ring-accent-edit/25",
  security: "ring-accent-security/25",
  pro: "ring-accent-pro/25",
};

const PDF_MIME = ["application/pdf"];
const PDF_EXT = [".pdf"];
/**
 * Imagenes que aceptan Imagenes a PDF y Escanear a PDF. HEIC/HEIF (el formato de alta eficiencia de las fotos de iPhone/iPad)
 * se acepta porque Safari SI lo decodifica; donde el navegador no puede abrirlo (Chrome, Firefox) la foto se nombra con un
 * mensaje claro y el resto sigue (ver `imageIntegrity.ts` y `thumbnail.ts`). AVIF, GIF y TIFF NO se ofrecen: el codigo de
 * conversion de `prepareForPdf.ts` para ellos solo se alcanza renombrando un archivo.
 */
const IMAGE_MIME = ["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif"];
const IMAGE_EXT = [".jpg", ".jpeg", ".png", ".webp", ".heic", ".heif"];

type ToolDefinition = Omit<Tool, "slug" | "accent" | "suite" | "group">;

/**
 * Herramientas de cada grupo de OptimusTOOLS, EN EL ORDEN en que se muestran (plan: «Extraer audio · Audio Studio» y
 * «Audio Converter · Image Converter · Video Converter»). Es la unica fuente de la pertenencia a un grupo.
 */
const GROUP_MEMBERS: Record<ToolGroup, ToolSlug[]> = {
  downloader: ["downloader"],
  "audio-studio": ["audio-extractor", "audio-studio"],
  converter: ["audio-converter", "image-converter", "video-converter"],
};

/**
 * Suite y grupo de las herramientas que NO son de la suite `pdf` (todas las demas lo son). Vive aparte de `DEFINITIONS` a
 * proposito: las duenas de cada herramienta nueva solo tocan su linea de `status`/`accept`, y la estructura de navegacion
 * (esto) no choca con ellas.
 */
const PLACEMENT = new Map<ToolSlug, { suite: ToolSuite; group?: ToolGroup }>([
  ["scan-to-pdf", { suite: "scan" }],
  ...(Object.entries(GROUP_MEMBERS) as [ToolGroup, ToolSlug[]][]).flatMap(([group, members]) =>
    members.map((slug): [ToolSlug, { suite: ToolSuite; group: ToolGroup }] => [slug, { suite: "tools", group }]),
  ),
]);

const DEFINITIONS: Record<ToolSlug, ToolDefinition> = {
  "pdf-pro": {
    icon: Layers,
    category: "edit",
    status: "live",
    accept: PDF_MIME,
    extensions: PDF_EXT,
    multiple: false,
    featured: true,
  },
  "merge-pdf": {
    icon: Combine,
    category: "organize",
    status: "live",
    accept: PDF_MIME,
    extensions: PDF_EXT,
    multiple: true,
  },
  "split-pdf": {
    icon: Scissors,
    category: "organize",
    status: "live",
    accept: PDF_MIME,
    extensions: PDF_EXT,
    multiple: false,
  },
  "remove-pages": {
    icon: Trash2,
    category: "organize",
    status: "live",
    accept: PDF_MIME,
    extensions: PDF_EXT,
    multiple: false,
  },
  "extract-pages": {
    icon: FileOutput,
    category: "organize",
    status: "live",
    accept: PDF_MIME,
    extensions: PDF_EXT,
    multiple: false,
  },
  "organize-pdf": {
    icon: LayoutGrid,
    category: "organize",
    status: "live",
    accept: PDF_MIME,
    extensions: PDF_EXT,
    multiple: false,
  },
  "rotate-pdf": {
    icon: RotateCw,
    category: "organize",
    status: "live",
    accept: PDF_MIME,
    extensions: PDF_EXT,
    multiple: false,
  },
  "pdfs-to-zip": {
    icon: Archive,
    category: "organize",
    status: "live",
    accept: PDF_MIME,
    extensions: PDF_EXT,
    multiple: true,
  },
  "compress-pdf": {
    icon: Minimize2,
    category: "optimize",
    status: "live",
    accept: PDF_MIME,
    extensions: PDF_EXT,
    multiple: false,
  },
  "repair-pdf": {
    icon: Wrench,
    category: "optimize",
    status: "live",
    accept: PDF_MIME,
    extensions: PDF_EXT,
    multiple: false,
  },
  "ocr-pdf": {
    icon: ScanText,
    category: "optimize",
    status: "live",
    accept: PDF_MIME,
    extensions: PDF_EXT,
    multiple: false,
  },
  "jpg-to-pdf": {
    icon: FileImage,
    category: "convert-to",
    status: "live",
    accept: IMAGE_MIME,
    extensions: IMAGE_EXT,
    multiple: true,
  },
  "word-to-pdf": {
    icon: FileText,
    category: "convert-to",
    status: "live",
    accept: [
      "application/msword",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ],
    extensions: [".doc", ".docx"],
    multiple: false,
  },
  "powerpoint-to-pdf": {
    icon: Presentation,
    category: "convert-to",
    status: "soon",
    accept: [
      "application/vnd.ms-powerpoint",
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    ],
    extensions: [".ppt", ".pptx"],
    multiple: false,
  },
  "excel-to-pdf": {
    icon: FileSpreadsheet,
    category: "convert-to",
    status: "live",
    accept: [
      "application/vnd.ms-excel",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ],
    extensions: [".xls", ".xlsx"],
    multiple: false,
  },
  "html-to-pdf": {
    icon: Code,
    category: "convert-to",
    status: "live",
    accept: ["text/html"],
    extensions: [".html", ".htm"],
    multiple: false,
  },
  "scan-to-pdf": {
    icon: Camera,
    category: "convert-to",
    status: "live",
    accept: IMAGE_MIME,
    extensions: IMAGE_EXT,
    multiple: true,
  },
  "pdf-to-jpg": {
    icon: Image,
    category: "convert-from",
    status: "live",
    accept: PDF_MIME,
    extensions: PDF_EXT,
    multiple: false,
  },
  "pdf-to-word": {
    icon: FileText,
    category: "convert-from",
    status: "live",
    accept: PDF_MIME,
    extensions: PDF_EXT,
    multiple: false,
  },
  "pdf-to-powerpoint": {
    icon: Presentation,
    category: "convert-from",
    status: "live",
    accept: PDF_MIME,
    extensions: PDF_EXT,
    multiple: false,
  },
  "pdf-to-excel": {
    icon: Table,
    category: "convert-from",
    status: "live",
    accept: PDF_MIME,
    extensions: PDF_EXT,
    multiple: false,
  },
  "pdf-to-csv": {
    icon: FileSpreadsheet,
    category: "convert-from",
    status: "live",
    accept: PDF_MIME,
    extensions: PDF_EXT,
    multiple: false,
  },
  "pdf-to-pdfa": {
    icon: FileType,
    category: "convert-from",
    status: "live",
    accept: PDF_MIME,
    extensions: PDF_EXT,
    multiple: false,
  },
  "pdf-to-markdown": {
    icon: FileCode,
    category: "convert-from",
    status: "live",
    accept: PDF_MIME,
    extensions: PDF_EXT,
    multiple: false,
  },
  "pdf-to-text": {
    icon: FileText,
    category: "convert-from",
    status: "live",
    accept: PDF_MIME,
    extensions: PDF_EXT,
    multiple: false,
  },
  "pdf-to-json": {
    icon: Braces,
    category: "convert-from",
    status: "live",
    accept: PDF_MIME,
    extensions: PDF_EXT,
    multiple: false,
  },
  "add-page-numbers": {
    icon: Hash,
    category: "edit",
    status: "live",
    accept: PDF_MIME,
    extensions: PDF_EXT,
    multiple: false,
  },
  "add-watermark": {
    icon: Droplets,
    category: "edit",
    status: "live",
    accept: PDF_MIME,
    extensions: PDF_EXT,
    multiple: false,
  },
  "crop-pdf": {
    icon: Crop,
    category: "edit",
    status: "live",
    accept: PDF_MIME,
    extensions: PDF_EXT,
    multiple: false,
  },
  "edit-pdf": {
    icon: PenTool,
    category: "edit",
    status: "live",
    accept: PDF_MIME,
    extensions: PDF_EXT,
    multiple: false,
  },
  "sign-pdf": {
    icon: Signature,
    category: "edit",
    status: "live",
    accept: PDF_MIME,
    extensions: PDF_EXT,
    multiple: false,
  },
  "compare-pdf": {
    icon: GitCompare,
    category: "edit",
    status: "live",
    accept: PDF_MIME,
    extensions: PDF_EXT,
    multiple: true,
  },
  "extract-assets": {
    icon: ImageDown,
    category: "edit",
    status: "live",
    accept: PDF_MIME,
    extensions: PDF_EXT,
    multiple: false,
  },
  "pdf-summarizer": {
    icon: Sparkles,
    category: "edit",
    status: "live",
    accept: PDF_MIME,
    extensions: PDF_EXT,
    multiple: false,
  },
  "translate-pdf": {
    icon: Languages,
    category: "edit",
    status: "live",
    accept: PDF_MIME,
    extensions: PDF_EXT,
    multiple: false,
  },
  "protect-pdf": {
    icon: Lock,
    category: "security",
    status: "live",
    accept: PDF_MIME,
    extensions: PDF_EXT,
    multiple: false,
  },
  "unlock-pdf": {
    icon: LockOpen,
    category: "security",
    status: "live",
    accept: PDF_MIME,
    extensions: PDF_EXT,
    multiple: false,
  },
  "redact-pdf": {
    icon: EyeOff,
    category: "security",
    status: "live",
    accept: PDF_MIME,
    extensions: PDF_EXT,
    multiple: false,
  },  "image-converter": {
    icon: Repeat,
    category: "convert-to",
    status: "live",
    accept: ["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif", "image/gif", "image/bmp", "image/avif"],
    extensions: [".jpg", ".jpeg", ".png", ".webp", ".heic", ".heif", ".gif", ".bmp", ".avif"],
    multiple: true,
  },
  "audio-converter": {
    icon: FileAudio,
    category: "convert-to",
    status: "live",
    accept: ["audio/*"],
    extensions: [".mp3", ".wav", ".m4a", ".aac", ".ogg", ".opus", ".flac", ".weba"],
    multiple: true,
  },
  "video-converter": {
    icon: FileVideo,
    category: "convert-to",
    status: "live",
    accept: ["video/*"],
    extensions: [".mp4", ".mov", ".webm", ".mkv", ".m4v"],
    multiple: false,
  },
  "audio-studio": {
    icon: AudioLines,
    category: "edit",
    status: "live",
    accept: ["audio/*"],
    extensions: [".mp3", ".wav", ".m4a", ".aac", ".ogg", ".opus", ".flac", ".weba"],
    multiple: true,
  },
  "audio-extractor": {
    icon: Mic2,
    category: "convert-to",
    status: "live",
    accept: ["video/*"],
    extensions: [".mp4", ".mov", ".webm", ".mkv", ".m4v"],
    multiple: false,
  },
  downloader: {
    icon: Download,
    category: "convert-to",
    status: "soon",
    accept: [],
    extensions: [],
    multiple: false,
  },

};

export const TOOLS: Tool[] = TOOL_SLUGS.map((slug) => {
  const definition = DEFINITIONS[slug];
  return {
    slug,
    accent: definition.featured ? "pro" : CATEGORY_ACCENT[definition.category],
    ...definition,
    suite: PLACEMENT.get(slug)?.suite ?? "pdf",
    group: PLACEMENT.get(slug)?.group,
  };
});

const BY_SLUG = new Map<ToolSlug, Tool>(TOOLS.map((tool) => [tool.slug, tool]));

export function getTool(slug: ToolSlug): Tool {
  const tool = BY_SLUG.get(slug);
  if (!tool) {
    throw new Error(`Unknown tool slug: ${slug}`);
  }
  return tool;
}

/** Slug de la herramienta destacada: PDF Pro, la suite todo-en-uno. */
export const PRO_SLUG: ToolSlug = "pdf-pro";

/**
 * Herramientas de una categoria de PDF. Solo cuenta la suite `pdf`: Escanear a PDF (suite `scan`) y las de OptimusTOOLS ya
 * no se listan dentro de «Convertir a PDF». Las destacadas no pertenecen a ninguna seccion.
 */
export function getToolsByCategory(category: ToolCategory): Tool[] {
  return TOOLS.filter(
    (tool) => tool.suite === "pdf" && tool.category === category && !tool.featured,
  );
}

/** Herramientas de una suite, en el orden del registro. Las destacadas no pertenecen a ninguna seccion. */
export function getToolsBySuite(suite: ToolSuite): Tool[] {
  return TOOLS.filter((tool) => tool.suite === suite && !tool.featured);
}

/** Herramientas de un grupo de OptimusTOOLS, en el orden en que se muestran. */
export function getToolsByGroup(group: ToolGroup): Tool[] {
  return GROUP_MEMBERS[group].map(getTool);
}

/** Estado de una herramienta, para que la navegacion decida entre enlace normal e insignia «Pronto». */
export function isToolLive(slug: ToolSlug): boolean {
  return getTool(slug).status === "live";
}

/** Herramientas destacadas (hoy solo PDF Pro), en el orden del registro. */
export function getFeaturedTools(): Tool[] {
  return TOOLS.filter((tool) => tool.featured);
}

export function getLiveTools(): Tool[] {
  return TOOLS.filter((tool) => tool.status === "live");
}

export function toolHref(slug: ToolSlug): string {
  return `/${slug}`;
}

/**
 * Herramientas relacionadas, por cercania: 1) misma familia (categoria en `pdf`, grupo en `tools`; en `scan` la afinidad
 * historica con «Convertir a PDF»), cualquier estado; 2) live del resto de la misma suite; 3) live de la misma categoria
 * en otra suite; 4) el resto live. Rellena siempre el grid de sugerencias.
 */
export function getRelatedTools(slug: ToolSlug, limit = 3): Tool[] {
  const current = getTool(slug);
  // La destacada ya se ofrece aparte («Abrir en PDF Pro»): no ocupa un hueco de «Sigue con estas».
  const candidates = TOOLS.filter((tool) => tool.slug !== slug && !tool.featured);
  const sameFamily = (tool: Tool) =>
    current.suite === "tools"
      ? tool.suite === "tools" && tool.group === current.group
      : tool.suite === current.suite && tool.category === current.category;
  const first = candidates.filter(sameFamily);
  const taken = new Set(first.map((tool) => tool.slug));
  const live = candidates.filter((tool) => !taken.has(tool.slug) && tool.status === "live");
  const sameSuite = live.filter((tool) => tool.suite === current.suite);
  const sameCategory = live.filter(
    (tool) => tool.suite !== current.suite && tool.category === current.category,
  );
  const rest = live.filter(
    (tool) => tool.suite !== current.suite && tool.category !== current.category,
  );
  return [...first, ...sameSuite, ...sameCategory, ...rest].slice(0, limit);
}
