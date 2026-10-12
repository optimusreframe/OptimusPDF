import type { ReactNode } from "react";
import type { PageGeometry } from "@/lib/pdf/core";

/**
 * CONTRATO del visor continuo de PDF Pro (Wave 7 · U3). Lo usan las unidades siguientes (U6 Editar/Anotar,
 * U7 Firmar/Rellenar, U4 Paginas) para dibujar capas sobre cada pagina, saltar a una pagina, leer la
 * seleccion de paginas y registrar comandos. Solo tipos y constantes: no cambiar su forma sin avisar.
 */

/* ------------------------------------------------------------------ *
 * Constantes de maquetacion y de memoria
 * ------------------------------------------------------------------ */

export const VIEWER_MIN_ZOOM = 0.5;
export const VIEWER_MAX_ZOOM = 4;
/** Pasos de los botones y del teclado (`+` / `-`). 1 = «ajustar al ancho». */
export const VIEWER_ZOOM_STEPS: readonly number[] = [0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4];
/** Hueco (px CSS) entre paginas. */
export const VIEWER_PAGE_GAP = 16;
/** Margen (px CSS) a cada lado y arriba/abajo de la columna. */
export const VIEWER_PAD_X = 16;
export const VIEWER_PAD_Y = 16;
/** Ancho maximo (px CSS) de una pagina a zoom 1: en un monitor enorme no se ve gigante. */
export const VIEWER_MAX_FIT_WIDTH = 960;
/** Ancho minimo de la base de zoom: en un panel estrecho la pagina sigue siendo legible. */
export const VIEWER_MIN_FIT_WIDTH = 200;
/** Paginas a cada lado del rango visible que se mantienen montadas (cascaron barato). */
export const VIEWER_MOUNT_OVERSCAN = 2;
/** Paginas a cada lado del rango visible cuya imagen se dibuja y se conserva en el DOM. */
export const VIEWER_RENDER_OVERSCAN = 1;
/** Tope duro de paginas montadas (cascarones). */
export const VIEWER_MAX_MOUNTED = 16;
/** Tope duro de imagenes vivas en el DOM. */
export const VIEWER_MAX_IMAGES = 10;
/** Renders de pagina simultaneos. */
export const VIEWER_RENDER_CONCURRENCY = 2;
/** Espera tras el ultimo cambio de zoom/ancho antes de repetir los renders nitidos. */
export const VIEWER_RERENDER_DEBOUNCE_MS = 120;

/* ------------------------------------------------------------------ *
 * Paginas
 * ------------------------------------------------------------------ */

/** Lo que recibe una capa superpuesta o la barra de una pagina. Las coordenadas son px CSS de ESA hoja. */
export type ViewerPageInfo = {
  /** Indice de pagina, base 0. */
  index: number;
  /** Ancho de la hoja tal como se ve (px CSS, ya con el zoom). */
  widthPx: number;
  /** Alto de la hoja tal como se ve (px CSS). */
  heightPx: number;
  /** px CSS por punto PDF (`widthPx / geometry.viewWidth`). */
  scale: number;
  /** `/Rotate` y CropBox de la pagina (espacio de usuario <-> espacio de vista, como en `core.ts`). */
  geometry: PageGeometry;
};

/**
 * Capa superpuesta alineada con UNA pagina (edicion, firma...). Se pinta dentro de la hoja, con el origen
 * en su esquina superior izquierda; solo se llama para las paginas montadas. Debe ser rapida y pura.
 */
export type ViewerPageOverlay = (page: ViewerPageInfo) => ReactNode;

/** Barra opcional de una pagina (se pinta sobre la hoja ACTIVA, arriba a la derecha). */
export type ViewerPageToolbarSlot = (page: ViewerPageInfo) => ReactNode;

/* ------------------------------------------------------------------ *
 * API imperativa
 * ------------------------------------------------------------------ */

export type ViewerScrollBehavior = "auto" | "smooth" | "instant";

export type ViewerScrollOptions = {
  /** `smooth` se degrada a `instant` con `prefers-reduced-motion`. Por defecto: suave solo si la pagina esta a <= 1 de distancia. */
  behavior?: ViewerScrollBehavior;
  /** Donde queda la pagina: arriba (por defecto) o centrada. */
  align?: "start" | "center";
  /** Lleva tambien el foco del teclado a la pagina. */
  focus?: boolean;
  /** (W7-U6) No anuncia «Pagina X de N» (al volver de un modo manda el anuncio de «Aplicado»). */
  silent?: boolean;
};

