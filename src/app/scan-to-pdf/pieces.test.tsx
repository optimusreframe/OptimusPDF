import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { useEffect, useState } from "react";
import { LANGUAGE_STORAGE_KEY, LanguageProvider } from "@/lib/i18n";
import { makeBarePage } from "@/lib/scan/testing/fakeEngine";
import { NO_CAPS, readCaps, zoomSteps } from "@/app/scan-to-pdf/cameraControls";
import { composeIdSheet, splitSpreadFallback } from "@/app/scan-to-pdf/imageTools";
import { ModeChips, SCAN_MODES } from "@/app/scan-to-pdf/ModeChips";
import { ADJUST_COMMIT_MS, PageEditor, adjustPreview } from "@/app/scan-to-pdf/PageEditor";
import { PageGrid, VIRTUALIZE_FROM } from "@/app/scan-to-pdf/PageGrid";
import { ScanLiveProvider, useAnnounce } from "@/app/scan-to-pdf/ScanLive";
import { SCAN_PREFS_KEY, readScanPrefs, writeScanPrefs } from "@/app/scan-to-pdf/scanPrefs";
import { STRINGS } from "@/app/scan-to-pdf/strings";
import { useBlobUrl } from "@/app/scan-to-pdf/useBlobUrl";
import { DEFAULT_SCAN_SETTINGS } from "@/lib/scan/types";

const s = STRINGS.es;

beforeAll(() => {
  window.localStorage.setItem(LANGUAGE_STORAGE_KEY, "es");
  Element.prototype.getClientRects = function getClientRects() {
    return [{ width: 1, height: 1 }] as unknown as DOMRectList;
  };
  HTMLCanvasElement.prototype.getContext = (() => null) as unknown as HTMLCanvasElement["getContext"];
});

describe("textos ES/EN: las dos lenguas tienen las mismas claves y ningun valor vacio", () => {
  const walk = (value: unknown, path: string, out: string[]) => {
    if (typeof value === "string") {
      if (value.trim() === "") out.push(`${path} vacio`);
    } else if (typeof value === "function") {
      out.push(path);
    } else if (value && typeof value === "object") {
      for (const [key, inner] of Object.entries(value)) walk(inner, `${path}.${key}`, out);
    }
  };
  const shape = (value: unknown, path = ""): string[] =>
    typeof value === "object" && value !== null
      ? Object.entries(value).flatMap(([key, inner]) => shape(inner, `${path}.${key}`))
      : [`${path}:${typeof value}`];

  it("misma forma", () => {
    expect(shape(STRINGS.en).sort()).toEqual(shape(STRINGS.es).sort());
  });
  it("sin valores vacios", () => {
    const empty: string[] = [];
    for (const language of ["es", "en"] as const) walk(STRINGS[language], language, empty);
    expect(empty.filter((entry) => entry.endsWith("vacio"))).toEqual([]);
  });
  it("las funciones de texto devuelven texto con los numeros dentro (plurales incluidos)", () => {
    for (const language of ["es", "en"] as const) {
      const t = STRINGS[language];
      expect(t.pagesBadge(1)).toContain("1");
      expect(t.pagesBadge(7)).toContain("7");
      expect(t.review(3)).toContain("3");
      expect(t.save(12)).toContain("12");
      expect(t.tileLabel(3, 12, ["borrosa"])).toContain("3");
      expect(t.tileLabel(3, 12, [])).not.toContain(",");
      expect(t.said.removed(1)).not.toBe(t.said.removed(2));
      expect(t.leaveBodySaved(1)).not.toBe(t.leaveBodySaved(2));
    }
  });
});

describe("ModeChips", () => {
  it("seis modos en una fila; el activo marcado; cada chip tiene alto de 44 px (h-11)", () => {
    const onChange = vi.fn();
    render(<ModeChips s={s} mode="book" onChange={onChange} />);
    const buttons = screen.getAllByRole("button");
    expect(buttons).toHaveLength(SCAN_MODES.length);
    expect(screen.getByRole("button", { name: "Libro" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: "Foto" }).getAttribute("aria-pressed")).toBe("false");
    for (const button of buttons) expect(button.className).toContain("h-11");
    fireEvent.click(screen.getByRole("button", { name: "Pizarra" }));
    expect(onChange).toHaveBeenCalledWith("whiteboard");
    // La fila se desplaza con un dedo en horizontal.
    expect((screen.getByRole("group", { name: s.modeLabel }) as HTMLElement).style.touchAction).toBe("pan-x");
  });
});

