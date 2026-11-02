# Plan · OptimusTOOLS (2026-11-02)

Decision del usuario (2026-11-02), opcion **C**: todo sigue siendo 100 % local, **salvo** una excepcion declarada y visible: «HTML a PDF» puede
consultar una direccion web desde nuestro servidor (el navegador no puede leer otras webs por CORS). El **Downloader de redes sociales NO se
construye** (necesita servidor y raspado de plataformas, rompe la promesa local y tiene riesgo legal): queda como entrada «Próximamente»
con una pagina honesta. Nada de CDN en tiempo de ejecucion: todo lo que corre en el navegador va empaquetado.

## Barra lateral objetivo (desktop; en movil el mismo orden en el menu)

```
[Buscar herramienta]
Inicio · Recientes · PDF PRO
CATEGORIAS
  OptimusPDF      Organizar · Optimizar · Convertir a PDF · Convertir desde PDF · Editar y analizar · Seguridad
  OptimusSCAN     Escanear a PDF   (scan-to-pdf: sale de «Convertir a PDF» y vive aqui)
  OptimusTOOLS
    Downloader (proximamente)   Instagram · Facebook · TikTok · X · Threads · Telegram   (entradas deshabilitadas con «Pronto»)
    Audio Studio                Extraer audio (audio-extractor) · Audio Studio (audio-studio)
    Converter                   Audio Converter · Image Converter · Video Converter
    Proximamente…
Exportar / Importar   Documentos (/documents)
Ajustes · Precios · Sobre nosotros
ES / EN      CLARO / OSCURO / SISTEMA
```

## Herramientas nuevas (slugs ya registrados en `src/lib/tools-registry.ts`, en estado `soon`, con pagina provisional)

| slug | que hace | duena |
|---|---|---|
| `image-converter` | cambia el formato de imagenes (JPG/PNG/WEBP/AVIF segun navegador; entrada tambien HEIC en Safari, GIF, BMP), calidad, tamaño, fondo al pasar a JPG | W-IMG |
| `audio-converter` | cambia el formato de audios (WAV, MP3, M4A/AAC, OGG/Opus segun navegador) | W-AUDIO |
| `audio-extractor` | extrae la pista de audio de un VIDEO que el usuario sube (local) | W-AUDIO |
| `audio-studio` | editor de audio: cortar/recortar, quitar tramos, unir, fundidos, volumen, cambiar formato; forma de onda | W-AUDIO |
| `video-converter` | cambia el formato de un video (MP4/WebM), resolucion, calidad; con WebCodecs | W-VIDEO |
| `downloader` | pagina honesta «aun no disponible» + por que + alternativas locales | W-SHELL |
| `html-to-pdf` (existente) | + escribir una URL (via servidor) y PDF carta bien distribuido | W-HTML |

## Reglas comunes (todas las duenas)

1. 100 % local salvo `/api/html-snapshot`. Los convertidores y Audio Studio no hacen **ninguna** peticion de red con el contenido del usuario; nada de
   CDN/`import()` remoto; dependencias nuevas solo con licencia permisiva (MIT/BSD/Apache/ISC; **nada GPL/LGPL con enlace estatico ni `ffmpeg.wasm`**),
   empaquetadas por el build, y se listan en el informe (nombre, version, licencia, peso en KB en el bundle de la ruta).
2. Archivos de prueba SINTETICOS (los generas tu); nunca datos reales del usuario. Nada del contenido en logs/console/nombres de archivo.
3. Estilo del repo: comentarios en espanol con la densidad del codigo vecino; textos ES y EN (cada herramienta con su propio `strings.ts` en su carpeta;
   no edites `src/lib/locales/*` salvo la entrada de tu slug si hace falta); accesibilidad (axe 0, objetivos 44 px con tacto, sin desborde a 320 px,
   tipografia ancha, claro/oscuro con los tokens); estado = texto + icono, nunca solo color; `prefers-reduced-motion`.
4. Reutiliza lo que ya existe: `ToolShell`, `FileDropzone`, `DownloadScreen`, `ErrorBanner`, `PartialFailureReport`, `OptionControls`, `ProcessingOverlay`,
   `withSuffix`/`downloadBlob` (`src/lib/pdf/core`), el guardian de entrada (`inputGuard`/`fileAdmission`), `ToolPageSoon` como modelo de pagina.
   Mira `src/app/jpg-to-pdf` y `src/app/html-to-pdf` como patron de herramienta.
5. Trabajo pesado (decodificar, codificar, mezclar) fuera del hilo principal cuando sea razonable (Worker), con progreso real, cancelacion (`AbortSignal`)
   y limites de tamaño con mensaje claro (nunca cuelgues la pestaña). Detecta capacidades (WebCodecs, AudioEncoder, OffscreenCanvas) y degrada con un
   mensaje honesto, no con un error generico.
6. Propiedad de archivos: cada duena toca SOLO sus carpetas (`src/app/<slug>/`, `src/lib/media/<audio|image|video>/`, `src/lib/htmlSnapshot/`, `e2e/specs/<slug>*.spec.ts`).
   Solo W-SHELL toca registro (estructura), Sidebar, Header, MobileTabBar, Home. Una duena de herramienta SI puede, en el registro, pasar SU slug de `soon`
   a `live` y ajustar su `accept`/`extensions` (una sola linea), y su pagina `src/app/<slug>/page.tsx` sustituye a la provisional.
7. Politica de pruebas (peticion del usuario: **no verificar tras cada paso**): escribe las pruebas unitarias de tu motor junto al codigo, pero corre
   verificacion UNA vez al final: `npx tsc --noEmit`, `npx eslint src e2e`, `npx vitest run --project engines --project components <tus rutas>`, y UNA
   corrida E2E pequena con el servidor de desarrollo (sin `CI=1`, `PW_PORT` propio 3950–3999, headless siempre) de tu spec. No ejecutes la suite
   completa ni `next build` (otras duenas trabajan a la vez y la maquina es una sola). Informa con honestidad lo que NO pudiste verificar.
8. Entrega: `unit-nodocs.patch` (diff de tu copia contra la base, sin `docs/`) y `unit-docs-section.md` en tu carpeta de entrega (seccion para este documento:
   diseño, limites, no verificado, y **la lista de pruebas manuales** que el usuario debe hacer en su Mac/iPhone/iPad para dar el visto bueno).

## Integracion (la hace el orquestador)

Aplicar parches en este orden: SHELL → IMG → AUDIO → VIDEO → HTML; reconciliar `package.json`/lock; `tsc`, `eslint`, unitarias completas, `next build`,
E2E de navegacion + specs nuevos; revision de seguridad independiente de `/api/html-snapshot`; despliegue; humo; informe con las pruebas manuales.
