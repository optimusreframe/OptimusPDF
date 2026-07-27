# OptimusPDF — Blueprint

> Generado por The Architect (Fable 5, orquestador OX) — 2026-07-27
> Archetype: SaaS / Web App (herramientas PDF client-side)

---

## 1. Project Overview

### Vision
OptimusPDF es una suite completa de herramientas PDF en el navegador — el conjunto de capacidades de iLovePDF (merge, split, compress, convertir, editar, seguridad) reconstruido desde cero con la identidad visual de Optimus Reframe y una experiencia de usuario estilo Apple iOS 26. Todo el procesamiento ocurre client-side (privacidad por diseño: los archivos nunca salen del dispositivo), lo que además elimina costes de servidor.

### Goals
- Paridad funcional con las herramientas de iLovePDF viables client-side (~20 herramientas operativas).
- Branding 100% Optimus Reframe: dark HUD, azul eléctrico, tipografía Inter + JetBrains Mono.
- Desktop/iPad: layout web pro con grid de herramientas. Móvil: experiencia de app nativa iOS 26 (tab bar, large titles, sheets, liquid glass).
- Repo público en `optimusreframe/OptimusPDF`, build limpio, deployable en Vercel.

### Success Metrics
- `npm run build` sin errores; typecheck limpio.
- Flujo completo verificado en browser: subir → configurar → procesar → descargar, en desktop y móvil.
- Todas las rutas de herramientas navegables (las no viables client-side muestran estado "Próximamente" honesto).

---

## 2. Tech Stack

| Layer | Technology | Why |
|-------|-----------|-----|
| Framework | Next.js 15 (App Router, Turbopack) | SSG para páginas de herramientas, routing por archivo, deploy trivial en Vercel |
| Language | TypeScript (strict) | Seguridad de tipos en el motor PDF |
| Styling | Tailwind CSS v4 | Tokens custom via CSS variables, coincide con el stack de Optimus Reframe |
| PDF core | `pdf-lib` (fork `@cantoo/pdf-lib`) | Manipulación de PDFs client-side; el fork añade encrypt/decrypt para Protect/Unlock |
| PDF render | `pdfjs-dist` | Miniaturas de páginas, PDF→imagen, extracción de texto (compare) |
| Imagen→PDF | `pdf-lib` nativo | JPG/PNG embed directo |
| ZIP salida | `jszip` | Descarga múltiple (split, pdf→jpg) |
| OCR | `tesseract.js` (lazy-loaded) | OCR client-side viable, se carga solo al usarla |
| Iconos | `lucide-react` | Consistente, tree-shakeable |
| Estado | React hooks + context (sin librería) | El estado es por-herramienta y efímero; no se necesita store global |
| Hosting | Vercel (recomendado, no incluido en este run) | Estático + edge, cero config |
| Package Manager | npm | Ya presente en el entorno |

Sin base de datos, sin auth, sin backend: v1 es 100% client-side. Pricing/login se representan como páginas estáticas informativas.

---

## 3. Directory Structure

```
OptimusPDF/
  docs/                          # blueprint, reportes OX, evidencia
  src/
    app/
      layout.tsx                 # shell global: header desktop / tab bar móvil
      page.tsx                   # home: hero + grid de herramientas por categoría
      globals.css                # tokens Optimus + utilidades iOS glass
      tools/
        [slug]/page.tsx          # NO — cada herramienta es ruta estática propia:
      merge-pdf/page.tsx
      split-pdf/page.tsx
      compress-pdf/page.tsx
      ... (una carpeta por herramienta, ver §6)
      pricing/page.tsx
      about/page.tsx
    components/
      layout/                    # Header, Footer, MobileTabBar, LanguageToggle
      tool/                      # ToolShell, FileDropzone, PageThumbnailGrid,
                                 # OptionsPanel, ProcessingOverlay, DownloadScreen
      ui/                        # GlassCard, Button, Slider, SegmentedControl,
                                 # Sheet (móvil), Badge, ProgressBar
    lib/
      pdf/                       # motor: merge.ts, split.ts, rotate.ts, watermark.ts,
                                 # pageNumbers.ts, compress.ts, imagesToPdf.ts,
                                 # pdfToImages.ts, protect.ts, crop.ts, compare.ts...
      tools-registry.ts          # catálogo único: slug, nombre, icono, categoría,
                                 # descripción, estado (live/soon), color
      i18n.ts + locales/es.ts, en.ts
    hooks/                       # useFileUpload, usePdfDocument, useIsMobile
```

