# Spawn Lock - Prevención de Race Conditions en Windows

## Problema Original

En Windows, **3 hooks disparan simultáneamente** `worker-service.cjs start`:

1. **SessionStart** - Al inicializar Claude
2. **UserPromptSubmit** - Cuando el usuario escribe un prompt
3. **PostToolUse** - Después de ejecutar una herramienta

Sin sincronización, ambos procesos:
- ✅ Ven el puerto libre
- ❌ Ambos llaman a `spawnDaemon()` 
- ❌ Intentan crear el lock file simultáneamente
- ❌ Colisión: doble worker, puerto ya en uso

Log típico:

```
[INFO ] [SYSTEM] Starting worker daemon
[INFO ] [SYSTEM] Starting worker daemon (duplicado)
[ERROR] [SYSTEM] ✗ Worker failed to start Failed to start server. Is port 37777 in use?
```

## Solución: Atomic Lock File

Introducimos un **lock file cross-process** que funciona en Windows y Unix:

### Arquitectura

```
.worker-start.lock          ← Lock file atómico
├─ PID: proceso que lo tiene
├─ startedAt: timestamp
└─ Timeout: 2 minutos
```

### Flujo

**Proceso A (SessionStart):**

```typescript
tryAcquireSpawnLock() → true ✅
spawnDaemon()
waitForHealth()
releaseSpawnLock()     → lock file eliminado
```

**Proceso B (UserPromptSubmit, simultáneamente):**

```typescript
tryAcquireSpawnLock() → false ❌
// Lock adquirido por A, esperar...
waitForHealth()       → Se espera hasta 30s
// Log: "Worker spawn already in progress"
```

**Proceso C (PostToolUse, más tarde):**

```typescript
// A liberó el lock, C intenta
tryAcquireSpawnLock() → true ✅
waitForHealth()       → Worker ya corre, healthy = true ✅
releaseSpawnLock()
```

## Seguridad

### Lock Atómico en Windows

```typescript
const fd = openSync(lockPath, 'wx');  // 'wx' = exclusive create (Windows safe)
writeFileSync(fd, JSON.stringify({ pid, startedAt }));
closeSync(fd);
```

La flag `'wx'` en Node.js usa `CreateFileA` en Windows con `FILE_FLAG_NO_BUFFERING`, garantizando que:
- ✅ Solo un proceso lo crea exitosamente
- ✅ Los otros reciben `EEXIST`
- ✅ No hay race condition

### Timeout Automático

Si el proceso titular cuelga, el lock expira en 2 minutos:

```typescript
const SPAWN_LOCK_TIMEOUT_MS = 2 * 60 * 1000;

if (Date.now() - modifiedTimeMs < SPAWN_LOCK_TIMEOUT_MS) {
  return false;  // Lock aún activo
} else {
  unlinkSync(lockPath);
  // Renovar lock
}
```

## Impacto en Hooks

Antes:

```json
{
  "SessionStart": [
    {"command": "worker-service.cjs start"},
    {"command": "worker-service.cjs hook ..."}
  ],
  "UserPromptSubmit": [
    {"command": "worker-service.cjs start"}  ← Race con SessionStart
  ],
  "PostToolUse": [
    {"command": "worker-service.cjs start"}  ← Race de 3
  ]
}
```

Después (lock en `ensureWorkerStarted()`):

```typescript
// SessionStart
ensureWorkerStarted() → adquiere lock, spawns, libera ✅

// UserPromptSubmit (simultáneo)
ensureWorkerStarted() → tryAcquireSpawnLock() = false
               → waitForHealth() de 30s → worker ya está healthy ✅

// PostToolUse (más tarde)
ensureWorkerStarted() → adquiere lock, waitForHealth() = true ✅
```

## Testing

Véase [tests/spawn-lock.test.ts](../tests/spawn-lock.test.ts) para validación:

```bash
bun test tests/spawn-lock.test.ts
```

Tests validan:

- ✅ `tryAcquireSpawnLock()` retorna `true` si no hay lock
- ✅ Retorna `false` si hay lock activo
- ✅ Renueva lock si expiró
- ✅ Simula 2+ procesos compitiendo por spawn
- ✅ Lock file tiene estructura JSON válida
- ✅ Maneja corrupción del lock file

## En el Código

Ver implementación en:

- [src/services/worker-service.ts](../src/services/worker-service.ts#L31-L79) - funciones de lock
- [src/services/worker-service.ts](../src/services/worker-service.ts#L862-L915) - `ensureWorkerStarted()`

## Comportamiento Esperado

### Windows

```
Hook SessionStart ──┐
Hook UserPromptSubmit → [SYSTEM] Worker spawn already in progress, waiting for health
Hook PostToolUse ────┘

[SYSTEM] Starting worker daemon     ← SessionStart adquirió lock
[SYSTEM] Worker started successfully
[SYSTEM] Worker is now healthy      ← UserPromptSubmit y PostToolUse detectan healthy
```

### Resultado

✅ Un único spawn
✅ Todas las hooks ven el worker healthy
✅ Sin colisiones de puerto
✅ Sin "double daemon" en logs

## Logs Relacionados

Busca en `claude-mem-YYYY-MM-DD.log`:

```
Worker spawn already in progress      ← Otra hook esperó
Starting worker daemon                ← Solo ocurre una vez
Worker started successfully           ← Espera de salud exitosa
```

Si ves doble "Starting worker daemon", el lock no se aplicó (antiguo código).

## Ver También

- [src/services/infrastructure/ProcessManager.ts](../src/services/infrastructure/ProcessManager.ts) - Limpieza de procesos huérfanos
- [plugin/hooks/hooks.json](../plugin/hooks/hooks.json) - Definición de hooks
