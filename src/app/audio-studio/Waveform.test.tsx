import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { appendClip, emptyTrack } from "@/lib/media/audio/edit";
import { monoSine } from "@/lib/media/audio/testAudio";
import { Waveform, type WaveformProps } from "@/app/audio-studio/Waveform";

beforeAll(() => {
  // jsdom no dibuja en lienzos: sin contexto el componente solo se salta el dibujo.
  HTMLCanvasElement.prototype.getContext = (() => null) as typeof HTMLCanvasElement.prototype.getContext;
});
afterEach(cleanup);

const track = appendClip(emptyTrack(1000, 1), monoSine(5, 10, 1000), "pista").track; // 10 s a 1 kHz

function setup(props: Partial<WaveformProps> = {}) {
  const handlers = { onMove: vi.fn(), onDrag: vi.fn(), onTogglePlay: vi.fn(), onClearSelection: vi.fn() };
  render(<Waveform track={track} cursor={2000} playhead={null} selection={null} ariaLabel="Onda" valueText="Duración 10 s" {...handlers} {...props} />);
  return { slider: screen.getByRole("slider", { name: "Onda" }), ...handlers };
}

describe("Waveform: semantica", () => {
  it("es un slider enfocable con valor (segundos), rango y texto descriptivo; el lienzo no se anuncia", () => {
    const { slider } = setup();
    expect(slider.tabIndex).toBe(0);
    expect(slider.getAttribute("aria-valuemin")).toBe("0");
    expect(slider.getAttribute("aria-valuemax")).toBe("10");
    expect(slider.getAttribute("aria-valuenow")).toBe("2");
    expect(slider.getAttribute("aria-valuetext")).toBe("Duración 10 s");
    expect(slider.querySelector("canvas")?.getAttribute("aria-hidden")).toBe("true");
  });

  it("mientras suena, el valor anunciado es el cursor, no la posicion que se mueve cada fotograma", () => {
    const { slider } = setup({ playhead: 5000 });
    expect(slider.getAttribute("aria-valuenow")).toBe("2");
  });
});

describe("Waveform: teclado", () => {
  it("flechas mueven el cursor 0,1 s; con Ctrl 1 s; Arriba/Abajo 1 s; PageUp/PageDown 5 s", () => {
    const { slider, onMove } = setup();
    fireEvent.keyDown(slider, { key: "ArrowRight" });
    expect(onMove).toHaveBeenLastCalledWith(2100, false);
    fireEvent.keyDown(slider, { key: "ArrowLeft" });
    expect(onMove).toHaveBeenLastCalledWith(1900, false);
    fireEvent.keyDown(slider, { key: "ArrowRight", ctrlKey: true });
    expect(onMove).toHaveBeenLastCalledWith(3000, false);
    fireEvent.keyDown(slider, { key: "ArrowUp" });
    expect(onMove).toHaveBeenLastCalledWith(3000, false);
    fireEvent.keyDown(slider, { key: "ArrowDown" });
    expect(onMove).toHaveBeenLastCalledWith(1000, false);
    fireEvent.keyDown(slider, { key: "PageUp" });
    expect(onMove).toHaveBeenLastCalledWith(7000, false);
    fireEvent.keyDown(slider, { key: "PageDown" });
    expect(onMove).toHaveBeenLastCalledWith(0, false);
  });

  it("Inicio y Fin van a los extremos y el cursor nunca sale de la pista", () => {
    const { slider, onMove } = setup({ cursor: 50 });
    fireEvent.keyDown(slider, { key: "ArrowLeft", ctrlKey: true });
    expect(onMove).toHaveBeenLastCalledWith(0, false);
    fireEvent.keyDown(slider, { key: "End" });
    expect(onMove).toHaveBeenLastCalledWith(10000, false);
    fireEvent.keyDown(slider, { key: "Home" });
    expect(onMove).toHaveBeenLastCalledWith(0, false);
  });

  it("Mayus + flecha pide extender la seleccion", () => {
    const { slider, onMove } = setup();
    fireEvent.keyDown(slider, { key: "ArrowRight", shiftKey: true });
    expect(onMove).toHaveBeenLastCalledWith(2100, true);
    fireEvent.keyDown(slider, { key: "End", shiftKey: true });
    expect(onMove).toHaveBeenLastCalledWith(10000, true);
  });

  it("Espacio reproduce/pausa (sin desplazar la pagina) y Esc quita la seleccion solo si la hay", () => {
    const first = setup();
    expect(fireEvent.keyDown(first.slider, { key: " " })).toBe(false); // preventDefault
    expect(first.onTogglePlay).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(first.slider, { key: "Escape" });
    expect(first.onClearSelection).not.toHaveBeenCalled();
    cleanup();
    const second = setup({ selection: { start: 100, end: 900 } });
    fireEvent.keyDown(second.slider, { key: "Escape" });
    expect(second.onClearSelection).toHaveBeenCalledTimes(1);
  });

  it("otras teclas no se interceptan (Tab sigue funcionando)", () => {
    const { slider, onMove } = setup();
    expect(fireEvent.keyDown(slider, { key: "Tab" })).toBe(true);
    expect(onMove).not.toHaveBeenCalled();
  });
});

describe("Waveform: puntero", () => {
  const geometry = (slider: HTMLElement) => {
    slider.getBoundingClientRect = () => ({ left: 0, top: 0, width: 1000, height: 100, right: 1000, bottom: 100, x: 0, y: 0, toJSON: () => ({}) });
  };

  it("un clic mueve el cursor a ese punto; un arrastre selecciona entre el punto de partida y el actual", () => {
    const { slider, onMove, onDrag } = setup();
    geometry(slider);
    fireEvent.pointerDown(slider, { clientX: 250, pointerId: 1, button: 0 });
    fireEvent.pointerUp(slider, { clientX: 250, pointerId: 1 });
    expect(onMove).toHaveBeenLastCalledWith(2500, false);
    expect(onDrag).not.toHaveBeenCalled();

    fireEvent.pointerDown(slider, { clientX: 100, pointerId: 1, button: 0 });
    fireEvent.pointerMove(slider, { clientX: 400, pointerId: 1 });
    expect(onDrag).toHaveBeenLastCalledWith(1000, 4000, false);
    fireEvent.pointerUp(slider, { clientX: 600, pointerId: 1 });
    expect(onDrag).toHaveBeenLastCalledWith(1000, 6000, true);
  });

  it("un temblor de menos de 4 px no cuenta como arrastre", () => {
    const { slider, onMove, onDrag } = setup();
    geometry(slider);
    fireEvent.pointerDown(slider, { clientX: 500, pointerId: 1, button: 0 });
    fireEvent.pointerMove(slider, { clientX: 502, pointerId: 1 });
    fireEvent.pointerUp(slider, { clientX: 502, pointerId: 1 });
    expect(onDrag).not.toHaveBeenCalled();
    expect(onMove).toHaveBeenCalledWith(5000, false);
  });
});
