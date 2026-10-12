import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { LANGUAGE_STORAGE_KEY, LanguageProvider } from "@/lib/i18n";
import { CompressOptionsPanel } from "@/app/compress-pdf/CompressOptionsPanel";
import { CompressSummary } from "@/app/compress-pdf/CompressSummary";
import { COMPRESS_STRINGS } from "@/app/compress-pdf/strings";
import { CropScopePanel } from "@/app/crop-pdf/CropScopePanel";
import { CROP_STRINGS } from "@/app/crop-pdf/strings";
import { OcrOptionsPanel } from "@/app/ocr-pdf/OcrOptionsPanel";
import { OCR_STRINGS } from "@/app/ocr-pdf/strings";
import { ProtectOptionsPanel } from "@/app/protect-pdf/ProtectOptionsPanel";
import { PROTECT_STRINGS } from "@/app/protect-pdf/strings";
import { RepairReportView } from "@/app/repair-pdf/RepairReportView";
import { REPAIR_STRINGS } from "@/app/repair-pdf/strings";
import { RotateAnglePanel } from "@/app/rotate-pdf/RotateAnglePanel";
import { getRotateStrings } from "@/app/rotate-pdf/strings";
import { ProtectionNotice } from "@/app/unlock-pdf/ProtectionNotice";
import { DEFAULT_COMPRESS_OPTIONS, type CompressOptions } from "@/lib/pdf/compress";
import { DEFAULT_CROP_OPTIONS, type CropOptions } from "@/lib/pdf/crop";
import { DEFAULT_OCR_OPTIONS, type OcrOptions } from "@/lib/pdf/ocr";
import { DEFAULT_PROTECT_OPTIONS, type ProtectOptions } from "@/lib/pdf/protect";
import type { RepairReport } from "@/lib/pdf/repair";
import { KeyRound } from "lucide-react";
import { MmField } from "@/app/pdf-pro/tabs/panels/MmField";

/**
 * Paneles EXTRAIDOS de las herramientas sueltas y compartidos con PDF Pro (U5): cada uno se monta solo, con
 * un estado controlado, para comprobar que sigue siendo el mismo componente de siempre.
 */

beforeAll(() => {
  window.localStorage.setItem(LANGUAGE_STORAGE_KEY, "es");
});
afterEach(() => cleanup());

function Host<T extends object>({ initial, children }: { initial: T; children: (state: T, patch: (p: Partial<T>) => void) => React.ReactNode }) {
  const [state, setState] = useState(initial);
  return <LanguageProvider>{children(state, (patch) => setState((previous) => ({ ...previous, ...patch })))}</LanguageProvider>;
}

describe("CompressOptionsPanel", () => {
  const s = COMPRESS_STRINGS.es;
  const view = (fileSize?: number, onState?: (o: CompressOptions) => void) =>
    render(
      <Host<CompressOptions> initial={{ ...DEFAULT_COMPRESS_OPTIONS }}>
        {(options, patch) => {
          onState?.(options);
          return <CompressOptionsPanel options={options} setOptions={patch} strings={s} fileSize={fileSize} />;
        }}
      </Host>,
    );

  it("ofrece los tres niveles con «recomendado» marcado", () => {
    view();
    expect(screen.getAllByRole("radio")).toHaveLength(3);
    expect(screen.getByRole("radio", { name: new RegExp(s.recommendedName) }).getAttribute("aria-checked")).toBe("true");
  });

  it("elegir un nivel cambia solo el nivel", () => {
    let last!: CompressOptions;
    view(undefined, (o) => (last = o));
    fireEvent.click(screen.getByRole("radio", { name: new RegExp(s.extremeName) }));
    expect(last).toEqual({ level: "extreme", mode: "recompress" });
  });

  it("«Aplanar documento escaneado» alterna el modo", () => {
    let last!: CompressOptions;
    view(undefined, (o) => (last = o));
    fireEvent.click(screen.getByRole("checkbox", { name: new RegExp(s.flattenModeLabel) }));
    expect(last.mode).toBe("flatten");
    fireEvent.click(screen.getByRole("checkbox", { name: new RegExp(s.flattenModeLabel) }));
    expect(last.mode).toBe("recompress");
  });

  it("avisa de un archivo enorme solo al aplanar", () => {
    view(101 * 1024 * 1024);
    expect(screen.queryByText(s.largeFile)).toBeNull();
    fireEvent.click(screen.getByRole("checkbox", { name: new RegExp(s.flattenModeLabel) }));
    expect(screen.getByText(s.largeFile)).toBeTruthy();
  });
});

