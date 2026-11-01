# Calidad y despliegue sin CI remoto

**CI remoto (GitHub Actions): solo manual.** Ninguna subida (`push`) ni pull request lo dispara. El repositorio es privado y una corrida
completa gasta unos 200 minutos; en octubre de 2026 fueron 64 corridas y ~6.770 minutos (el 82 % en los 5 fragmentos E2E), muy por encima
de lo que incluye el plan. No se paga más ni se sube el límite de gasto. La puerta de calidad es **local**.

## La puerta local: `npm run ci:local -- <nivel>`

Script: `scripts/ci-local.sh`. Sale con código distinto de cero si falla cualquier etapa; las demás siguen para que el resumen final lo muestre todo.

| Nivel | Qué hace | Cuánto tarda | Cuándo |
|---|---|---|---|
| `fast` | `tsc` + `eslint` + pruebas unitarias solo de lo que cambió respecto a `origin/main` (`vitest related`) | minutos | mientras se desarrolla |
| `full` | tipos, lint, unitarias, fuzz del Escáner, build de producción y E2E (pasada normal y pasada `@perf`) en esta Mac | ~1 h | antes de desplegar |
| `linux` | lo mismo que `full` dentro de Docker con la imagen oficial de Playwright (`mcr.microsoft.com/playwright:v<versión>-noble`) | más de 1 h | antes de subir cambios de riesgo (canvas, recorte, fuentes, accesibilidad, tiempos) |

Variables: `STAGES=types,lint,unit,heavy,build,e2e` (subconjunto de etapas), `E2E_SHARD=2/5` (un fragmento de la E2E, como en el CI),
`E2E_ARGS="--workers=1 e2e/specs/x.spec.ts"` (argumentos extra de Playwright: sirve para repetir solo lo que fallo),
`CI_LOCAL_BASE=<commit>` (contra qué mira `fast`), `CI_LOCAL_CPUS` y `CI_LOCAL_MEM` (límites del contenedor; por defecto 4 CPUs y 6 g, la VM de
Docker tiene ~7,7 GB).

`linux` copia el repo a un directorio temporal, instala `node_modules` de Linux en el volumen `optimuspdf-ci-node_modules` (los de macOS traen
binarios nativos distintos) y guarda la evidencia de Playwright en `.evidence/linux/`. Los contenedores se llaman `optimuspdf-ci-linux-*`:
no toca ningún otro contenedor. Hay que tener bajada la imagen una vez: `docker pull mcr.microsoft.com/playwright:v1.62.0-noble`.

### Lo que se aprendio de la primera corrida completa en Linux (2026-10-31)

- La imagen de Playwright **no trae DejaVu** y el runner de GitHub si: sin ella las pruebas de «tipografia ancha» (`*-wide-font`, `scan-ui-a11y`) fallan con ratio 1.
  El script la instala (`fonts-dejavu-core`) antes de correr.
- Con 4 CPUs y 2 workers, las pruebas de 40 fotos (`image-optimize-*`) tumban Chromium («Page crashed») y `mobile-pro-m6` pierde el foco: es carga de
  la maquina, no codigo. Repetidas con `E2E_ARGS="--workers=1 ..."` pasan. Si salen rojas en la corrida completa, repetirlas asi antes de investigar.
- `scan.blurRes` caso `texto 1200x1600, desenfoque 30 px` fallaba en Linux: el fixture dibujaba con `sans-serif` (cambia con el sistema) y el
  umbral de «hoja desvaneciada» (`FADED_MIN_LAYOUT_SHARE`) estaba justo en el borde. Resuelto: el fixture usa Liberation del repo (identico en toda
  maquina) y el umbral baja de 0,25 a 0,15 (las hojas vacias y casi vacias no pasan de 0,04; el texto difuminado da 0,19-0,26). Verificado en macOS y Linux.

## Procedimiento de despliegue

1. Durante el desarrollo: `npm run ci:local -- fast` tras cada cambio.
2. Antes de subir cambios de riesgo (motor del Escáner, recorte, canvas, fuentes, accesibilidad, rendimiento): `npm run ci:local -- linux`,
   o al menos `STAGES=heavy,e2e E2E_SHARD=<n>/5` de lo que se tocó. Linux dibuja distinto de macOS y ahí aparecen los fallos que el CI de GitHub
   encontraba (axe `target-size` con fuentes anchas, umbrales del fuzz, tiempos con CPU limitada).
3. Antes de desplegar: `npm run ci:local -- full` en verde (y `linux` si hubo cambios de riesgo).
4. `git push origin main` (no dispara nada) y `vercel deploy --prod --yes --scope optimus-reframe` (sin `| head`; la integración Git no despliega sola).
5. Humo en producción (config temporal de Playwright con `baseURL` de producción; borrarla después).

Si alguna vez hace falta el CI remoto (por ejemplo, una verificación independiente en Ubuntu limpia): `gh workflow run CI --ref main`. Gasta
~200 minutos.

## Qué NO queda cubierto por no tener CI remoto

- Un runner Ubuntu limpio de GitHub (hardware y carga distintos): Docker en Mac lo aproxima pero no lo iguala. Los tiempos `@perf` se miden aquí con la CPU
  limitada, no en el runner.
- Safari/iPhone/iPad reales, la cámara real y la memoria de iOS: nunca se probaron en CI; solo se aproxima con WebKit (`webkit-ipad`) en local.
- Nadie revisa automáticamente los pull requests: si se trabaja con ramas, hay que correr `ci:local` antes de fusionar.
- Un `push` que no pasó por la puerta local no se detecta solo: la disciplina es del flujo, no de una máquina.

## Opción: runner propio en la Mac (CI automático sin gastar minutos)

No está instalado. Si algún día se quiere CI automático sin pagar:

1. En GitHub: repositorio → Settings → Actions → Runners → *New self-hosted runner* (macOS, ARM64). Sigue sus comandos (descarga, `./config.sh --url ... --token ...`,
   `./run.sh`); el token es de un solo uso y lo da GitHub en esa pantalla.
2. En `ci.yml` cambia `runs-on: ubuntu-latest` por `runs-on: self-hosted` y vuelve a añadir `push` a `on:`.
3. Los jobs correrían en tu Mac, así que ésta debe estar encendida y con Docker/Node; cada corrida compite con tu trabajo.
4. **Riesgos:** el runner ejecuta el código de cada rama con tus permisos. Úsalo solo en un repo privado sin colaboradores desconocidos, no con
   pull requests de forks, y no guardes secretos que no necesites. No es Linux: seguirías necesitando el nivel `linux` para lo específico de Ubuntu.
5. **Volver atrás:** `./config.sh remove --token <token>`, restaurar `runs-on: ubuntu-latest` y quitar `push` de `on:`.
