# Configuración de Chroma en Windows

## Descripción General

En **Windows**, la búsqueda semántica con **Chroma** está **deshabilitada por defecto** para prevenir que se abran ventanas popup de consola cuando el MCP SDK inicia procesos Python.

Sin embargo, puedes habilitar Chroma en Windows si aceptas el riesgo de popups ocasionales en la consola.

## Comportamiento Actual (Deshabilitado)

- ❌ **Búsqueda semántica**: Deshabilitada
- ✅ **Búsqueda SQLite FTS5**: Disponible (búsqueda de texto completo por metadatos)
- ✅ **Observaciones**: Se almacenan en la base de datos
- ❌ **Vectores**: No se sincronizan ni se indexan en ChromaDB

## Habilitar Chroma en Windows

Para habilitar la búsqueda semántica en Windows, establece la variable de entorno:

```bash
set CLAUDE_MEM_ENABLE_CHROMA_WINDOWS=true
```

O en PowerShell:

```powershell
$env:CLAUDE_MEM_ENABLE_CHROMA_WINDOWS = "true"
```

O de forma permanente en Windows (variables de entorno):

1. Abre **Configuración > Sistema > Configuración avanzada del sistema**
2. Haz clic en **Variables de entorno**
3. Clic en **Nueva** (variables de usuario o del sistema)
4. Nombre: `CLAUDE_MEM_ENABLE_CHROMA_WINDOWS`
5. Valor: `true`
6. Reinicia Claude/Cursor

### Después de Activar

Con la variable de entorno, el worker registrará:

```
[WARN ] [CHROMA_SYNC] Vector search enabled on Windows by override
[INFO ] [CHROMA_SYNC] Connecting to Chroma MCP server...
```

Y luego:

```
[INFO ] [CHROMA_SYNC] Connected to Chroma MCP server
[WORKER] Waiting for Chroma sync...
```

## Qué Esperar

### ✅ Ventajas de Habilitar

- **Búsqueda semántica**: Las búsquedas encuentran conceptos relacionados, no solo palabras clave
- **Mejor ranking**: Resultados ordenados por relevancia semántica, no solo frecuencia
- **Aha moments**: Conexiones entre observaciones que FTS5 nunca encontraría

### ⚠️ Desventajas

- **Popups ocasionales**: Cuando ChromaDB inicia el proceso Python, puede aparecer una ventana de consola
- **Consumo de recursos**: ChromaDB usa más memoria y CPU que FTS5
- **Lentitud inicial**: El primer acceso a Chroma es lento (carga el modelo embeddings)

## Deshabilitar Chroma (Volver a Default)

Para volver al comportamiento por defecto, **elimina la variable de entorno**:

```bash
# PowerShell
Remove-Item Env:CLAUDE_MEM_ENABLE_CHROMA_WINDOWS
```

O simplemente **no estableces** `CLAUDE_MEM_ENABLE_CHROMA_WINDOWS`.

## Implementación Técnica

Véase [src/services/sync/ChromaSync.ts](../src/services/sync/ChromaSync.ts#L100-L118) para detalles.

```typescript
const allowWindowsChroma = process.env.CLAUDE_MEM_ENABLE_CHROMA_WINDOWS === 'true';
this.disabled = process.platform === 'win32' && !allowWindowsChroma;
```

## Problemas Relacionados

- **Issue #675**: Popups de consola en Windows con MCP SDK
- **Version Actual**: El `windowsHide` en StdioClientTransport no es completamente confiable

## Alternativas Futuras

Cuando migremos a un servidor HTTP persistente de Chroma (en lugar de StdioClientTransport), el popup de consola desaparecerá y Chroma será seguro en Windows por defecto.

## Ver También

- [src/services/sync/ChromaSync.ts](../src/services/sync/ChromaSync.ts) - Implementación de ChromaSync
- [src/services/infrastructure/ProcessManager.ts](../src/services/infrastructure/ProcessManager.ts) - Gestión de procesos
