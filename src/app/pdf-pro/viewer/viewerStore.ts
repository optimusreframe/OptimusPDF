import { clampZoom, nextZoomStep, type ViewerAnchor } from "@/app/pdf-pro/viewer/viewerLayout";
import { allPages, rangeBetween, toggled } from "@/app/pdf-pro/viewer/viewerSelection";
import type {
  ProViewerApi,
  ProViewerState,
  ViewerPageOverlay,
  ViewerPageToolbarSlot,
  ViewerScrollOptions,
  ViewerZoomAnchor,
} from "@/app/pdf-pro/viewer/viewerTypes";

/*
 * Almacen del visor (Wave 7 · U3): estado observable (pagina actual, zoom, paginas visibles, seleccion) y la
 * `ProViewerApi` que comparten la barra, las miniaturas, la paleta de comandos y las unidades de los modos.
 * No sabe nada de React ni del DOM: el componente `ProViewer` se acopla con `attach` para ejecutar los saltos
 * de desplazamiento y capturar el ancla del zoom ANTES de que cambie la maquetacion.
 */

/**
 * Cambios que la interfaz anuncia por la region viva unica: un salto pedido (`page`), un cambio de zoom (`zoom`)
 * o la pagina a la que llego el usuario desplazandose (`scroll`, con pausa para no hablar a cada rueda).
 */
export type ViewerNavigationKind = "page" | "zoom" | "scroll";

/** Lo que `ProViewer` implementa para el almacen. */
export type ViewerImpl = {
  scrollToPage(index: number, options: ViewerScrollOptions): void;
  /** Ancla (punto de la hoja que debe seguir en su sitio) con la maquetacion actual. */
  captureZoomAnchor(anchor?: ViewerZoomAnchor): ViewerAnchor | null;
  focus(): void;
};

export const EMPTY_VIEWER_STATE: ProViewerState = {
  pageCount: 0,
  currentPage: 0,
  zoom: 1,
  fitWidth: true,
  visiblePages: [],
  selectedPages: new Set(),
  ready: false,
  slotVersion: 0,
};