---

## 4. Data Model

Sin base de datos. El único "modelo" es el registro de herramientas:

```ts
type ToolCategory = "organize" | "optimize" | "convert-to" | "convert-from" | "edit" | "security";
type Tool = {
  slug: string; icon: LucideIcon; category: ToolCategory;
  status: "live" | "soon";           // soon = requiere servidor (Office, IA)
  accept: string[];                   // tipos MIME de entrada
  multiple: boolean;                  // acepta varios archivos
};
```

Los textos (nombre, descripción) viven en los diccionarios i18n (ES default, EN toggle — como optimusreframe.com).

---

## 5. API Design

No hay API en v1. Todo el procesamiento es client-side en Web Workers cuando el archivo supera ~20MB (OCR y render de pdfjs siempre en worker). Las herramientas `status: "soon"` (Word/Excel/PPT↔PDF, IA) quedan con página + captura de interés, listas para conectar un backend futuro (iLoveAPI-style) sin cambiar la UI.

---

## 6. Frontend Architecture

### Rutas / Herramientas

| Ruta | Herramienta | Estado v1 | Motor |
|------|-------------|-----------|-------|
| `/merge-pdf` | Unir PDF | live | pdf-lib copy pages |
| `/split-pdf` | Dividir PDF (rangos, cada N, extraer) | live | pdf-lib |
| `/remove-pages` | Eliminar páginas | live | pdf-lib |
| `/extract-pages` | Extraer páginas | live | pdf-lib |
| `/organize-pdf` | Organizar (drag reorder + rotar + borrar) | live | pdf-lib + thumbnails pdfjs |
| `/rotate-pdf` | Rotar PDF | live | pdf-lib |
| `/compress-pdf` | Comprimir (re-encode imágenes vía canvas + object streams) | live (básico honesto) | pdfjs render + pdf-lib |
| `/repair-pdf` | Reparar | soon (server) | — |
| `/ocr-pdf` | OCR | live (lazy tesseract.js) | tesseract.js + pdf-lib overlay texto |
| `/jpg-to-pdf` | JPG/PNG a PDF (orientación, margen, tamaño página) | live | pdf-lib |
| `/word-to-pdf`, `/powerpoint-to-pdf`, `/excel-to-pdf` | Office a PDF | soon (server) | — |
| `/html-to-pdf` | HTML a PDF | soon (server para fidelidad) | — |
| `/pdf-to-jpg` | PDF a JPG (por página, zip) | live | pdfjs canvas + jszip |
| `/pdf-to-word`, `/pdf-to-powerpoint`, `/pdf-to-excel` | PDF a Office | soon (server) | — |
| `/pdf-to-pdfa` | PDF/A | soon (server) | — |
| `/add-page-numbers` | Números de página (posición, formato, fuente) | live | pdf-lib drawText |
| `/add-watermark` | Marca de agua texto/imagen (opacidad, rotación, mosaico) | live | pdf-lib |
| `/crop-pdf` | Recortar (selección visual sobre preview) | live | pdf-lib CropBox |
| `/edit-pdf` | Editor (texto, formas, resaltado básico) | live (anotación básica) | pdfjs preview + pdf-lib draw |
| `/sign-pdf` | Firmar (dibujar/escribir/subir firma, colocar) | live (firma simple, sin multi-firmante) | canvas + pdf-lib |
| `/protect-pdf` | Proteger con contraseña | live | @cantoo/pdf-lib encrypt (AES) |
| `/unlock-pdf` | Quitar contraseña (con la contraseña conocida) | live | @cantoo/pdf-lib decrypt |
| `/redact-pdf` | Censurar (cajas negras + flatten a imagen de página) | live (flatten honesto) | pdfjs render + pdf-lib |
| `/compare-pdf` | Comparar (diff de texto lado a lado) | live | pdfjs getTextContent + diff |
| `/scan-to-pdf` | Escanear con cámara (getUserMedia móvil) | live (cámara local, sin QR remoto) | canvas + pdf-lib |
| `/pdf-summarizer`, `/translate-pdf`, `/pdf-to-markdown` | IA | soon (server + LLM) | — |

