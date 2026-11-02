import {
  Archive,
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

export type Tool = {
  slug: ToolSlug;
  icon: LucideIcon;
  category: ToolCategory;
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

export const CATEGORY_ORDER: ToolCategory[] = [
  "organize",
  "optimize",
  "convert-to",
  "convert-from",
  "edit",
  "security",
];

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

type ToolDefinition = Omit<Tool, "slug" | "accent">;

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
    status: "soon",
    accept: ["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif", "image/gif", "image/bmp", "image/avif"],
    extensions: [".jpg", ".jpeg", ".png", ".webp", ".heic", ".heif", ".gif", ".bmp", ".avif"],
    multiple: true,
  },
  "audio-converter": {
    icon: FileAudio,
    category: "convert-to",
    status: "soon",
    accept: ["audio/*"],
    extensions: [".mp3", ".wav", ".m4a", ".aac", ".ogg", ".opus", ".flac", ".weba"],
    multiple: true,
  },
  "video-converter": {
    icon: FileVideo,
    category: "convert-to",
    status: "soon",
    accept: ["video/*"],
    extensions: [".mp4", ".mov", ".webm", ".mkv", ".m4v"],
    multiple: false,
  },
  "audio-studio": {
    icon: AudioLines,
    category: "edit",
    status: "soon",
    accept: ["audio/*"],
    extensions: [".mp3", ".wav", ".m4a", ".aac", ".ogg", ".opus", ".flac", ".weba"],
    multiple: true,
  },
  "audio-extractor": {
    icon: Mic2,
    category: "convert-to",
    status: "soon",
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

/** Herramientas de una categoria. Las destacadas no pertenecen a ninguna seccion. */
export function getToolsByCategory(category: ToolCategory): Tool[] {
  return TOOLS.filter((tool) => tool.category === category && !tool.featured);
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
 * Herramientas relacionadas: primero de la misma categoria, luego live
 * de otras categorias, para rellenar siempre el grid de sugerencias.
 */
export function getRelatedTools(slug: ToolSlug, limit = 3): Tool[] {
  const current = getTool(slug);
  // La destacada ya se ofrece aparte («Abrir en PDF Pro»): no ocupa un hueco de «Sigue con estas».
  const sameCategory = TOOLS.filter(
    (tool) => tool.category === current.category && tool.slug !== slug && !tool.featured,
  );
  const rest = TOOLS.filter(
    (tool) => tool.category !== current.category && tool.status === "live" && !tool.featured,
  );
  return [...sameCategory, ...rest].slice(0, limit);
}
