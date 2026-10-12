import { useEffect, type ReactNode } from "react";
import { act, fireEvent } from "@testing-library/react";
import { vi } from "vitest";
import { LanguageProvider, useI18n, type Language } from "@/lib/i18n";
import { ProViewerProvider } from "@/app/pdf-pro/viewer/ProViewerContext";
import { viewerRasterCache } from "@/app/pdf-pro/viewer/viewerRasterCache";
import { viewerSignatureMemo } from "@/app/pdf-pro/viewer/pageSignature";
import { pdfMocks } from "@/app/pdf-pro/viewer/viewerMocks";
import type { ProViewerStore } from "@/app/pdf-pro/viewer/viewerStore";
import type { ViewerSnapshot } from "@/app/pdf-pro/viewer/viewerTypes";

export { makeSnapshot, mixedPages, pagesOf, pdfMocks, fakePdfDocument, type PageSpec } from "@/app/pdf-pro/viewer/viewerMocks";

/**
 * Utilidades SOLO PARA PRUEBAS del visor de PDF Pro: el tamano y el desplazamiento del visor (jsdom no maqueta),
 * un `IntersectionObserver` manejable y el montaje con el proveedor. Los simulacros de pdf.js estan en
 * `viewerMocks.ts`. La aplicacion no importa este archivo.
 */

/* ------------------------------------------------------------------ *
 * Entorno de maquetacion
 * ------------------------------------------------------------------ */

export type LayoutEnv = {
  /** Tamano del visor. */
  viewport: { width: number; height: number };
  /** Ancho de la fila de paneles de la suite (`data-pro-row`). */
  rowWidth: number;
  /** Fija el tamano y avisa a los ResizeObserver. */
  resize: (width: number, height: number) => void;
  /** Fija el ancho de la fila de paneles y avisa a los ResizeObserver. */
  resizeRow: (width: number) => void;
  /** Desplaza el visor a `top` y emite el evento de scroll. */
  scrollTo: (top: number, left?: number) => void;
  scrollTop: () => number;
  restore: () => void;
};

const scrollState = new WeakMap<Element, { top: number; left: number }>();
const observers = new Set<{ callback: ResizeObserverCallback }>();

/**
 * jsdom no maqueta: se simulan `clientWidth/clientHeight` del visor (por el atributo `data-pro-viewer-scroller`),
 * `scrollTop/scrollLeft`, `scrollTo`, `scrollBy` y `ResizeObserver`.
 */
export function installLayoutEnv(initial = { width: 800, height: 600 }): LayoutEnv {
  const env: LayoutEnv = {
    viewport: { ...initial },
    rowWidth: 1400,
    resize(width, height) {
      env.viewport = { width, height };
      act(() => {
        for (const observer of observers) observer.callback([], {} as ResizeObserver);
      });
    },
    resizeRow(width) {
      env.rowWidth = width;
      act(() => {
        for (const observer of observers) observer.callback([], {} as ResizeObserver);
      });
    },
    scrollTo(top, left = 0) {
      const scroller = document.querySelector("[data-pro-viewer-scroller]") as HTMLElement;
      act(() => {
        scrollState.set(scroller, { top, left });
        fireEvent.scroll(scroller);
      });
    },
    scrollTop() {
      const scroller = document.querySelector("[data-pro-viewer-scroller]") as HTMLElement;
      return scrollState.get(scroller)?.top ?? 0;
    },
    restore() {
      for (const [target, key, descriptor] of saved) {
        if (descriptor) Object.defineProperty(target, key, descriptor);
        else delete (target as Record<string, unknown>)[key];
      }
      saved.length = 0;
      observers.clear();
    },
  };
  const saved: [object, string, PropertyDescriptor | undefined][] = [];
  const define = (target: object, key: string, descriptor: PropertyDescriptor) => {
    saved.push([target, key, Object.getOwnPropertyDescriptor(target, key)]);
    Object.defineProperty(target, key, { configurable: true, ...descriptor });
  };
  const isScroller = (element: Element) => element.hasAttribute("data-pro-viewer-scroller");
  define(HTMLElement.prototype, "clientWidth", {
    get(this: HTMLElement) {
      if (this.hasAttribute("data-pro-row")) return env.rowWidth;
      return isScroller(this) ? env.viewport.width : 0;
    },
  });
  define(HTMLElement.prototype, "clientHeight", {
    get(this: HTMLElement) {
      return isScroller(this) ? env.viewport.height : 0;
    },
  });
  define(Element.prototype, "scrollTop", {
    get(this: Element) {
      return scrollState.get(this)?.top ?? 0;
    },
    set(this: Element, value: number) {
      scrollState.set(this, { top: value, left: scrollState.get(this)?.left ?? 0 });
    },
  });
  define(Element.prototype, "scrollLeft", {
    get(this: Element) {
      return scrollState.get(this)?.left ?? 0;
    },
    set(this: Element, value: number) {
      scrollState.set(this, { top: scrollState.get(this)?.top ?? 0, left: value });
    },
  });
  define(Element.prototype, "scrollTo", {
    value(this: Element, options?: ScrollToOptions | number, y?: number) {
      const top = typeof options === "number" ? y ?? 0 : options?.top ?? scrollState.get(this)?.top ?? 0;
      const left = typeof options === "number" ? options : options?.left ?? scrollState.get(this)?.left ?? 0;
      scrollState.set(this, { top, left });
      this.dispatchEvent(new Event("scroll"));
    },
  });
  define(Element.prototype, "scrollBy", {
    value(this: Element, options?: ScrollToOptions) {
      const current = scrollState.get(this) ?? { top: 0, left: 0 };
      scrollState.set(this, { top: current.top + (options?.top ?? 0), left: current.left + (options?.left ?? 0) });
      this.dispatchEvent(new Event("scroll"));
    },
  });
  define(Element.prototype, "getBoundingClientRect", {
    value(this: Element) {
      const width = isScroller(this as HTMLElement) ? env.viewport.width : 100;
      const height = isScroller(this as HTMLElement) ? env.viewport.height : 100;
      return { x: 0, y: 0, left: 0, top: 0, right: width, bottom: height, width, height, toJSON: () => ({}) } as DOMRect;
    },
  });
  class FakeResizeObserver {
    callback: ResizeObserverCallback;
    constructor(callback: ResizeObserverCallback) {
      this.callback = callback;
      observers.add(this);
    }
    observe() {}
    unobserve() {}
    disconnect() {
      observers.delete(this);
    }
  }
  const previousObserver = (globalThis as { ResizeObserver?: unknown }).ResizeObserver;
  (globalThis as { ResizeObserver: unknown }).ResizeObserver = FakeResizeObserver;
  const restoreInner = env.restore;
  env.restore = () => {
    restoreInner();
    (globalThis as { ResizeObserver?: unknown }).ResizeObserver = previousObserver;
  };

  let blobId = 0;
  const create = URL.createObjectURL;
  const revoke = URL.revokeObjectURL;
  URL.createObjectURL = () => `blob:mock-${(blobId += 1)}`;
  URL.revokeObjectURL = vi.fn();
  const restoreUrl = env.restore;
  env.restore = () => {
    restoreUrl();
    URL.createObjectURL = create;
    URL.revokeObjectURL = revoke;
  };
  return env;
}