function sameList(a: readonly number[], b: readonly number[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
  return true;
}

function sameSet(a: ReadonlySet<number>, b: ReadonlySet<number>): boolean {
  if (a === b) return true;
  if (a.size !== b.size) return false;
  for (const value of a) if (!b.has(value)) return false;
  return true;
}

export class ProViewerStore implements ProViewerApi {
  private state: ProViewerState = EMPTY_VIEWER_STATE;
  private readonly listeners = new Set<() => void>();
  private impl: ViewerImpl | null = null;
  private pendingAnchor: ViewerAnchor | null = null;
  private selectionAnchor: number | null = null;
  private readonly overlays: ViewerPageOverlay[] = [];
  private readonly toolbars: ViewerPageToolbarSlot[] = [];
  private navigation: ((kind: ViewerNavigationKind) => void) | null = null;

  /* ---------------- observable ---------------- */

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getState = (): ProViewerState => this.state;

  private patch(next: Partial<ProViewerState>): void {
    let changed = false;
    for (const key of Object.keys(next) as (keyof ProViewerState)[]) {
      if (this.state[key] !== next[key]) {
        changed = true;
        break;
      }
    }
    if (!changed) return;
    this.state = { ...this.state, ...next };
    for (const listener of [...this.listeners]) listener();
  }

  /** Quien anuncia (region viva) los saltos de pagina y los cambios de zoom pedidos por la interfaz. */
  setNavigationListener(listener: ((kind: ViewerNavigationKind) => void) | null): void {
    this.navigation = listener;
  }

  /* ---------------- acoplamiento con el componente ---------------- */

  attach(impl: ViewerImpl): () => void {
    this.impl = impl;
    return () => {
      if (this.impl === impl) this.impl = null;
    };
  }

  /** El componente recoge (una sola vez) el ancla capturada por el ultimo cambio de zoom. */
  takePendingAnchor(): ViewerAnchor | null {
    const anchor = this.pendingAnchor;
    this.pendingAnchor = null;
    return anchor;
  }

  setPageCount(count: number): void {
    const n = Math.max(0, Math.floor(count));
    const selected = this.state.selectedPages;
    let nextSelected = selected;
    if ([...selected].some((page) => page >= n)) nextSelected = new Set([...selected].filter((page) => page < n));
    if (this.selectionAnchor !== null && this.selectionAnchor >= n) this.selectionAnchor = null;
    this.patch({
      pageCount: n,
      currentPage: Math.min(this.state.currentPage, Math.max(0, n - 1)),
      selectedPages: nextSelected,
      visiblePages: this.state.visiblePages.filter((page) => page < n),
    });
  }

  setReady(ready: boolean): void {
    this.patch({ ready });
  }

  /**
   * Lo llama el visor al desplazarse: no mueve nada, solo informa. `fromUserScroll` = el cambio viene de un
   * desplazamiento real (no de recolocar el visor tras un zoom, un cambio de snapshot o una medida nueva).
   */
  setCurrentPage(index: number, fromUserScroll = false): void {
    const i = Math.min(Math.max(0, Math.round(index)), Math.max(0, this.state.pageCount - 1));
    const changed = i !== this.state.currentPage;
    this.patch({ currentPage: i });
    if (changed && fromUserScroll) this.navigation?.("scroll");
  }

  setVisiblePages(pages: readonly number[]): void {
    if (sameList(this.state.visiblePages, pages)) return;
    this.patch({ visiblePages: pages });
  }

  /** Vuelve a un estado de «sin documento» (cierre). */
  reset(): void {
    this.selectionAnchor = null;
    this.pendingAnchor = null;
    this.patch({ ...EMPTY_VIEWER_STATE, zoom: this.state.zoom, fitWidth: this.state.fitWidth, slotVersion: this.state.slotVersion });
  }

  /* ---------------- ProViewerApi ---------------- */

  scrollToPage = (index: number, options: ViewerScrollOptions = {}): void => {
    const { pageCount } = this.state;
    if (pageCount === 0) return;
    const i = Math.min(Math.max(0, Math.round(Number.isFinite(index) ? index : 0)), pageCount - 1);
    this.patch({ currentPage: i });
    this.impl?.scrollToPage(i, options);
    if (!options.silent) this.navigation?.("page");
  };

  getVisiblePages = (): number[] => [...this.state.visiblePages];
  getCurrentPage = (): number => this.state.currentPage;
  getPageCount = (): number => this.state.pageCount;
  getZoom = (): number => this.state.zoom;
  isFitWidth = (): boolean => this.state.fitWidth;

  setZoom = (zoom: number, anchor?: ViewerZoomAnchor): void => {
    const target = clampZoom(zoom);
    if (Math.abs(target - this.state.zoom) < 0.001) return;
    // Se captura ANTES de cambiar el estado: despues la maquetacion ya es otra.
    this.pendingAnchor = this.impl?.captureZoomAnchor(anchor) ?? null;
    this.patch({ zoom: target, fitWidth: Math.abs(target - 1) < 0.001 });
    this.navigation?.("zoom");
  };

  zoomIn = (anchor?: ViewerZoomAnchor): void => this.setZoom(nextZoomStep(this.state.zoom, 1), anchor);
  zoomOut = (anchor?: ViewerZoomAnchor): void => this.setZoom(nextZoomStep(this.state.zoom, -1), anchor);
  fitWidth = (): void => this.setZoom(1);

  getSelectedPages = (): number[] => [...this.state.selectedPages].sort((a, b) => a - b);

  setSelectedPages = (pages: Iterable<number>): void => {
    const { pageCount } = this.state;
    const next = new Set<number>();
    let last: number | null = null;
    for (const page of pages) {
      if (Number.isInteger(page) && page >= 0 && page < pageCount) {
        next.add(page);
        last = page;
      }
    }
    this.selectionAnchor = last;
    if (sameSet(next, this.state.selectedPages)) return;
    this.patch({ selectedPages: next });
  };

  togglePage = (index: number): void => {
    if (!Number.isInteger(index) || index < 0 || index >= this.state.pageCount) return;
    this.selectionAnchor = index;
    this.patch({ selectedPages: toggled(this.state.selectedPages, index) });
  };

  selectRange = (index: number): void => {
    const { pageCount } = this.state;
    if (!Number.isInteger(index) || index < 0 || index >= pageCount) return;
    const from = this.selectionAnchor ?? this.state.currentPage;
    // El ancla no se mueve: varios Shift+clic parten del mismo sitio.
    this.selectionAnchor = from;
    this.patch({ selectedPages: rangeBetween(from, index) });
  };

  selectAll = (): void => {
    this.selectionAnchor = 0;
    this.patch({ selectedPages: allPages(this.state.pageCount) });
  };

  clearSelection = (): void => {
    this.selectionAnchor = null;
    if (this.state.selectedPages.size === 0) return;
    this.patch({ selectedPages: new Set() });
  };

  focus = (): void => {
    this.impl?.focus();
  };

  registerOverlay = (overlay: ViewerPageOverlay): (() => void) => {
    this.overlays.push(overlay);
    this.patch({ slotVersion: this.state.slotVersion + 1 });
    return () => {
      const index = this.overlays.indexOf(overlay);
      if (index >= 0) {
        this.overlays.splice(index, 1);
        this.patch({ slotVersion: this.state.slotVersion + 1 });
      }
    };
  };

  registerPageToolbar = (slot: ViewerPageToolbarSlot): (() => void) => {
    this.toolbars.push(slot);
    this.patch({ slotVersion: this.state.slotVersion + 1 });
    return () => {
      const index = this.toolbars.indexOf(slot);
      if (index >= 0) {
        this.toolbars.splice(index, 1);
        this.patch({ slotVersion: this.state.slotVersion + 1 });
      }
    };
  };

  /** Capa superpuesta vigente (la ultima registrada). */
  getOverlay(): ViewerPageOverlay | null {
    return this.overlays[this.overlays.length - 1] ?? null;
  }

  getPageToolbar(): ViewerPageToolbarSlot | null {
    return this.toolbars[this.toolbars.length - 1] ?? null;
  }
}

export function createViewerStore(): ProViewerStore {
  return new ProViewerStore();
}