describe("CompressSummary", () => {
  const props = { strings: COMPRESS_STRINGS.es, locale: "es-ES", filename: "a.pdf", mode: "recompress" as const };

  it("muestra antes, despues y ahorro medido", () => {
    render(<CompressSummary {...props} originalSize={2_000_000} compressedSize={500_000} alreadyOptimized={false} />);
    expect(screen.getByText("−75%")).toBeTruthy();
    expect(screen.getByText(props.strings.gainHint)).toBeTruthy();
    expect(screen.getByText("a.pdf")).toBeTruthy();
  });

  it("sin ganancia: 0 % y el mensaje de «ya optimizado», segun el modo", () => {
    const { rerender } = render(<CompressSummary {...props} originalSize={1000} compressedSize={1000} alreadyOptimized />);
    expect(screen.getByText("0%")).toBeTruthy();
    expect(screen.getByText(props.strings.noGainHint)).toBeTruthy();
    rerender(<CompressSummary {...props} mode="flatten" originalSize={1000} compressedSize={1000} alreadyOptimized />);
    expect(screen.getByText(props.strings.flattenNoGainHint)).toBeTruthy();
  });

  it("un resultado mayor se marca con «+»", () => {
    render(<CompressSummary {...props} originalSize={1000} compressedSize={1500} alreadyOptimized={false} />);
    expect(screen.getByText("+50%")).toBeTruthy();
  });
});

describe("CropScopePanel", () => {
  it("alterna entre todas las paginas y solo la visible", () => {
    let last!: CropOptions;
    render(
      <Host<CropOptions> initial={{ ...DEFAULT_CROP_OPTIONS }}>
        {(options, patch) => {
          last = options;
          return <CropScopePanel options={options} setOptions={patch} strings={CROP_STRINGS.es} />;
        }}
      </Host>,
    );
    fireEvent.click(screen.getByRole("tab", { name: CROP_STRINGS.es.scopeCurrent }));
    expect(last.scope).toBe("current");
    expect(screen.getByText(CROP_STRINGS.es.scopeHint)).toBeTruthy();
  });
});

describe("RotateAnglePanel", () => {
  const strings = getRotateStrings("es");
  const view = (hint?: string | null) => {
    const onChange = vi.fn();
    render(
      <LanguageProvider>
        <RotateAnglePanel angle={90} onChange={onChange} strings={strings} hint={hint} />
      </LanguageProvider>,
    );
    return onChange;
  };

  it("elegir 270° avisa con el numero", () => {
    const onChange = view();
    fireEvent.click(screen.getByRole("tab", { name: "270°" }));
    expect(onChange).toHaveBeenCalledWith(270);
  });

  it("por defecto explica que se aplica a todas las paginas; con `null` no dice nada; con texto, el suyo", () => {
    view();
    expect(screen.getByText(strings.allHint)).toBeTruthy();
    cleanup();
    view(null);
    expect(screen.queryByText(strings.allHint)).toBeNull();
    cleanup();
    view("Texto propio");
    expect(screen.getByText("Texto propio")).toBeTruthy();
  });
});

describe("OcrOptionsPanel", () => {
  it("cambia el idioma y repite el aviso de descarga", () => {
    let last!: OcrOptions;
    render(
      <Host<OcrOptions> initial={{ ...DEFAULT_OCR_OPTIONS }}>
        {(options, patch) => {
          last = options;
          return <OcrOptionsPanel options={options} setOptions={patch} strings={OCR_STRINGS.es} />;
        }}
      </Host>,
    );
    fireEvent.click(screen.getByRole("tab", { name: "Inglés" }));
    expect(last.language).toBe("eng");
    expect(screen.getByText(OCR_STRINGS.es.downloadNotice)).toBeTruthy();
  });

  it("avisa de un archivo de mas de 100 MB", () => {
    render(
      <LanguageProvider>
        <OcrOptionsPanel options={DEFAULT_OCR_OPTIONS} setOptions={() => {}} strings={OCR_STRINGS.es} fileSize={150 * 1024 * 1024} />
      </LanguageProvider>,
    );
    expect(screen.getByText(OCR_STRINGS.es.largeFile)).toBeTruthy();
  });
});

const exact = (text: string) => new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));

describe("ProtectOptionsPanel", () => {
  const s = PROTECT_STRINGS.es;
  const view = () => {
    let last!: ProtectOptions;
    render(
      <Host<ProtectOptions> initial={{ ...DEFAULT_PROTECT_OPTIONS }}>
        {(options, patch) => {
          last = options;
          return <ProtectOptionsPanel options={options} setOptions={patch} strings={s} />;
        }}
      </Host>,
    );
    return () => last;
  };

  it("escribir la contraseña y su confirmacion actualiza las opciones", () => {
    const get = view();
    fireEvent.change(screen.getByLabelText(s.passwordLabel), { target: { value: "abcd1234" } });
    fireEvent.change(screen.getByLabelText(s.confirmLabel), { target: { value: "abcd1234" } });
    expect(get()).toMatchObject({ password: "abcd1234", confirm: "abcd1234" });
  });

  it("marca la contraseña como invalida con un caracter fuera de Latin-1", () => {
    view();
    fireEvent.change(screen.getByLabelText(s.passwordLabel), { target: { value: "ab€d" } });
    expect(screen.getByLabelText(s.passwordLabel).getAttribute("aria-invalid")).toBe("true");
  });

  it("una confirmacion distinta se explica en linea", () => {
    view();
    fireEvent.change(screen.getByLabelText(s.passwordLabel), { target: { value: "abcd1234" } });
    fireEvent.change(screen.getByLabelText(s.confirmLabel), { target: { value: "otra" } });
    expect(screen.getByText(s.errors.mismatch)).toBeTruthy();
  });

  it("los seis permisos parten concedidos y cada casilla cambia el suyo", () => {
    const get = view();
    for (const label of [s.permissionPrinting, s.permissionCopying, s.permissionModifying, s.permissionAnnotating, s.permissionFillingForms, s.permissionDocumentAssembly]) {
      const box = screen.getByRole("checkbox", { name: exact(label) });
      expect(box.getAttribute("aria-checked") ?? (box as HTMLInputElement).checked).toBeTruthy();
    }
    fireEvent.click(screen.getByRole("checkbox", { name: exact(s.permissionPrinting) }));
    expect(get().allowPrinting).toBe(false);
    fireEvent.click(screen.getByRole("checkbox", { name: exact(s.permissionDocumentAssembly) }));
    expect(get().allowDocumentAssembly).toBe(false);
  });

  it("sin «pedir contraseña al abrir» avisa de que se abre sin ella", () => {
    view();
    expect(screen.queryByText(s.openWithoutPasswordWarning)).toBeNull();
    fireEvent.click(screen.getByRole("checkbox", { name: exact(s.requirePasswordLabel) }));
    expect(screen.getByText(s.openWithoutPasswordWarning)).toBeTruthy();
  });
});