/** Limpia la cache global y las huellas entre pruebas. */
export function resetViewerGlobals(): void {
  viewerRasterCache.clear();
  viewerSignatureMemo.clear();
  pdfMocks.reset();
}

/* ------------------------------------------------------------------ *
 * IntersectionObserver manejable (miniaturas)
 * ------------------------------------------------------------------ */

export type FakeIntersection = {
  /** Marca como visibles exactamente estos indices de miniatura. */
  setVisible: (indexes: number[]) => void;
  restore: () => void;
};

export function installIntersectionObserver(): FakeIntersection {
  const instances = new Set<{
    callback: IntersectionObserverCallback;
    elements: Set<Element>;
    visible: Set<Element>;
  }>();
  class FakeIntersectionObserver {
    private readonly record: { callback: IntersectionObserverCallback; elements: Set<Element>; visible: Set<Element> };
    constructor(callback: IntersectionObserverCallback) {
      this.record = { callback, elements: new Set(), visible: new Set() };
      instances.add(this.record);
    }
    observe(element: Element) {
      this.record.elements.add(element);
    }
    unobserve(element: Element) {
      this.record.elements.delete(element);
    }
    disconnect() {
      instances.delete(this.record);
    }
  }
  const previous = (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver;
  (globalThis as { IntersectionObserver: unknown }).IntersectionObserver = FakeIntersectionObserver;
  return {
    setVisible(indexes) {
      act(() => {
        for (const record of instances) {
          const entries: IntersectionObserverEntry[] = [];
          for (const element of record.elements) {
            const index = Number((element as HTMLElement).dataset.thumbIndex);
            const shouldBeVisible = indexes.includes(index);
            const wasVisible = record.visible.has(element);
            if (shouldBeVisible !== wasVisible) {
              if (shouldBeVisible) record.visible.add(element);
              else record.visible.delete(element);
              entries.push({ target: element, isIntersecting: shouldBeVisible } as IntersectionObserverEntry);
            }
          }
          if (entries.length > 0) record.callback(entries, {} as IntersectionObserver);
        }
      });
    },
    restore() {
      (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver = previous;
    },
  };
}

/* ------------------------------------------------------------------ *
 * Montaje
 * ------------------------------------------------------------------ */

export type HarnessProps = {
  snapshot: ViewerSnapshot | null;
  pageCountHint?: number;
  announce?: (text: string) => void;
  getAnnouncementId?: () => number | null;
  store?: ProViewerStore;
  children: ReactNode;
};

/** Cambia el idioma mientras esta montado y vuelve a español al desmontarse (el idioma es global al modulo). */
export function SetLanguage({ language }: { language: Language }) {
  const { setLanguage } = useI18n();
  useEffect(() => {
    setLanguage(language);
    return () => setLanguage("es");
  }, [language, setLanguage]);
  return null;
}

/** Idioma + proveedor del visor (documento de pdf.js simulado). */
export function ViewerHarness({ snapshot, pageCountHint, announce, getAnnouncementId, store, children }: HarnessProps) {
  return (
    <LanguageProvider>
      <ProViewerProvider
        snapshot={snapshot}
        pageCountHint={pageCountHint}
        announce={announce}
        getAnnouncementId={getAnnouncementId}
        store={store}
      >
        {children}
      </ProViewerProvider>
    </LanguageProvider>
  );
}

/** Espera a que los efectos y las promesas pendientes (apertura del documento, medidas, renders) se asienten. */
export async function settle(times = 6): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}
