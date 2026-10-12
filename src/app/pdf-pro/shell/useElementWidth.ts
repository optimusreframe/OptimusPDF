"use client";

import { useLayoutEffect, useState, type RefObject } from "react";

/** Ancho (px) del elemento, vigilado con `ResizeObserver`. 0 mientras no se ha medido (o sin `ResizeObserver`). */
export function useElementWidth(ref: RefObject<HTMLElement | null>): number {
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const measure = () => setWidth((previous) => (previous === element.clientWidth ? previous : element.clientWidth));
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);
  return width;
}