**20 herramientas live, 10 "soon"** con página propia y estado honesto.

### Component Hierarchy (página de herramienta típica)

```
ToolPage (server component, metadata SEO)
└─ ToolShell (client)                    ← máquina de estados: idle → files → options → processing → done
   ├─ FileDropzone (drag&drop, picker, multi)
   ├─ PageThumbnailGrid (pdfjs, reorder/rotate/select según herramienta)
   ├─ OptionsPanel (desktop: sidebar derecha | móvil: Sheet inferior iOS)
   ├─ ProcessingOverlay (progreso, mensaje "Uniendo PDFs…")
   └─ DownloadScreen (descarga + herramientas relacionadas)
```

### Responsive / iOS
- Desktop/iPad (≥768px): header sticky con nav por categorías, grid de tarjetas glass, sidebar de opciones.
- Móvil (<768px): **tab bar inferior estilo iOS 26** (Inicio, Herramientas, Recientes*, Ajustes) con blur liquid-glass y safe-area-inset; large title colapsable; opciones en bottom sheets con grabber; transiciones spring; `viewport-fit=cover`, `apple-mobile-web-app-capable`, manifest PWA + iconos → instalable como app.
- *Recientes: solo nombres/metadata en localStorage, nunca archivos.

---

## 7. Design System — "Optimus HUD × iOS Liquid Glass"

### Colors (extraídos del CSS real de optimusreframe.com)

