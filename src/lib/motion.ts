import type { Transition } from "motion/react";

/**
 * Base de motion al estilo Apple (WWDC 2018 "Designing Fluid Interfaces"),
 * para usar con `motion/react` (v14).
 *
 * Principios que codifica este modulo:
 * - Springs en vez de duraciones fijas: son interrumpibles y heredan la
 *   velocidad del gesto. El spring por defecto es criticamente amortiguado
 *   (sin rebote); el rebote (damping ~0.8) se reserva para gestos con
 *   inercia (flick, soltar un arrastre).
 * - Proyeccion de momentum: al soltar, se anima hacia donde el gesto IBA
 *   (`project`), no hacia el punto de snap mas cercano al dedo.
 * - Rubber-band en los bordes: resistencia progresiva, nunca tope duro.
 * - Reduced motion: fundido corto en vez de desplazamiento/escala/spring.
 *
 * Todo lo que no toca `window` es puro y esta cubierto por motion.test.ts.
 */

/* ------------------------------------------------------------------ *
 * Springs
 * ------------------------------------------------------------------ */

/** Parametros de spring tal como los piensa Apple (no masa/rigidez). */
export interface AppleSpringParams {
  /**
   * Segundos que tarda en acercarse al objetivo. NO es una duracion fija:
   * el tiempo de asentamiento emerge de los parametros. 0.3-0.4 es lo
   * habitual en UI.
   */
  response: number;
  /**
   * 1 = criticamente amortiguado (sin rebote). <1 sobrepasa y oscila;
   * cuanto mas bajo, mas rebote. Apple usa 0.8 en gestos con inercia.
   */
  dampingRatio: number;
}

/** Spring fisico que entiende `motion` (`type: "spring"`). */
export interface PhysicalSpring {
  type: "spring";
  stiffness: number;
  damping: number;
  mass: number;
}

/**
 * Convierte (response, dampingRatio) de Apple a (stiffness, damping) con
 * masa 1, que es lo que consume `motion`:
 *
 *   stiffness = (2π / response)²
 *   damping   = 4π · dampingRatio / response
 *
 * Es la formula de UIKit: con dampingRatio 1 se cumple
 * damping² = 4 · stiffness · mass (critico).
 */
export function appleSpring({ response, dampingRatio }: AppleSpringParams): PhysicalSpring {
  if (!(response > 0)) {
    throw new RangeError(`appleSpring: response debe ser > 0 (recibido ${response})`);
  }
  if (!(dampingRatio >= 0)) {
    throw new RangeError(`appleSpring: dampingRatio debe ser >= 0 (recibido ${dampingRatio})`);
  }
  const stiffness = (2 * Math.PI / response) ** 2;
  const damping = (4 * Math.PI * dampingRatio) / response;
  return { type: "spring", stiffness, damping, mass: 1 };
}

/**
 * Presets. Todos sin rebote salvo `momentum`, que SOLO debe usarse cuando
 * el gesto trajo velocidad (un menu que aparece no rebota; una tarjeta
 * que lanzaste si).
 */
export const springs = {
  /** UI general: paneles, listas, reordenar. Apple "move": 1.0 / 0.4. */
  default: appleSpring({ response: 0.4, dampingRatio: 1 }),
  /** Respuesta inmediata (toggles, chips, botones). */
  snappy: appleSpring({ response: 0.25, dampingRatio: 1 }),
  /** Transiciones grandes de pantalla o sheets que entran sin gesto. */
  gentle: appleSpring({ response: 0.5, dampingRatio: 1 }),
  /** Sheets/drawers que se arrastran. Apple "drawer": 0.8 / 0.3. */
  sheet: appleSpring({ response: 0.3, dampingRatio: 0.8 }),
  /** Soltar un flick o un arrastre con inercia. Apple: 0.8 / 0.4. */
  momentum: appleSpring({ response: 0.4, dampingRatio: 0.8 }),
} as const satisfies Record<string, PhysicalSpring>;

export type SpringPreset = keyof typeof springs;