describe("cameraControls: degradan sin capacidades", () => {
  const track = (caps: unknown) => ({ getCapabilities: () => caps }) as unknown as MediaStreamTrack;
  it("sin pista o sin getCapabilities (Safari): nada disponible", () => {
    expect(readCaps(null)).toEqual(NO_CAPS);
    expect(readCaps({} as MediaStreamTrack)).toEqual(NO_CAPS);
    expect(readCaps({ getCapabilities: () => { throw new Error("x"); } } as unknown as MediaStreamTrack)).toEqual(NO_CAPS);
  });
  it("lee linterna, zoom y enfoque de un disparo", () => {
    expect(readCaps(track({ torch: true, zoom: { min: 1, max: 5, step: 0.5 }, focusMode: ["continuous", "single-shot"] }))).toEqual({ torch: true, zoom: { min: 1, max: 5, step: 0.5 }, focus: true });
    expect(readCaps(track({ zoom: { min: 1, max: 1 } })).zoom).toBeNull();
    expect(readCaps(track({ focusMode: ["continuous"] })).focus).toBe(false);
  });
  it("pasos de zoom dentro del rango", () => {
    expect(zoomSteps({ min: 1, max: 4 })).toEqual([1, 2, 3]);
    expect(zoomSteps({ min: 1, max: 10 })).toEqual([1, 2, 3, 5]);
    expect(zoomSteps({ min: 1, max: 1.5 })).toEqual([1]);
    expect(zoomSteps({ min: 2, max: 8 })).toEqual([2, 3, 5]);
  });
});

describe("imageTools sin canvas (jsdom)", () => {
  it("la hoja de identificacion degrada al anverso; el libro no se parte sin canvas", async () => {
    const front = new Blob(["f"]);
    expect(await composeIdSheet(front, new Blob(["b"]))).toBe(front);
    expect(await splitSpreadFallback(new Blob(["x"]))).toBeNull();
  });
});

describe("preferencias del escaner", () => {
  afterEach(() => window.localStorage.removeItem(SCAN_PREFS_KEY));
  it("ida y vuelta, y valores raros se ignoran", () => {
    writeScanPrefs({ ...DEFAULT_SCAN_SETTINGS, mode: "receipt", autoCapture: false, batch: false });
    expect(readScanPrefs()).toEqual({ mode: "receipt", autoCapture: false, batch: false });
    window.localStorage.setItem(SCAN_PREFS_KEY, JSON.stringify({ mode: "hacker", autoCapture: "si", batch: 1 }));
    expect(readScanPrefs()).toEqual({});
    window.localStorage.setItem(SCAN_PREFS_KEY, "{no es json");
    expect(readScanPrefs()).toEqual({});
  });
});

describe("useBlobUrl: una URL por blob, compartida y revocada al soltarla", () => {
  it("cuenta usos", async () => {
    let n = 0;
    const created: string[] = [];
    const revoked: string[] = [];
    URL.createObjectURL = () => {
      const url = `blob:u${(n += 1)}`;
      created.push(url);
      return url;
    };
    URL.revokeObjectURL = (url: string) => {
      revoked.push(url);
    };
    const blob = new Blob(["x"]);
    const first = renderHook(() => useBlobUrl(blob));
    const second = renderHook(() => useBlobUrl(blob));
    await act(async () => {});
    expect(first.result.current).toBe("blob:u1");
    expect(second.result.current).toBe("blob:u1");
    expect(created).toHaveLength(1);
    first.unmount();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
    });
    expect(revoked).toEqual([]);
    second.unmount();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
    });
    expect(revoked).toEqual(["blob:u1"]);
  });
  it("sin blob, nada", () => {
    expect(renderHook(() => useBlobUrl(null)).result.current).toBeNull();
  });
});

