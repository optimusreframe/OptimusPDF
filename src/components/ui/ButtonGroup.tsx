import { forwardRef, type HTMLAttributes } from "react";
import { cn } from "@/lib/cn";

/*
 * Grupo de botones contiguos (zoom, anterior/siguiente, deshacer/rehacer, subir/bajar...) con la separacion que exige
 * el dedo (VI-07 · M3): 4 px con raton y 8 px con puntero grueso (`touch-spacing` de ui-ux-pro-max: >= 8 px entre
 * objetivos de 44 px, para que un dedo no acierte al vecino). Antes cada barra ponia su propio `gap-0.5` / `gap-1` / nada.
 *
 * Es un contenedor `div` sin rol: quien lo usa le da `role="group"` + `aria-label` (o `role="toolbar"`) cuando el grupo
 * tiene nombre. `wrap` deja que los botones pasen a otra linea en pantallas estrechas.
 */
export type ButtonGroupProps = HTMLAttributes<HTMLDivElement> & {
  wrap?: boolean;
};

export const ButtonGroup = forwardRef<HTMLDivElement, ButtonGroupProps>(function ButtonGroup(
  { wrap, className, ...props },
  ref,
) {
  return (
    <div
      ref={ref}
      className={cn("flex items-center gap-1 pointer-coarse:gap-2", wrap && "flex-wrap", className)}
      {...props}
    />
  );
});