export type ViewerZoomAnchor = { clientX: number; clientY: number };

/** Estado observable del visor (inmutable: cada cambio crea un objeto nuevo). */
export type ProViewerState = {
  /** Paginas del documento mostrado (0 = sin documento). */
  pageCount: number;
  /** Pagina actual (base 0): la que ocupa mas del area visible. */
  currentPage: number;
  /** Zoom relativo al ancho base (1 = ajustar al ancho). */
  zoom: number;
  /** `true` mientras el zoom sigue el ancho disponible («ajustar al ancho»). */
  fitWidth: boolean;
  /** Paginas con alguna parte a la vista, de menor a mayor. */
  visiblePages: readonly number[];
  /** Paginas seleccionadas para operar sobre ellas (Ctrl/Shift+clic). */
  selectedPages: ReadonlySet<number>;
  /** El documento esta abierto y maquetado. */
  ready: boolean;
  /** Cambia cuando se registra o retira una capa/barra: obliga a repintar las paginas. */
  slotVersion: number;
};

/**
 * API del visor, la misma para la barra, las miniaturas, la paleta de comandos y las unidades de los modos.
 * Se obtiene con `useProViewer().api`.
 */
export type ProViewerApi = {
  /** Salta a la pagina `index` (base 0; se acota al documento). */
  scrollToPage(index: number, options?: ViewerScrollOptions): void;
  /** Paginas que se ven ahora (alguna parte), de menor a mayor. */
  getVisiblePages(): number[];
  getCurrentPage(): number;
  getPageCount(): number;
  getZoom(): number;
  isFitWidth(): boolean;
  /** Fija el zoom (0,5 a 4). Con `anchor` (coordenadas de cliente) ese punto de la hoja no se mueve. */
  setZoom(zoom: number, anchor?: ViewerZoomAnchor): void;
  zoomIn(anchor?: ViewerZoomAnchor): void;
  zoomOut(anchor?: ViewerZoomAnchor): void;
  /** Vuelve a «ajustar al ancho» (zoom 1 que sigue el tamano del panel). */
  fitWidth(): void;
  getSelectedPages(): number[];
  /** Sustituye la seleccion (se acota al documento). */
  setSelectedPages(pages: Iterable<number>): void;
  /** Ctrl/Cmd+clic: alterna una pagina. */
  togglePage(index: number): void;
  /** Shift+clic: selecciona el rango desde el ancla. */
  selectRange(index: number): void;
  selectAll(): void;
  clearSelection(): void;
  /** Lleva el foco del teclado a la pagina actual del visor. */
  focus(): void;
  /** Registra una capa superpuesta; devuelve la funcion que la retira. La ultima registrada manda. */
  registerOverlay(overlay: ViewerPageOverlay): () => void;
  /** Registra la barra de la pagina activa; devuelve la funcion que la retira. */
  registerPageToolbar(slot: ViewerPageToolbarSlot): () => void;
  subscribe(listener: () => void): () => void;
  getState(): ProViewerState;
};

/* ------------------------------------------------------------------ *
 * Propiedades del componente
 * ------------------------------------------------------------------ */

/** Snapshot que muestra el visor: `id` identifica el contenido (cambia con cada snapshot del documento de trabajo). */
export type ViewerSnapshot = { id: string; bytes: Uint8Array };

export type ProViewerProps = {
  /** Se llama cuando una pagina entra en el rango visible (una vez por entrada). */
  onPageVisible?: (index: number) => void;
  /** Capa superpuesta propia; tiene prioridad sobre las registradas con `api.registerOverlay`. */
  renderPageOverlay?: ViewerPageOverlay;
  /** Barra de la pagina activa; tiene prioridad sobre las registradas. */
  renderPageToolbar?: ViewerPageToolbarSlot;
  /** Seleccion controlada (opcional): sin ella se usa la del almacen del visor. */
  selectedPages?: ReadonlySet<number>;
  onSelectPages?: (pages: ReadonlySet<number>) => void;
};