describe("RepairReportView", () => {
  const s = REPAIR_STRINGS.es;
  const base: RepairReport = {
    damage: ["eof"],
    actions: ["reindexed"],
    mode: "structural",
    pagesRecovered: 3,
    pagesDeclared: 5,
    bytesDiscarded: 2048,
    textPreserved: true,
    failedPages: [4],
    inputBytes: 100,
    outputBytes: 90,
  } as unknown as RepairReport;

  it("muestra el diagnostico, lo hecho y el resultado medido, con las paginas perdidas", () => {
    render(<RepairReportView s={s} outcome={{ report: base }} language="es-ES" />);
    expect(screen.getByText(s.damage.eof)).toBeTruthy();
    expect(screen.getByText(s.actions.reindexed)).toBeTruthy();
    expect(screen.getByText(s.pagesRecoveredOf(3, 5))).toBeTruthy();
    expect(screen.getByText(s.pagesLost(2))).toBeTruthy();
    expect(screen.getByText(s.failedPages("4"))).toBeTruthy();
    expect(screen.getByText(s.textPreserved)).toBeTruthy();
  });

  it("sin daños ni acciones lo dice y confirma que no falta ninguna pagina", () => {
    render(
      <RepairReportView
        s={s}
        outcome={{ report: { ...base, damage: [], actions: [], pagesRecovered: 5, pagesDeclared: 5, bytesDiscarded: 0, failedPages: [] } }}
        language="es-ES"
      />,
    );
    expect(screen.getByText(s.damageNone)).toBeTruthy();
    expect(screen.getByText(s.actionsNone)).toBeTruthy();
    expect(screen.getByText(s.pagesComplete)).toBeTruthy();
  });

  it("sin denominador declarado no inventa una perdida", () => {
    render(<RepairReportView s={s} outcome={{ report: { ...base, pagesDeclared: null, failedPages: [], bytesDiscarded: 0 } }} language="es-ES" />);
    expect(screen.getByText(s.pagesRecovered(3))).toBeTruthy();
    expect(screen.queryByText(/perdi/i)).toBeNull();
  });
});

describe("ProtectionNotice", () => {
  it("pinta icono decorativo, titulo y cuerpo", () => {
    const { container } = render(<ProtectionNotice icon={KeyRound} tone="security" title="Titulo" body="Cuerpo largo" />);
    expect(screen.getByRole("heading", { name: "Titulo" })).toBeTruthy();
    expect(screen.getByText("Cuerpo largo")).toBeTruthy();
    expect(container.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
  });
});

describe("MmField", () => {
  it("acepta decimales con coma o punto y solo comunica valores validos", () => {
    const onChange = vi.fn();
    render(<MmField label="Arriba" value={10} onChange={onChange} />);
    const input = screen.getByRole("spinbutton", { name: "Arriba (mm)" }) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "12.5" } });
    expect(onChange).toHaveBeenLastCalledWith(12.5);
    fireEvent.change(input, { target: { value: "" } });
    expect(onChange).toHaveBeenLastCalledWith(0);
  });

  it("acota al minimo y al maximo", () => {
    const onChange = vi.fn();
    render(<MmField label="Arriba" value={10} onChange={onChange} max={50} />);
    const input = screen.getByRole("spinbutton", { name: "Arriba (mm)" });
    fireEvent.change(input, { target: { value: "-4" } });
    expect(onChange).toHaveBeenLastCalledWith(0);
    fireEvent.change(input, { target: { value: "999" } });
    expect(onChange).toHaveBeenLastCalledWith(50);
  });

  it("mide 44 px de alto y tiene etiqueta accesible", () => {
    render(<MmField label="Arriba" value={3} onChange={() => {}} />);
    const input = screen.getByRole("spinbutton", { name: "Arriba (mm)" });
    expect(input.className).toContain("h-11");
  });
});
