import {
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
  Image,
  Languages,
  LayoutGrid,
  Lock,
  LockOpen,
  Minimize2,
  PenTool,
  Presentation,
  RotateCw,
  ScanText,
  Scissors,
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
  | "security";

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
};

export const TOOL_SLUGS = [
  // Organizar
  "merge-pdf",
  "split-pdf",
  "remove-pages",
  "extract-pages",
  "organize-pdf",
  "rotate-pdf",
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
  "pdf-to-pdfa",
  "pdf-to-markdown",
  // Editar y analizar
  "add-page-numbers",
  "add-watermark",
  "crop-pdf",
  "edit-pdf",
  "sign-pdf",
  "compare-pdf",
  "pdf-summarizer",
  "translate-pdf",
  // Seguridad
  "protect-pdf",
  "unlock-pdf",
  "redact-pdf",
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
};

export const ACCENT_BG_SOFT: Record<ToolAccent, string> = {
  organize: "bg-accent-organize/12",
  optimize: "bg-accent-optimize/12",
  convert: "bg-accent-convert/12",
  edit: "bg-accent-edit/12",
  security: "bg-accent-security/12",
};

export const ACCENT_RING: Record<ToolAccent, string> = {
  organize: "ring-accent-organize/25",
  optimize: "ring-accent-optimize/25",
  convert: "ring-accent-convert/25",
  edit: "ring-accent-edit/25",
  security: "ring-accent-security/25",
};

const PDF_MIME = ["application/pdf"];
const PDF_EXT = [".pdf"];
const IMAGE_MIME = ["image/jpeg", "image/png", "image/webp"];
const IMAGE_EXT = [".jpg", ".jpeg", ".png", ".webp"];

type ToolDefinition = Omit<Tool, "slug" | "accent">;

const DEFINITIONS: Record<ToolSlug, ToolDefinition> = {
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
  },
};

export const TOOLS: Tool[] = TOOL_SLUGS.map((slug) => {
  const definition = DEFINITIONS[slug];
  return {
    slug,
    accent: CATEGORY_ACCENT[definition.category],
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

export function getToolsByCategory(category: ToolCategory): Tool[] {
  return TOOLS.filter((tool) => tool.category === category);
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
  const sameCategory = TOOLS.filter(
    (tool) => tool.category === current.category && tool.slug !== slug,
  );
  const rest = TOOLS.filter(
    (tool) => tool.category !== current.category && tool.status === "live",
  );
  return [...sameCategory, ...rest].slice(0, limit);
}
