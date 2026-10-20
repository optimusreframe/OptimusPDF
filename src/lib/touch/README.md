# `src/lib/touch` · piezas tactiles compartidas (unidad M3)

Utilidades para Firmar y PDF Pro: zoom y desplazamiento de la hoja, auto-desplazamiento al arrastrar, region visible
descontando barras fijas y niveles de ancho. Sin dependencias de producto: solo geometria y DOM.

| Modulo | Para que |
|---|---|
| `panZoom.ts` | Aritmetica pura: `clampPan` (recorrido de TODA la hoja), `panForPinch` (zoom con foco en el centro de los dedos), `panWithOverflow` (la hoja se mueve y el resto va a la pagina), `panToCenterPoint`. |
| `edgeAutoScroll.ts` | `createEdgeAutoScroller` + `edgeVelocity`: auto-desplazamiento por TIEMPO (px/s, rampa 0 -> 640 px/s en 56 px) independiente de la frecuencia de refresco (60 / 120 Hz). Lo usa el lienzo; el reordenar de PDF Pro puede usarlo en vez de sumar px por fotograma. |
| `scrollRegion.ts` | `findScrollParent`, `measureObstructions` / `freeRegion` (lo que la persona ve de verdad: caja del scroller menos cabecera, barra de zoom, paleta y barras de accion fijas), `revealDelta`, `scrollVerticallyBy`. |
| `viewportTier.ts` | Contrato de anchos: `phone` < 768, `tablet` 768-1023, `desktop` >= 1024; `useViewportTier()` ademas da `coarse` y `compact` (dedo y < 1280 px). |
| `strings.ts` | Textos ES/EN propios de estas piezas (`useTouchStrings`). |

## Contrato del lienzo (`DocumentCanvas`)

Aditivo: `DocumentCanvasProps` existente no cambia.

```tsx
const canvas = useRef<DocumentCanvasApi>(null);

<DocumentCanvas apiRef={canvas} gestureMode="auto" ... />

// «Ver este hueco»: pagina y, con zoom, hoja, a la zona LIBRE (entre barra de zoom y barras fijas de abajo)
canvas.current?.scrollIntoViewRect(field.rect, { pageIndex: field.pageIndex, highlightId: field.id, behavior: "smooth" });
canvas.current?.getFreeRegion();   // { top, bottom, left, right } en px de pantalla
canvas.current?.getGestureMode();  // "auto" | "scroll" | "draw"

// Sin ref a mano (y para los E2E): el mismo efecto por un evento de window
window.dispatchEvent(new CustomEvent(CANVAS_REVEAL_EVENT, { detail: { rect, options } }));
```

`gestureMode` (que hace UN dedo con una herramienta de creacion armada):

- `auto` (defecto): toque = colocar, deslizar = desplazar la pagina, mantener ~260 ms y arrastrar = dibujar.
  Con puntero grueso aparece el interruptor visible «Dibujar con el dedo».
- `scroll`: igual, sin interruptor.
- `draw`: arrastrar dibuja de inmediato (el dedo ya no desplaza con la herramienta armada).

Sin herramienta (Seleccionar) un dedo siempre desplaza la pagina (`touch-action: pan-x pan-y`); con zoom > 1 mueve la
hoja y, al llegar a su borde, sigue con la pagina. Raton: dibuja de inmediato. Lapiz: como el dedo.

CSS: `--canvas-palette-bottom` (por defecto `calc(9.25rem + env(safe-area-inset-bottom))`) coloca la paleta fija de
movil; PDF Pro puede fijarla segun su propia barra inferior.

## Zonas de seguridad (`globals.css`)

`main#content` ya lleva `padding-inline: env(safe-area-inset-left/right)`: todo lo que se pinta dentro (Firmar, Pro) las
respeta. Para barras propias: utilidades `pad-safe-x`, `pl-safe`, `pr-safe`, `pb-safe`, `safe-inset-x`, o
`ps-[max(1rem,env(safe-area-inset-left,0px))]`. Las barras `fixed inset-x-0` se recolocan solas.
