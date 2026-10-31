#!/usr/bin/env bash
# Puerta de calidad LOCAL: hace lo mismo que .github/workflows/ci.yml sin gastar ni un minuto de GitHub Actions.
#
# Uso:  scripts/ci-local.sh <nivel>      (o `npm run ci:local -- <nivel>`)
#
#   fast   tsc + eslint + pruebas unitarias SOLO de lo que cambio respecto a origin/main (con `vitest related`). Minutos. Para el dia a dia.
#   full   todo el CI en esta maquina (macOS): tipos, lint, unitarias, fuzz del Escaner, build y E2E en dos pasadas. ~1 h.
#   linux  lo mismo que `full` pero DENTRO de Docker con la imagen oficial de Playwright (Linux, como el runner de GitHub). Imprescindible
#          antes de subir cambios de riesgo: el canvas dibuja distinto en Linux y las fuentes son otras (axe `target-size`, recortes, tiempos).
#
# Variables opcionales:
#   STAGES      etapas a correr, separadas por comas, de: types,lint,unit,heavy,build,e2e   (por defecto todas; `fast` ignora esta variable)
#   CI_LOCAL_BASE  commit contra el que `fast` mira los cambios (por defecto origin/main).
#   E2E_SHARD   solo ese fragmento de la E2E, p. ej. E2E_SHARD=2/5 (como en el CI). Vacio = toda la suite.
#   CI_LOCAL_CPUS / CI_LOCAL_MEM   limites del contenedor del nivel `linux` (por defecto 4 CPUs y 6g; la VM de Docker suele tener ~7,7 GB).
#
# Sale con codigo distinto de cero si falla CUALQUIER etapa. Las etapas siguen corriendo para que el resumen final lo muestre todo.
set -uo pipefail

LEVEL="${1:-fast}"
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ROOT="$PWD"
PLAYWRIGHT_IMAGE="mcr.microsoft.com/playwright:v$(node -p "require('./node_modules/@playwright/test/package.json').version" 2>/dev/null || echo 1.62.0)-noble"
STAGES="${STAGES:-types,lint,unit,heavy,build,e2e}"
E2E_SHARD="${E2E_SHARD:-}"

RESULTS=()
FAILED=0

want() { [[ ",${STAGES}," == *",$1,"* ]]; }

stage() { # stage <nombre> <comando...>
  local name="$1"; shift
  local start=$SECONDS
  echo
  echo "━━ ${name} ━━"
  if "$@"; then
    RESULTS+=("OK    ${name} ($((SECONDS - start)) s)")
  else
    RESULTS+=("FALLO ${name} ($((SECONDS - start)) s)")
    FAILED=1
  fi
}

summary() {
  echo
  echo "════ Resumen ci-local (${LEVEL}) ════"
  printf '%s\n' "${RESULTS[@]}"
  if [[ "$FAILED" -ne 0 ]]; then echo "RESULTADO: FALLO"; else echo "RESULTADO: todo en verde"; fi
  return "$FAILED"
}

shard_args() { [[ -n "$E2E_SHARD" ]] && echo "--shard=${E2E_SHARD}"; }

e2e_main() { CI=1 FOCUS_REPS=3 PW_PERF=skip npx playwright test $(shard_args); }
e2e_perf() { CI=1 FOCUS_REPS=3 PW_PERF=only PW_SKIP_BUILD=1 npx playwright test $(shard_args) --workers=1 --pass-with-no-tests; }

unit_all() { npx vitest run --project engines --project components; }
unit_heavy() { npx vitest run --project scan-heavy --maxWorkers=1; }

# --- fast ------------------------------------------------------------------------------------------------------------------
if [[ "$LEVEL" == "fast" ]]; then
  stage "tipos (tsc)" npx tsc --noEmit
  stage "lint (eslint)" npx eslint src e2e
  BASE="${CI_LOCAL_BASE:-$(git merge-base HEAD origin/main 2>/dev/null || echo HEAD)}"
  CHANGED="$( { git diff --name-only "$BASE"; git diff --name-only; git ls-files --others --exclude-standard; } | sort -u | grep -E '^src/.*\.(ts|tsx)$' || true)"
  if [[ -z "$CHANGED" ]]; then
    echo "No hay archivos de src/ cambiados respecto a ${BASE:0:7}: no hay pruebas relacionadas que correr."
    RESULTS+=("OMIT  pruebas unitarias relacionadas (sin cambios en src/)")
  else
    echo "Archivos cambiados: $(echo "$CHANGED" | wc -l | tr -d ' ')"
    # shellcheck disable=SC2086
    stage "pruebas unitarias relacionadas (vitest related)" npx vitest related --run --project engines --project components $CHANGED
  fi
  summary; exit $?
fi

# --- full (esta maquina) ---------------------------------------------------------------------------------------------------
if [[ "$LEVEL" == "full" ]]; then
  want types && stage "tipos (tsc)" npx tsc --noEmit
  want lint  && stage "lint (eslint)" npx eslint src e2e
  want unit  && stage "pruebas unitarias (engines + components)" unit_all
  want heavy && stage "fuzz y metricas del Escaner (1 worker)" unit_heavy
  want build && stage "build de produccion (next build)" npm run build
  if want e2e; then
    stage "E2E Chromium (sin @perf)" e2e_main
    stage "E2E de rendimiento (@perf, 1 worker)" e2e_perf
  fi
  summary; exit $?
fi

# --- linux (Docker) --------------------------------------------------------------------------------------------------------
if [[ "$LEVEL" == "linux" ]]; then
  command -v docker >/dev/null || { echo "Docker no esta instalado o no esta en marcha."; exit 2; }
  docker image inspect "$PLAYWRIGHT_IMAGE" >/dev/null 2>&1 || { echo "Falta la imagen ${PLAYWRIGHT_IMAGE}; bajala una vez con: docker pull ${PLAYWRIGHT_IMAGE}"; exit 2; }
  WORK="$(mktemp -d "${TMPDIR:-/tmp}/optimuspdf-ci-linux.XXXXXX")"
  trap 'rm -rf "$WORK"' EXIT
  echo "Copiando el repo a ${WORK} (sin node_modules, .next ni .git)..."
  rsync -a --exclude node_modules --exclude .next --exclude .git --exclude .evidence --exclude test-results "$ROOT"/ "$WORK"/
  # node_modules de Linux en un volumen aparte (los de macOS tienen binarios nativos distintos); la cache de npm tambien persiste.
  docker run --rm --name "optimuspdf-ci-linux-$$" \
    --cpus "${CI_LOCAL_CPUS:-4}" --memory "${CI_LOCAL_MEM:-6g}" --ipc=host \
    -v "$WORK":/work -v optimuspdf-ci-node_modules:/work/node_modules -v optimuspdf-ci-npm-cache:/root/.npm \
    -w /work -e CI=1 -e STAGES="$STAGES" -e E2E_SHARD="$E2E_SHARD" \
    "$PLAYWRIGHT_IMAGE" bash -lc 'npm ci --no-audit --no-fund && scripts/ci-local.sh full'
  CODE=$?
  # Evidencia de Playwright (capturas y trazas de los fallos) fuera del contenedor.
  if [[ -d "$WORK/.evidence" ]]; then mkdir -p "$ROOT/.evidence" && rsync -a "$WORK/.evidence/" "$ROOT/.evidence/linux/" 2>/dev/null || true; fi
  exit "$CODE"
fi

echo "Nivel desconocido: ${LEVEL}. Usa fast, full o linux." >&2
exit 2