describe("region viva unica", () => {
  it("varios avisos del mismo instante se unen en UNO; el mismo texto dos veces vuelve a anunciarse", async () => {
    function Talk() {
      const announce = useAnnounce();
      const [n, setN] = useState(0);
      useEffect(() => {
        if (n === 0) return;
        announce("uno");
        announce("dos");
      }, [n, announce]);
      return <button onClick={() => setN((x) => x + 1)}>hablar</button>;
    }
    render(
      <ScanLiveProvider>
        <Talk />
      </ScanLiveProvider>,
    );
    const region = () => document.querySelector("[data-scan-live]")!;
    expect(document.querySelectorAll("[role=status]")).toHaveLength(1);
    fireEvent.click(screen.getByText("hablar"));
    await act(async () => {});
    expect(region().textContent).toBe("uno dos");
    fireEvent.click(screen.getByText("hablar"));
    await act(async () => {});
    expect(region().textContent).toBe("uno dos​");
  });
});

describe("PageGrid", () => {
  const noop = () => {};
  const grid = (count: number, extra: Partial<React.ComponentProps<typeof PageGrid>> = {}) => {
    const pages = Array.from({ length: count }, (_, index) => makeBarePage(`p${index}`));
    return render(
      <PageGrid
        s={s}
        pages={pages}
        pendingIds={[]}
        selection={new Set()}
        selecting={false}
        movingIds={null}
        scrollerRef={{ current: null }}
        onOpen={noop}
        onToggleSelect={noop}
        onRotate={noop}
        onRemove={noop}
        onMore={noop}
        onChip={noop}
        onDrop={noop}
        onShift={noop}
        onMoveHere={noop}
        announce={noop}
        {...extra}
      />,
    );
  };
  beforeAll(() => {
    URL.createObjectURL = () => "blob:t";
    URL.revokeObjectURL = () => {};
  });

  it("menos de 30 paginas: se pintan todas; es una lista con posicion y tamano para lectores de pantalla", () => {
    grid(VIRTUALIZE_FROM - 1);
    const items = screen.getAllByRole("listitem");
    expect(items).toHaveLength(VIRTUALIZE_FROM - 1);
    expect(items[2].getAttribute("aria-posinset")).toBe("3");
    expect(items[2].getAttribute("aria-setsize")).toBe(String(VIRTUALIZE_FROM - 1));
    expect(screen.getByRole("list", { name: s.gridLabel })).toBeTruthy();
  });

  it("con 100 paginas solo se pintan las de la ventana (virtualizacion) y el contenedor conserva el alto", () => {
    const { container } = grid(100);
    expect(container.querySelector("[data-virtual]")).not.toBeNull();
    const painted = screen.getAllByRole("listitem").length;
    expect(painted).toBeGreaterThan(0);
    expect(painted).toBeLessThan(40);
  });

  it("nombres accesibles: «Pagina n de N, aviso»; cada accion con el numero de su pagina", () => {
    const pages = [makeBarePage("a"), makeBarePage("b", { flags: { blurry: true } })];
    render(
      <PageGrid s={s} pages={pages} pendingIds={[]} selection={new Set()} selecting={false} movingIds={null} scrollerRef={{ current: null }} onOpen={noop} onToggleSelect={noop} onRotate={noop} onRemove={noop} onMore={noop} onChip={noop} onDrop={noop} onShift={noop} onMoveHere={noop} announce={noop} />,
    );
    expect(screen.getByRole("button", { name: "Página 2 de 2, borrosa" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Girar la página 1" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Borrar la página 2" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Más acciones de la página 2" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Mover la página 1" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Página 2: Borrosa. Repetir" })).toBeTruthy();
  });

  it("el asa lleva touch-action: none (solo ahi); la miniatura deja desplazar en vertical con un dedo", () => {
    grid(2);
    const handle = screen.getAllByRole("button", { name: /Mover la página/ })[0] as HTMLElement;
    expect(handle.style.touchAction).toBe("none");
    const main = screen.getAllByRole("button", { name: /^Página \d de 2$/ })[0] as HTMLElement;
    expect(main.style.touchAction).toBe("pan-y");
  });

  it("modo «Mover aqui»: cada tarjeta ofrece su destino, menos las que se mueven", () => {
    const onMoveHere = vi.fn();
    const { container } = grid(4, { movingIds: ["p1"], onMoveHere });
    const targets = container.querySelectorAll("[data-move-here]");
    expect(targets).toHaveLength(3);
    fireEvent.click(targets[2]);
    expect(onMoveHere).toHaveBeenCalledWith(3);
  });

  it("seleccionando, el toque marca (aria-pressed) y no abre; el asa desaparece", () => {
    const onToggle = vi.fn();
    const onOpen = vi.fn();
    grid(3, { selecting: true, selection: new Set(["p1"]), onToggleSelect: onToggle, onOpen });
    const second = screen.getByRole("button", { name: "Página 2 de 3" });
    expect(second.getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: "Página 1 de 3" }).getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(second);
    expect(onToggle).toHaveBeenCalledWith("p1");
    expect(onOpen).not.toHaveBeenCalled();
    expect(screen.queryAllByRole("button", { name: /Mover la página/ })).toHaveLength(0);
  });

  it("flechas, Inicio y Fin sobre el asa piden el movimiento; otras teclas no", () => {
    const onShift = vi.fn();
    grid(3, { onShift });
    const handle = screen.getAllByRole("button", { name: /Mover la página/ })[1];
    fireEvent.keyDown(handle, { key: "ArrowLeft" });
    fireEvent.keyDown(handle, { key: "ArrowDown" });
    fireEvent.keyDown(handle, { key: "Home" });
    fireEvent.keyDown(handle, { key: "End" });
    fireEvent.keyDown(handle, { key: "a" });
    expect(onShift.mock.calls).toEqual([["p1", -1], ["p1", 1], ["p1", -Infinity], ["p1", Infinity]]);
  });

  it("una pagina aun procesandose se marca y no ofrece avisos de calidad", () => {
    const pages = [makeBarePage("a", { thumb: null, flags: { blank: true } })];
    const { container } = render(
      <PageGrid s={s} pages={pages} pendingIds={["a"]} selection={new Set()} selecting={false} movingIds={null} scrollerRef={{ current: null }} onOpen={noop} onToggleSelect={noop} onRotate={noop} onRemove={noop} onMore={noop} onChip={noop} onDrop={noop} onShift={noop} onMoveHere={noop} announce={noop} />,
    );
    expect(container.querySelector("[data-tile-processing]")).not.toBeNull();
    expect(container.querySelector("[data-quality-chip]")).toBeNull();
  });
});

describe("PageEditor", () => {
  const pages = [makeBarePage("a"), makeBarePage("b"), makeBarePage("c")];
  const handlers = () => ({
    onNeedFull: vi.fn(),
    onSelect: vi.fn(),
    onClose: vi.fn(),
    onRotate: vi.fn(),
    onFilter: vi.fn(),
    onAdjust: vi.fn(),
    onCrop: vi.fn(),
    onRetake: vi.fn(),
    onViewSheet: vi.fn(),
    onApplyAll: vi.fn(),
  });
  const mount = (h = handlers(), pageId = "b", fresh = true) => {
    render(
      <LanguageProvider>
        <PageEditor s={s} pages={pages} pageId={pageId} isFresh={() => fresh} {...h} />
      </LanguageProvider>,
    );
    return h;
  };

  it("al abrir (y al cambiar de pagina) pide el resultado COMPLETO de la pagina que se ve", async () => {
    const h = mount();
    await screen.findByRole("dialog", { name: "Editar página 2 de 3" });
    expect(h.onNeedFull).toHaveBeenCalledWith("b");
  });

  it("titulo con la posicion, navegacion anterior/siguiente y cierre", async () => {
    const h = mount();
    expect(await screen.findByRole("dialog", { name: "Editar página 2 de 3" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: s.editorPrev }));
    expect(h.onSelect).toHaveBeenCalledWith("a");
    fireEvent.click(screen.getByRole("button", { name: s.editorNext }));
    expect(h.onSelect).toHaveBeenCalledWith("c");
    fireEvent.click(screen.getByRole("button", { name: s.editorDone }));
    expect(h.onClose).toHaveBeenCalled();
  });

  it("en la primera y la ultima, anterior / siguiente estan desactivados", () => {
    mount(handlers(), "a");
    expect((screen.getByRole("button", { name: s.editorPrev }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: s.editorNext }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("las seis opciones de filtro y las acciones llaman a sus manejadores", () => {
    const h = mount();
    const group = screen.getByRole("group", { name: s.filterLabel });
    expect(Array.from(group.querySelectorAll("button")).map((b) => b.textContent)).toEqual(["Auto", "Color", "Grises", "B/N", "Mejorado", "Original"]);
    fireEvent.click(screen.getByRole("button", { name: "Grises" }));
    expect(h.onFilter).toHaveBeenCalledWith("b", "grayscale");
    fireEvent.click(screen.getByRole("button", { name: s.editorCrop }));
    fireEvent.click(screen.getByRole("button", { name: s.editorRotate }));
    fireEvent.click(screen.getByRole("button", { name: s.retake }));
    fireEvent.click(screen.getByRole("button", { name: s.viewSheet }));
    fireEvent.click(screen.getByRole("button", { name: s.editorApplyAll }));
    expect([h.onCrop, h.onRotate, h.onRetake, h.onViewSheet, h.onApplyAll].map((fn) => fn.mock.calls.length)).toEqual([1, 1, 1, 1, 1]);
  });

  it("brillo/contraste: la vista previa es inmediata (CSS) y el recalculo se pide UNA vez al dejar de mover", () => {
    vi.useFakeTimers();
    const h = mount();
    fireEvent.click(screen.getByRole("tab", { name: s.editorAdjust }));
    const slider = screen.getByRole("slider", { name: s.brightness });
    fireEvent.change(slider, { target: { value: "20" } });
    fireEvent.change(slider, { target: { value: "40" } });
    expect(h.onAdjust).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(ADJUST_COMMIT_MS + 10);
    });
    expect(h.onAdjust).toHaveBeenCalledTimes(1);
    expect(h.onAdjust).toHaveBeenCalledWith("b", 0.4, 0);
    vi.useRealTimers();
  });

  it("adjustPreview: sin cambio nada; con cambio, brillo y contraste en CSS", () => {
    expect(adjustPreview(0, 0)).toBeUndefined();
    expect(adjustPreview(0.5, -0.5)).toBe("brightness(1.25) contrast(0.70)");
  });

  it("mientras se recalcula muestra el aviso de proceso", () => {
    mount(handlers(), "b", false);
    expect(document.querySelector("[data-editor-processing]")).not.toBeNull();
  });
});

describe("ScreenShell · modo segun lo que cabe", () => {
  it("holgado: la cabecera se queda arriba; justo: la cabecera se desplaza con la lista; aprieto: la pagina se desplaza", async () => {
    const { pickMode } = await import("@/app/scan-to-pdf/ScreenShell");
    // 393x852: ~720 de alto, barra de 81 y cabecera de 124.
    expect(pickMode(720, 81, 124)).toEqual({ flow: false, sticky: true });
    // 320x568: ~436 de alto: queda poco para la lista si la cabecera ocupa sitio.
    expect(pickMode(436, 123, 163)).toEqual({ flow: false, sticky: false });
    // Movil en horizontal o letra muy grande: casi no cabe nada.
    expect(pickMode(210, 100, 150)).toEqual({ flow: true, sticky: false });
    // El umbral exacto de cada modo.
    expect(pickMode(81 + 140, 81, 0).flow).toBe(false);
    expect(pickMode(81 + 139, 81, 0).flow).toBe(true);
    expect(pickMode(81 + 124 + 240, 81, 124).sticky).toBe(true);
    expect(pickMode(81 + 124 + 239, 81, 124).sticky).toBe(false);
  });
});