/**
 * Spring con la velocidad del gesto incorporada, para que la animacion
 * continue exactamente a la velocidad del dedo al soltar (sin costura
 * entre arrastre y animacion). `velocity` en px/s, con signo.
 */
export function withVelocity(spring: PhysicalSpring, velocity: number): Transition {
  return { ...spring, velocity: Number.isFinite(velocity) ? velocity : 0 };
}

/* ------------------------------------------------------------------ *
 * Gestos
 * ------------------------------------------------------------------ */

/**
 * Proyeccion de momentum de Apple (decaimiento exponencial, no v²/2a):
 * cuantos px recorreria un objeto soltado a `velocity` px/s antes de
 * detenerse con una tasa de desaceleracion `rate` por milisegundo.
 *
 *   project(v, d) = (v / 1000) · d / (1 − d)
 *
 * 0.998 = scroll normal de UIScrollView; 0.99 = "fast", mas corto.
 * Devuelve 0 para velocidad 0 y conserva el signo de la velocidad.
 */
export function project(velocity: number, rate = 0.998): number {
  if (!Number.isFinite(velocity) || velocity === 0) return 0;
  if (!(rate > 0 && rate < 1)) {
    throw new RangeError(`project: rate debe estar en (0, 1) (recibido ${rate})`);
  }
  return ((velocity / 1000) * rate) / (1 - rate);
}

/**
 * Resistencia progresiva al pasar un borde: cuanto mas lejos se arrastra,
 * menos sigue el elemento. Formula de UIScrollView:
 *
 *   (overshoot · dimension · c) / (dimension + c · |overshoot|)
 *
 * El resultado tiende asintoticamente a `dimension` (nunca lo supera),
 * es 0 para overshoot 0 y es impar (mismo valor con signo cambiado para
 * overshoot negativo). `constant` 0.55 es el valor de iOS.
 *
 * Bordes: overshoot ±Infinity devuelve el limite ±dimension; NaN devuelve
 * 0 (no hay exceso conocido, no se desplaza nada). `dimension` debe ser
 * finita y > 0 (con Infinity la formula daria NaN): lanza RangeError.
 */
export function rubberband(overshoot: number, dimension: number, constant = 0.55): number {
  if (!(Number.isFinite(dimension) && dimension > 0)) {
    throw new RangeError(`rubberband: dimension debe ser finita y > 0 (recibido ${dimension})`);
  }
  if (!(constant > 0)) {
    throw new RangeError(`rubberband: constant debe ser > 0 (recibido ${constant})`);
  }
  if (Number.isNaN(overshoot) || overshoot === 0) return 0;
  if (!Number.isFinite(overshoot)) return Math.sign(overshoot) * dimension;
  return (overshoot * dimension * constant) / (dimension + constant * Math.abs(overshoot));
}

/**
 * Punto de snap mas cercano a `value`. Util combinado con `project`:
 *   nearestSnapPoint(current + project(velocity), points)
 * Con empate gana el primero de la lista; sin puntos devuelve `value`.
 */
export function nearestSnapPoint(value: number, points: readonly number[]): number {
  let best = value;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const point of points) {
    const distance = Math.abs(point - value);
    if (distance < bestDistance) {
      best = point;
      bestDistance = distance;
    }
  }
  return best;
}

/**
 * Velocidad relativa para APIs de spring que la esperan normalizada por
 * la distancia restante (UIKit `initialSpringVelocity`). `motion` acepta
 * px/s absolutos, asi que normalmente no hace falta; se expone por si
 * algun componente usa una API normalizada. Si no queda distancia, 0.
 */
export function relativeVelocity(gestureVelocity: number, current: number, target: number): number {
  const distance = target - current;
  if (distance === 0 || !Number.isFinite(gestureVelocity)) return 0;
  return gestureVelocity / distance;
}

/**
 * Decide si un gesto de descartar se completa o se revierte. Apple usa el
 * SIGNO de la velocidad al soltar, no la posicion, salvo que el dedo este
 * casi quieto (|v| < `stillThreshold` px/s): entonces manda la posicion
 * frente a `commitFraction` del recorrido.
 */
