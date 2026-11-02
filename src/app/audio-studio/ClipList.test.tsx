import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ClipList } from "@/app/audio-studio/ClipList";
import { appendClip, emptyTrack, splitTrackAt } from "@/lib/media/audio/edit";
import { monoSine } from "@/lib/media/audio/testAudio";

afterEach(cleanup);

const strings = { title: "Clips", hint: "Orden", moveUp: "Subir {index}: {name}", moveDown: "Bajar {index}: {name}", remove: "Quitar {index}: {name}", clipOf: "Clip {index} de {total}" };

function setup(disabled = false) {
  let track = appendClip(emptyTrack(1000, 1), monoSine(5, 1, 1000), "uno.wav").track;
  track = appendClip(track, monoSine(5, 1, 1000), "dos.wav").track;
  track = splitTrackAt(track, 500);
  const onMove = vi.fn();
  const onRemove = vi.fn();
  render(<ClipList track={track} strings={strings} disabled={disabled} onMove={onMove} onRemove={onRemove} />);
  return { onMove, onRemove };
}

describe("ClipList", () => {
  it("lista los clips en orden, con su duracion, y cada boton nombra el clip y su puesto (aunque el nombre se repita tras dividir)", () => {
    setup();
    expect(screen.getAllByRole("listitem")).toHaveLength(3);
    expect(screen.getByRole("listitem", { name: "Clip 1 de 3" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Quitar 1: uno.wav" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Quitar 2: uno.wav" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Quitar 3: dos.wav" })).toBeTruthy();
  });

  it("subir/bajar/quitar llaman con los indices correctos; el primero no sube y el ultimo no baja", () => {
    const { onMove, onRemove } = setup();
    expect((screen.getByRole("button", { name: "Subir 1: uno.wav" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Bajar 3: dos.wav" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Subir 3: dos.wav" }));
    expect(onMove).toHaveBeenLastCalledWith(2, 1);
    fireEvent.click(screen.getByRole("button", { name: "Bajar 1: uno.wav" }));
    expect(onMove).toHaveBeenLastCalledWith(0, 1);
    fireEvent.click(screen.getByRole("button", { name: "Quitar 2: uno.wav" }));
    expect(onRemove).toHaveBeenCalledWith(1);
  });

  it("desactivada (importando/exportando) no deja tocar nada", () => {
    setup(true);
    expect(screen.getAllByRole("button").every((button) => (button as HTMLButtonElement).disabled)).toBe(true);
  });
});
