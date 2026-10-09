import { describe, expect, it, vi } from "vitest";
import { fireEvent, render } from "@testing-library/react";
import { FileDropzone } from "@/components/tool/FileDropzone";
import {
  FileAdmissionContext,
  type FileAdmission,
} from "@/components/tool/fileAdmission";
import { LanguageProvider } from "@/lib/i18n";
import { getTool } from "@/lib/tools-registry";

const MB = 1024 * 1024;
const multiple = { ...getTool("sign-pdf"), multiple: true };
const single = { ...getTool("sign-pdf"), multiple: false };

function pdf(name: string, mb?: number): File {
  const file = new File([new Uint8Array([1, 2, 3])], name, { type: "application/pdf" });
  if (mb !== undefined) Object.defineProperty(file, "size", { value: mb * MB });
  return file;
}

function setup(
  tool: typeof multiple,
  props: { files?: File[]; admission?: FileAdmission | null; onSkipped?: (f: File[]) => void } = {},
) {
  const calls: string[] = [];
  const onFilesChange = vi.fn((files: File[]) => calls.push(`files:${files.map((f) => f.name).join(",")}`));
  const onError = vi.fn((code: string) => calls.push(`error:${code}`));
  const view = render(
    <LanguageProvider>
      <FileAdmissionContext.Provider value={props.admission ?? null}>
        <FileDropzone
          tool={tool}
          files={props.files ?? []}
          onFilesChange={onFilesChange}
          onError={onError}
          onSkipped={props.onSkipped}
        />
      </FileAdmissionContext.Provider>
    </LanguageProvider>,
  );
  const input = view.container.querySelector('input[type="file"]') as HTMLInputElement;
  const pick = (...files: File[]) => fireEvent.change(input, { target: { files } });
  return { calls, onFilesChange, onError, pick };
}

describe("FileDropzone — src/components/tool/FileDropzone.tsx", () => {
  it("un archivo de mas de 100 MB pasa, pero el aviso se publica DESPUES de cambiar los archivos (el shell borra los errores al cambiarlos)", () => {
    const { calls, pick } = setup(single);
    pick(pdf("grande.pdf", 130));
    expect(calls).toEqual(["files:grande.pdf", "error:tooLarge"]);
  });

  it("sin archivos pesados no publica ningun error", () => {
    const { calls, pick } = setup(multiple);
    pick(pdf("a.pdf"), pdf("b.pdf"));
    expect(calls).toEqual(["files:a.pdf,b.pdf"]);
  });

  it("un tipo no valido sin otros validos sigue siendo error de tipo", () => {
    const { calls, pick } = setup(multiple);
    pick(new File(["x"], "nota.txt", { type: "text/plain" }));
    expect(calls).toEqual(["error:invalidType"]);
  });

  it("los descartados por formato se avisan despues de cambiar los archivos", () => {
    const onSkipped = vi.fn();
    const { calls, pick } = setup(multiple, { onSkipped });
    pick(pdf("a.pdf"), new File(["x"], "nota.txt", { type: "text/plain" }));
    expect(calls).toEqual(["files:a.pdf"]);
    expect(onSkipped).toHaveBeenCalledTimes(1);
  });

  it("con puerta de admision (herramienta con topes propios) manda ella: lo rechazado no entra y el aviso se entrega", () => {
    const admission: FileAdmission = {
      admit: (_current, incoming) => ({
        accepted: incoming.filter((file) => file.size <= 100 * MB),
        notice: "uno quedo fuera",
      }),
      onNotice: vi.fn(),
    };
    const { calls, pick } = setup(multiple, { admission });
    pick(pdf("a.pdf"), pdf("enorme.pdf", 150));
    expect(calls).toEqual(["files:a.pdf"]);
    expect(admission.onNotice).toHaveBeenCalledWith("uno quedo fuera");
  });

  it("si la puerta rechaza todo, no se cambian los archivos", () => {
    const admission: FileAdmission = {
      admit: () => ({ accepted: [], notice: "nada cupo" }),
      onNotice: vi.fn(),
    };
    const { calls, onFilesChange, pick } = setup(multiple, { admission });
    pick(pdf("a.pdf"));
    expect(onFilesChange).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
    expect(admission.onNotice).toHaveBeenCalledWith("nada cupo");
  });

  it("la puerta recibe los archivos que ya hay y los nuevos, en ese orden", () => {
    const admit = vi.fn((_current: readonly File[], incoming: readonly File[]) => ({
      accepted: [...incoming],
      notice: null,
    }));
    const existing = pdf("ya.pdf");
    const { calls, pick } = setup(multiple, { files: [existing], admission: { admit, onNotice: vi.fn() } });
    pick(pdf("nuevo.pdf"));
    expect(admit.mock.calls[0][0]).toEqual([existing]);
    expect(calls).toEqual(["files:ya.pdf,nuevo.pdf"]);
  });

  it("una carga sin avisos limpia el aviso anterior de la puerta", () => {
    const onNotice = vi.fn();
    const { pick } = setup(multiple, {
      admission: { admit: (_c, incoming) => ({ accepted: [...incoming], notice: null }), onNotice },
    });
    pick(pdf("a.pdf"));
    expect(onNotice).toHaveBeenCalledWith(null);
  });

  it("una herramienta de un solo archivo ignora la puerta de admision", () => {
    const admission: FileAdmission = {
      admit: vi.fn(() => ({ accepted: [], notice: "no" })),
      onNotice: vi.fn(),
    };
    const { calls, pick } = setup(single, { admission });
    pick(pdf("a.pdf"));
    expect(admission.admit).not.toHaveBeenCalled();
    expect(calls).toEqual(["files:a.pdf"]);
  });
});