export function shouldCommitGesture(options: {
  velocity: number;
  offset: number;
  distance: number;
  stillThreshold?: number;
  commitFraction?: number;
}): boolean {
  const { velocity, offset, distance, stillThreshold = 50, commitFraction = 0.5 } = options;
  if (!(distance > 0)) return false;
  if (Math.abs(velocity) >= stillThreshold) return velocity > 0;
  return offset / distance >= commitFraction;
}

/* ------------------------------------------------------------------ *
 * Gestos: velocidad y decision de suelta (W1-B, Sheet arrastrable)
 * ------------------------------------------------------------------ */

export interface VelocitySample {
  value: number;
  /** Marca de tiempo en ms (event.timeStamp o performance.now()). */
  time: number;
}

/**
 * Velocidad (unidades/s) a partir de un historial corto de muestras: la
 * pendiente entre la muestra mas antigua dentro de la ventana y la mas
 * reciente. Usar solo las dos ultimas muestras (lo que hace
 * MotionValue.getVelocity) es ruidoso con punteros tactiles; una ventana
 * de ~100 ms da la velocidad "intencional" del dedo.
 *
 * Si el dedo lleva quieto mas de `windowMs` antes de soltar (`now`
 * mas alla de la ultima muestra), la velocidad es 0: no se lanza algo que
 * se dejo de mover.
 */
export function velocityFromSamples(
  samples: readonly VelocitySample[],
  windowMs = 100,
  now?: number,
): number {
  if (samples.length < 2) return 0;
  const last = samples[samples.length - 1];
  if (now !== undefined && now - last.time > windowMs) return 0;
  let first = samples[0];
  for (const sample of samples) {
    if (last.time - sample.time <= windowMs) {
      first = sample;
      break;
    }
  }
  const dt = last.time - first.time;
  if (dt <= 0) return 0;
  const velocity = ((last.value - first.value) / dt) * 1000;
  return Number.isFinite(velocity) ? velocity : 0;
}

/**
 * Historial de posiciones con ventana deslizante para calcular la
 * velocidad al soltar. `push` descarta lo que queda fuera de la ventana.
 */
export function createVelocityTracker(windowMs = 100) {
  const samples: VelocitySample[] = [];
  return {
    push(value: number, time: number): void {
      samples.push({ value, time });
      while (samples.length > 1 && time - samples[0].time > windowMs) {
        samples.shift();
      }
    },
    velocity(now?: number): number {
      return velocityFromSamples(samples, windowMs, now);
    },
    reset(): void {
      samples.length = 0;
    },
    get size(): number {
      return samples.length;
    },
  };
}

export type VelocityTracker = ReturnType<typeof createVelocityTracker>;

export interface SheetReleaseOptions {
  /** Desplazamiento actual del sheet (px; >0 = hacia abajo, hacia cerrar). */
  offset: number;
  /** Velocidad al soltar (px/s, con signo). */
  velocity: number;
  /** Recorrido total hasta salir de pantalla (px, > 0). */
  distance: number;
  /** Con movimiento reducido el snap es instantaneo (decision aprobada). */
  reduced?: boolean;
  /** Por debajo de esto el dedo se considera quieto y manda la posicion. */
  stillThreshold?: number;
}

export interface SheetReleaseDecision {
  /** `dismiss` = cerrar; `settle` = volver a la posicion abierta. */
  action: "dismiss" | "settle";
  /** Destino del desplazamiento: `distance` o 0. */
  target: number;
  /** Transicion con la velocidad heredada (o instantanea con reduced). */
  transition: Transition;
  /** Donde habria acabado el sheet por inercia (para depurar/tests). */
  projected: number;
}

/**
 * Decision al soltar un sheet arrastrable, al estilo Apple:
 *   1. se proyecta el momentum (`project`) para saber a donde IBA;
 *   2. manda el SIGNO de la velocidad si el dedo se movia; si estaba
 *      quieto, manda la posicion proyectada frente a la mitad del
 *      recorrido (`shouldCommitGesture`);
 *   3. la animacion de vuelta o de cierre hereda la velocidad. Rebota
 *      (`springs.sheet`, damping 0.8) solo si el gesto traia inercia; si
 *      no, `springs.default` (sin rebote).
 */
