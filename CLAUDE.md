# CLAUDE.md

Este archivo orienta a Claude Code (claude.ai/code) al trabajar con el codigo de este repositorio.

Claude-mem es un plugin de Claude Code que provee memoria persistente entre sesiones. Captura el uso de herramientas, comprime observaciones usando el Claude Agent SDK e inyecta contexto relevante en sesiones futuras.

## Comandos de Build y Desarrollo

```bash
npm run build-and-sync        # Ciclo completo: build → sync a marketplace → reiniciar worker
npm run build                  # Solo build (esbuild: hooks + worker + viewer + MCP server)
npm run sync-marketplace       # Sincronizar plugin/ a ~/.claude/plugins/marketplaces/thedotmack/
npm run worker:restart         # Reiniciar el servicio worker
npm run worker:logs            # Ver log del worker de hoy
npm run worker:tail            # Seguir log del worker en tiempo real
```

## Testing

Los tests usan **Bun test runner** (nativo: `describe`/`it`/`expect`/`mock`/`spyOn`).

```bash
bun test                       # Correr todos los tests
bun test tests/sqlite/         # Tests de base de datos
bun test tests/worker/agents/  # Tests de procesamiento de agentes
bun test tests/worker/search/  # Tests de estrategias de busqueda
bun test tests/context/        # Tests de formateo de contexto
bun test tests/infrastructure/ # Tests de gestion de procesos
bun test tests/server/         # Tests del servidor HTTP
bun test tests/path/to/file.test.ts  # Un solo archivo de test
```

## Arquitectura

### Flujo de Datos

```
Sesion de Claude Code
  → Hook (SessionStart/UserPromptSubmit/PostToolUse/Stop)
    → bun-runner.js → worker-service.cjs hook <adapter> <handler>
      → HTTP POST a Worker API (localhost:37777)
        → Almacenamiento en SQLite + Chroma
          → Broadcast SSE al Viewer UI
```

### Pipeline de Build

`scripts/build-hooks.js` usa esbuild para producir 4 bundles desde TypeScript:

| Entrada | Salida | Formato | Notas |
|---------|--------|---------|-------|
| `src/services/worker-service.ts` | `plugin/scripts/worker-service.cjs` | CJS | `#!/usr/bin/env bun`, `bun:sqlite` externo |
| `src/servers/mcp-server.ts` | `plugin/scripts/mcp-server.cjs` | CJS | `#!/usr/bin/env node` |
| `src/services/context-generator.ts` | `plugin/scripts/context-generator.cjs` | CJS | Generacion de contexto |
| `src/ui/viewer/index.tsx` | `plugin/ui/viewer-bundle.js` | IIFE | App React del viewer |

Todos los builds apuntan a Node 18, estan minificados e inyectan `__DEFAULT_PACKAGE_VERSION__` en build time.

### Ciclo de Vida de Hooks

Definido en `plugin/hooks/hooks.json`. Cada hook invoca `bun-runner.js → worker-service.cjs hook claude-code <handler>`:

| Hook | Handler | Proposito |
|------|---------|-----------|
| SessionStart | `context` | Inyectar contexto de memoria en nueva sesion |
| UserPromptSubmit | `session-init` | Inicializar tracking de sesion |
| PostToolUse | `observation` | Capturar uso de herramientas para memoria |
| Stop | `summarize` → `session-complete` | Generar resumen, finalizar sesion |

Cada hook tambien llama a `worker-service.cjs start` primero para asegurar que el worker este corriendo.

### Worker Service (`src/services/worker-service.ts`)

Orquestador de ~300 lineas (refactorizado de un monolito de 2000+) que delega a:
- `src/services/server/` - Setup HTTP con Express, middleware
- `src/services/infrastructure/` - Gestion de PID, health checks, shutdown graceful
- `src/services/worker/http/routes/` - Handlers de rutas (Session, Search, Settings, Data, Memory, Logs, Viewer)
- `src/services/worker/agents/` - Procesamiento de respuestas (SDKAgent, GeminiAgent, OpenRouterAgent)
- `src/services/worker/search/` - Orquestacion de busqueda hibrida (estrategias Chroma + SQLite)

La API corre en **puerto 37777** con streaming SSE en `/stream`.

### Base de Datos (`src/services/sqlite/`)

SQLite via `bun:sqlite` (modo WAL, 256MB mmap, 10k page cache). Migraciones de schema en `migrations/` (v1-v7). Stores principales: `SessionStore`, `Observations`, `Sessions`, `Summaries`, `SessionSearch` (FTS5).

### Sistema Dual de Session ID

Dos session IDs distintos atraviesan el sistema:
- `content_session_id` - Sesion del transcript de Claude
- `memory_session_id` - Sesion interna del sistema de memoria (inicializado en NULL, capturado en la primera respuesta del SDK)

Esto previene que el contexto del sistema de memoria se inyecte en los transcripts del usuario.

### Tags de Privacidad

- `<private>contenido</private>` - Nivel usuario, previene almacenamiento
- `<claude-mem-context>contenido</claude-mem-context>` - Nivel sistema, previene almacenamiento recursivo

El stripping de tags ocurre en la capa de hooks (procesamiento en el borde) antes de que los datos lleguen al worker. Implementacion en `src/utils/tag-stripping.ts` con proteccion contra ReDoS (MAX_TAG_COUNT = 100).

## Estrategia de Exit Codes

Segun el contrato de hooks de Claude Code:
- **Exit 0**: Exito o shutdown graceful (errores de worker/hook tambien usan 0 para evitar acumulacion de tabs en Windows Terminal)
- **Exit 1**: Error no bloqueante (stderr mostrado al usuario)
- **Exit 2**: Error bloqueante (stderr enviado a Claude para procesamiento)

## Ubicacion de Archivos

- **Codigo fuente**: `src/`
- **Plugin compilado**: `plugin/`
- **Plugin instalado**: `~/.claude/plugins/marketplaces/thedotmack/`
- **Datos de usuario**: `~/.claude-mem/` (database, chroma, logs, settings.json)

## Configuracion

Settings en `~/.claude-mem/settings.json` (auto-creado con valores por defecto). Gestionado por `src/shared/SettingsDefaultsManager.ts`. Soporta overrides por variables de entorno via `src/shared/EnvManager.ts`.

## Documentacion

**Docs publicos**: https://docs.claude-mem.ai (Mintlify)
**Fuente**: `docs/public/` - Archivos MDX, editar `docs.json` para navegacion

## Arquitectura Pro Features

El core open-source expone todos los endpoints de la API del worker en localhost:37777. Las Pro features (proximamente, externas) se conectan a los mismos endpoints con UI mejorada. El acceso se controla por validacion de licencia, no modificando los endpoints del core.

## Importante

No es necesario editar el changelog nunca, se genera automaticamente.
