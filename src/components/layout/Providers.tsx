"use client";

import type { ReactNode } from "react";
import { MotionConfig } from "motion/react";
import { LanguageProvider } from "@/lib/i18n";
import { ThemeProvider } from "@/lib/theme";

/*
 * MotionConfig reducedMotion="user": cuando el sistema pide reducir
 * movimiento, el motor de `motion` resuelve clave por clave (transform,
 * layout y posicion pasan a instantaneo con `type: false`; opacity y
 * color se siguen animando) sin alterar el estado final ni `initial`.
 * Cubre <motion.*>, whileTap/whileHover y layout. No cubre la inercia
 * de `drag` ni `animate()` sobre elementos DOM planos o MotionValues:
 * ver src/lib/motion.ts (reducedAnimateOptions, reducedValueTransition).
 */
export function Providers({ children }: { children: ReactNode }) {
  return (
    <MotionConfig reducedMotion="user">
      <ThemeProvider>
        <LanguageProvider>{children}</LanguageProvider>
      </ThemeProvider>
    </MotionConfig>
  );
}