export function resolveSheetRelease(options: SheetReleaseOptions): SheetReleaseDecision {
  const { offset, velocity, distance, reduced = false, stillThreshold = 50 } = options;
  const safeVelocity = Number.isFinite(velocity) ? velocity : 0;
  const projected = offset + project(safeVelocity);
  const dismiss = shouldCommitGesture({
    velocity: safeVelocity,
    offset: projected,
    distance,
    stillThreshold,
  });
  const hasMomentum = Math.abs(safeVelocity) >= stillThreshold;
  const spring = hasMomentum ? springs.sheet : springs.default;
  return {
    action: dismiss ? "dismiss" : "settle",
    target: dismiss ? distance : 0,
    transition: reducedValueTransition(withVelocity(spring, safeVelocity), reduced, true),
    projected,
  };
}

/* ------------------------------------------------------------------ *
 * Reduced motion
 *
 * Modelo: con movimiento reducido solo cambia COMO se llega al estado
 * final, nunca el estado final. Eso lo hace el motor de `motion` clave
 * por clave a traves de <MotionConfig reducedMotion="user"> (montado en
 * src/components/layout/Providers.tsx): transform/layout/posicion pasan
 * a instantaneo (`type: false`), opacity/color se siguen animando,
 * `initial={false}` y los targets se conservan. Cubre <motion.*>,
 * whileTap/whileHover y layout.
 *
 * Lo que MotionConfig no cubre, y para lo que existen los helpers de
 * abajo:
 *   - `animate(elementoDOM, …)` fuera del arbol React → reducedAnimateOptions
 *   - `animate(motionValue, destino, …)`              → reducedValueTransition
 *   - la inercia de `drag`: el componente pone `dragMomentum={!reduced}`
 *     con el hook useReducedMotionPref; el destino del snap se calcula
 *     igual (project + nearestSnapPoint) y solo cambia la transicion.
 * ------------------------------------------------------------------ */

export const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

/**
 * Lectura imperativa de la preferencia (para `animate()` fuera de React).
 * En SSR o sin matchMedia devuelve false. Los componentes usan el hook
 * `useReducedMotionPref` para reaccionar a cambios.
 */
export function prefersReducedMotion(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  return window.matchMedia(REDUCED_MOTION_QUERY).matches;
}

/** Fundido corto: la transicion de opacity bajo reduced motion. */
export const crossFadeTransition: Transition = { duration: 0.16, ease: "easeOut" };

/** Variantes de entrada/salida por fundido puro. */
export const crossFadeVariants = {
  initial: { opacity: 0 },
  animate: { opacity: 1 },
  exit: { opacity: 0 },
} as const;

/**
 * Opciones para `animate(elementoDOM, target, opciones)` fuera del arbol
 * React (donde MotionConfig no llega): añade `reduceMotion`, que el motor
 * aplica clave por clave igual que MotionConfig. No muta la entrada.
 */
export function reducedAnimateOptions<T extends object>(
  options: T,
  reduced: boolean,
): T & { reduceMotion: boolean } {
  return { ...options, reduceMotion: reduced };
}

/**
 * Transicion para `animate(motionValue, destino, transicion)`: un
 * MotionValue no sabe que propiedad representa, asi que el llamante
 * indica si es posicional (x/y/scale/width…). Con reduced + posicional
 * el valor salta al destino (`type: false`); en cualquier otro caso se
 * respeta la transicion pedida (un MotionValue de opacity sigue
 * fundiendose).
 */
export function reducedValueTransition(
  transition: Transition,
  reduced: boolean,
  positional: boolean,
): Transition {
  return reduced && positional ? { type: false } : transition;
}

/**
 * Un spring con rebote (damping 0.8) aplicado a opacity sobrepasa el
 * valor final (opacity > 1 o < 0 se recorta y parpadea). La opacidad
 * siempre va con fundido: este helper asigna `crossFadeTransition` a la
 * clave `opacity` y deja el spring para el resto.
 */
export function withCrossFadeOpacity(spring: Transition): Transition {
  return { ...spring, opacity: crossFadeTransition };
}