| Role | Valor | Usage |
|------|-----|-------|
| Background | `oklch(4% 0 0)` (#000) | fondo base |
| Card/Surface | `oklch(8% 0 0)` + borde blanco 10% | tarjetas glass |
| Elevated | `oklch(16% 0 0)` | sheets, popovers |
| Text | `#ffffff` | principal |
| Text muted | `oklch(68% 0 0)` (#989898) | secundario |
| **Signal (primario)** | `oklch(52% .27 264)` (#0d4bff) | CTAs, focus, progreso, iconos activos |
| Signal glow | `oklch(60% .25 264)` (#2d6dff) | `box-shadow: 0 0 32px -6px …/.7` en CTAs |
| Destructive | `oklch(62% .22 25)` (#ee343b) | borrar páginas, errores |
| Success | `oklch(70% .17 160)` | confirmaciones de proceso |
| Border | `white/10` (inputs `white/14`) | líneas técnicas |
| Grid lines | `white/5` | retícula de fondo del hero |

Cada categoría de herramienta recibe un tinte de acento propio (organize=signal azul, optimize=verde, convert=violeta, edit=ámbar, security=rojo) usado SOLO en el icono/badge — el resto permanece monocromo Optimus.

### Typography
| Role | Font | Size | Weight |
|------|------|------|--------|
| Display/H1 | Inter | clamp(2.5–4rem), tracking -0.025em | 900 |
| Headings | Inter | escala 1.25 | 700–800 |
| Body | Inter | 15–16px | 400–500 |
| Labels/badges/botones | JetBrains Mono, UPPERCASE, tracking +0.05em | 10–12px | 600–700 |

### Spacing & Layout
- Escala 4px. Max content 1200px. Breakpoints Tailwind default.
- **Radius (la fusión iOS)**: tarjetas y botones usan `border-radius: 20px` con `corner-shape: squircle` fallback estándar (iOS continuous corners); badges/pills full; los bloques "técnicos" (tablas de specs, footer) mantienen los bordes rectos de Optimus.
- Glass: `backdrop-filter: blur(24px) saturate(1.4)` + fondo `white/[0.06]` + borde `white/10` + sombra interior sutil — iOS 26 liquid glass sobre fondo negro Optimus.

### Component Style
Oscuro, spacioso, animaciones spring cortas (150–300ms, `cubic-bezier(0.32,0.72,0,1)`), glow azul en el CTA primario, badges mono uppercase tipo HUD ("LIVE", "LOCAL", "0 UPLOADS"), estados hover con elevación de borde. Botón primario: fondo signal, texto blanco, mono uppercase, glow.

---

## 8. Authentication & Authorization
No hay auth en v1 (procesamiento local, sin cuentas). `/pricing` es informativa (Free = todo local ilimitado; Pro = futuras funciones server/IA). Sin sesiones, sin cookies de tracking.

---

## 9. Build Order

**Step 1 — Scaffolding** ✅: create-next-app (TS, Tailwind v4, App Router), git init, repo GitHub `optimusreframe/OptimusPDF`, push inicial.

**Step 2 — Design system y layout global** (Opus 5, WS-CORE):
`globals.css` con tokens Optimus + utilidades glass; fuentes Inter/JetBrains Mono via `next/font`; `ui/` primitives (Button, GlassCard, Badge, Slider, SegmentedControl, Sheet, ProgressBar); Header desktop, Footer, MobileTabBar iOS, LanguageToggle; i18n ES/EN mínimo; manifest PWA + metadata iOS.

**Step 3 — Framework de herramientas** (mismo WS-CORE):
`tools-registry.ts` (las 30 herramientas); `ToolShell` con máquina de estados; `FileDropzone`; `PageThumbnailGrid` (pdfjs worker); `ProcessingOverlay`; `DownloadScreen`; hooks; página genérica "soon".

**Step 4 — Home + pricing** (WS-CORE): hero Optimus (retícula, badges HUD, tagline), grid por categorías, sección privacidad ("tus archivos nunca salen de tu dispositivo"), footer completo, `/pricing`, `/about`.

**Step 5 — Herramientas grupo A: Organizar** (Opus 5, WS-A): merge, split, remove-pages, extract-pages, organize, rotate + sus motores en `lib/pdf/`.

**Step 6 — Herramientas grupo B: Convertir** (Opus 5, WS-B): jpg-to-pdf, pdf-to-jpg, scan-to-pdf + páginas "soon" de Office/HTML/PDF-A.

**Step 7 — Herramientas grupo C: Editar** (Opus 5, WS-C): watermark, page-numbers, crop, sign, edit (anotación básica), compare.

**Step 8 — Herramientas grupo D: Seguridad/Optimizar** (Opus 5, WS-D): compress, protect, unlock, redact, ocr + páginas "soon" IA/repair.

**Step 9 — Validación** (Sonnet 5, ox-validator): tsc --noEmit, eslint, build, smoke browser desktop + móvil (375px) de cada herramienta live con PDF de prueba.

**Step 10 — Verificación fresh-context** (Sonnet 5, ox-verifier): flujo E2E real de 4-5 herramientas representativas + revisión de criterios de aceptación.

**Step 11 — Fixes + commit/push + reporte OX final.**

WS-A…WS-D son workstreams independientes (archivos disjuntos: cada uno toca solo sus `app/<tool>/` y `lib/pdf/<tool>.ts`) → se despachan en paralelo (cap 3) tras cerrar WS-CORE.

**Delegation Map**: orquestador = Fable 5 (plan, decisiones, síntesis). Builders = Opus 5. Validator/Verifier = Sonnet 5. Exploradores ya ejecutados en Sonnet 5.

---

## 10. Environment Setup
- Node 24, npm 11. Sin variables de entorno en v1.
- `npm install` → `npm run dev` (Turbopack) → `npm run build`.

## 11. Dependencies
Core: `next`, `react`, `@cantoo/pdf-lib`, `pdfjs-dist`, `jszip`, `tesseract.js` (lazy), `lucide-react`.
Dev: `typescript`, `tailwindcss@4`, `eslint`.

## 12. Deployment Strategy
Vercel recomendado (no autorizado publicar en este run — se deja listo). Push a `main` en `optimusreframe/OptimusPDF`.

## 13. Testing Strategy
v1: typecheck + build como gate estático; smoke E2E manual vía browser pane con PDFs generados de prueba. (Vitest/Playwright: recomendación diferida.)

## 14. Reglas No Negociables
1. TypeScript strict; sin `any` salvo interop pdfjs documentado.
2. Ningún archivo del usuario sale del navegador; ninguna llamada de red con contenido de archivos.
3. Todo texto visible pasa por i18n (ES default, EN); nada hardcodeado.
4. Tokens de color SOLO desde CSS variables — nunca hex inline.
5. Cada herramienta live debe manejar: archivo inválido, PDF cifrado, cancelación, y archivos >100MB (aviso).
6. Mobile-first: cada página usable a 375px con tab bar; desktop ≥768px con header.
7. Un componente por archivo; motores PDF puros (sin React) en `lib/pdf/`.
8. Las herramientas "soon" nunca fingen funcionar — estado honesto.
