/**
 * Auto-desplazamiento por TIEMPO al arrastrar cerca del borde de la zona visible.
 *
 * Antes (el reordenar de Pro y el lienzo) cada fotograma sumaba un numero fijo de px: a 120 Hz (iPad ProMotion) iba el
 * doble de rapido que a 60 Hz, y con el dedo quieto en el borde no habia desplazamiento alguno. Aqui la velocidad se
 * expresa en px/s, crece en rampa con lo cerca (o lo pasado) que esta el dedo del borde y se integra con el tiempo real
 * entre fotogramas (`dt`), asi que es la misma a cualquier frecuencia de refresco.
 */

/** Zona (px) desde el borde dentro de la cual empieza a desplazar. */
export const EDGE_ZONE_PX = 56;
/** Velocidad maxima (px/s) al llegar al borde. */
export const EDGE_MAX_SPEED = 640;
/** Maximo de la rampa (1 = velocidad maxima en el borde; el dedo que se sale de la zona visible sigue hasta 1,25). */
const OVERSHOOT_RAMP = 1.25;
/** Tope de `dt` (ms): una pausa del hilo (pestana en segundo plano) no debe provocar un salto enorme. */
const MAX_FRAME_MS = 50;

/**
 * Velocidad (px/s, con signo) para un dedo en `position` dentro de la zona visible `[min, max]`: negativa cerca del
 * borde de arriba (la pagina sube), positiva cerca del de abajo, 0 en el medio. Rampa lineal 0 -> `maxSpeed` a lo largo
 * de `zone` px y hasta `1,25 * maxSpeed` si el dedo se sale de la zona visible.
 */
export function edgeVelocity(
  position: number,
  min: number,
  max: number,
  options: { zone?: number; maxSpeed?: number } = {},
): number {
  const zone = options.zone ?? EDGE_ZONE_PX;
  const maxSpeed = options.maxSpeed ?? EDGE_MAX_SPEED;
  // Una zona visible mas estrecha que dos zonas y media: se reparte, para que el centro siempre sea una zona quieta.
  const effectiveZone = Math.min(zone, Math.max(8, (max - min) / 2.5));
  const intoTop = min + effectiveZone - position;
  if (intoTop > 0) return -maxSpeed * Math.min(OVERSHOOT_RAMP, intoTop / effectiveZone);
  const intoBottom = position - (max - effectiveZone);
  if (intoBottom > 0) return maxSpeed * Math.min(OVERSHOOT_RAMP, intoBottom / effectiveZone);
  return 0;
}

export type EdgeScrollerOptions = {
  /** Dedo ahora mismo (px de pantalla), o `null` si no hay arrastre. */
  pointer: () => { x: number; y: number } | null;
  /** Zona visible vertical (px de pantalla) en la que NO se desplaza; se relee en cada fotograma. */
  region: () => { top: number; bottom: number; left: number; right: number };
  /**
   * Aplica un desplazamiento (px) y devuelve cuanto se aplico de verdad. `axis` y `dy`: vertical = pagina; horizontal
   * solo si el consumidor lo admite (hoja ampliada). Devuelve 0 si ya no hay recorrido.
   */
  scroll: (dx: number, dy: number) => { dx: number; dy: number };
  /** Se llama tras cada desplazamiento real: el arrastre se reaplica en la posicion (nueva) bajo el dedo quieto. */
  onTick: () => void;
  /** Reloj y planificador inyectables (pruebas). */
  now?: () => number;
  request?: (callback: (time: number) => void) => number;
  cancel?: (handle: number) => void;
  /** Con `true` tambien desplaza en horizontal (hoja con zoom). */
  horizontal?: boolean;
};

/** Bucle de auto-desplazamiento por fotograma, con velocidad por tiempo. `start()` y `stop()` son idempotentes. */
export function createEdgeAutoScroller(options: EdgeScrollerOptions) {
  const now = options.now ?? (() => performance.now());
  const request = options.request ?? ((cb) => requestAnimationFrame(cb));
  const cancel = options.cancel ?? ((handle) => cancelAnimationFrame(handle));
  let handle: number | null = null;
  let last = 0;
  // Fraccion de px que aun no se aplico (los scrollers redondean a px enteros): evita perder velocidad en la rampa baja.
  let carryX = 0;
  let carryY = 0;

  const frame = () => {
    handle = null;
    const point = options.pointer();
    if (!point) return;
    const time = now();
    const dt = Math.min(MAX_FRAME_MS, Math.max(0, time - last));
    last = time;
    const region = options.region();
    const vy = edgeVelocity(point.y, region.top, region.bottom);
    const vx = options.horizontal ? edgeVelocity(point.x, region.left, region.right) : 0;
    if (vy !== 0 || vx !== 0) {
      carryX += (vx * dt) / 1000;
      carryY += (vy * dt) / 1000;
      const wantX = Math.trunc(carryX);
      const wantY = Math.trunc(carryY);
      if (wantX !== 0 || wantY !== 0) {
        const applied = options.scroll(wantX, wantY);
        // Sin recorrido (tope): se descarta lo pendiente en ese eje.
        carryX = applied.dx === 0 && wantX !== 0 ? 0 : carryX - applied.dx;
        carryY = applied.dy === 0 && wantY !== 0 ? 0 : carryY - applied.dy;
        if (applied.dx !== 0 || applied.dy !== 0) options.onTick();
      }
    } else {
      carryX = 0;
      carryY = 0;
    }
    handle = request(frame);
  };

  return {
    start() {
      if (handle !== null) return;
      last = now();
      carryX = 0;
      carryY = 0;
      handle = request(frame);
    },
    stop() {
      if (handle === null) return;
      cancel(handle);
      handle = null;
    },
    get running() {
      return handle !== null;
    },
  };
}

export type EdgeAutoScroller = ReturnType<typeof createEdgeAutoScroller>;
