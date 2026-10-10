import type { PxRect } from "@/app/edit-pdf/editCanvasMath";

/**
 * Disposicion de los tiradores de redimensionar del bloque seleccionado (W5-U5, N3).
 *
 * Con el dedo, un tirador de 44 px centrado en cada esquina cubre 22 px hacia dentro: en un bloque estrecho o bajo
 * (una cifra, «Total») los cuatro tapan el centro y el segundo toque ya no llega al bloque, asi que no se puede
 * abrir el editor. Regla:
 *  - Bloque holgado: cuatro tiradores en las esquinas, centrados en ellas.
 *  - Bloque medio: los tiradores se encogen (>= `minInside`) hasta ocupar a lo sumo la mitad del lado menor (<= 25 %
 *    del area, centro libre).
 *  - Bloque pequeno (no cabe ni el minimo): tiradores EXTERNOS, a los lados de la ZONA DE TOQUE del bloque (alineados
 *    con su borde inferior; uno solo si falta sitio a un lado de la hoja, y DEBAJO si falta a los dos). El interior
 *    del bloque y su zona de toque quedan libres al 100 %.
 */

export type HandleName = "nw" | "ne" | "sw" | "se";

export type HandleBox = {
  handle: HandleName;
  left: number;
  top: number;
  size: number;
  /** Centro del punto visible dentro del propio tirador. */
  dotX: number;
  dotY: number;
};

export type HandleLayout = {
  mode: "inside" | "external";
  size: number;
  handles: HandleBox[];
};

/**
 * Un tirador interior mide a lo sumo esta fraccion del lado MENOR del bloque: asi los cuatro tapan <= 25 % del area y
 * ninguno llega al centro.
 */
export const HANDLE_INSIDE_RATIO = 0.5;

/** Amplia `rect` (centrada) hasta que mida al menos `min` por lado. */
export function expandToMin(rect: PxRect, min: number): PxRect {
  const width = Math.max(rect.width, min);
  const height = Math.max(rect.height, min);
  return {
    left: rect.left - (width - rect.width) / 2,
    top: rect.top - (height - rect.height) / 2,
    width,
    height,
  };
}

export function layoutResizeHandles(
  rect: PxRect,
  options: {
    ideal: number;
    minInside: number;
    pageWidth: number;
    /**
     * Zona de toque del bloque (su caja mas el margen de toque). Los tiradores EXTERNOS se colocan fuera de ella (y
     * nunca dentro de un cuadrado de `minZone` centrado en el bloque): el centro del bloque siempre devuelve el bloque
     * y un glifo diminuto sigue pudiendo tocarse dos veces para editarlo (W5-U5 · D3).
     */
    zone?: PxRect;
    minZone?: number;
  },
): HandleLayout {
  const { ideal, minInside, pageWidth } = options;
  const fit = Math.floor(Math.min(rect.width, rect.height) * HANDLE_INSIDE_RATIO);
  const inside = Math.min(ideal, fit);
  const right = rect.left + rect.width;
  const bottom = rect.top + rect.height;

  if (inside >= minInside) {
    const half = inside / 2;
    const corner = (handle: HandleName, x: number, y: number): HandleBox => ({
      handle,
      left: x - half,
      top: y - half,
      size: inside,
      dotX: half,
      dotY: half,
    });
    return {
      mode: "inside",
      size: inside,
      handles: [
        corner("nw", rect.left, rect.top),
        corner("ne", right, rect.top),
        corner("sw", rect.left, bottom),
        corner("se", right, bottom),
      ],
    };
  }

  // Externos: el vertice interior del tirador coincide con la esquina de la ZONA DE TOQUE (no de la caja: un glifo de
  // 1 x 2 px tiene su centro pegado a la caja y el tirador lo taparia).
  const size = ideal;
  const zone = expandToMin(options.zone ?? rect, options.minZone ?? 0);
  const zoneRight = zone.left + zone.width;
  const zoneBottom = zone.top + zone.height;
  const leftRoom = zone.left >= size;
  const rightRoom = pageWidth - zoneRight >= size;
  // A los LADOS de la zona, alineados con su borde inferior: la altura total (zona + tirador) no crece, asi la barra
  // acoplada (teclado abierto, pantalla baja) deja sitio a los tiradores (W5-U5 · D1).
  const ext = (handle: HandleName): HandleBox => {
    const west = handle === "nw" || handle === "sw";
    return {
      handle,
      left: west ? zone.left - size : zoneRight,
      top: zoneBottom - size,
      size,
      // El punto visible va pegado a la esquina inferior de la zona, FUERA de ella (nunca sobre el centro del bloque).
      dotX: west ? size - 6 : 6,
      dotY: size - 6,
    };
  };
  // Arriba queda el asa de mover (centrada) sin choques.
  let pair: HandleName[];
  if (leftRoom && rightRoom) pair = ["sw", "se"];
  else if (rightRoom) pair = ["se"];
  else if (leftRoom) pair = ["sw"];
  else {
    // Sin sitio a los lados (bloque casi de lado a lado de la hoja): los tiradores van DEBAJO de la caja, dentro de su
    // ancho (nunca por debajo de 44 px de lado; el centro del bloque sigue libre).
    const under = (handle: "sw" | "se"): HandleBox => {
      const west = handle === "sw";
      const unclamped = west ? zone.left : zoneRight - size;
      const left = Math.min(Math.max(0, unclamped), Math.max(0, pageWidth - size));
      return { handle, left, top: zoneBottom, size, dotX: west ? 6 : size - 6, dotY: 6 };
    };
    const handles = zone.width >= size * 2 ? [under("sw"), under("se")] : [under("se")];
    return { mode: "external", size, handles };
  }
  return { mode: "external", size, handles: pair.map(ext) };
}
