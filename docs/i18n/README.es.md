🌐 Esta es una traducción automatizada. ¡Las correcciones de la comunidad son bienvenidas!

---
<h1 align="center">
  <br>
  <a href="https://github.com/thedotmack/claude-mem">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/thedotmack/claude-mem/main/docs/public/claude-mem-logo-for-dark-mode.webp">
      <source media="(prefers-color-scheme: light)" srcset="https://raw.githubusercontent.com/thedotmack/claude-mem/main/docs/public/claude-mem-logo-for-light-mode.webp">
      <img src="https://raw.githubusercontent.com/thedotmack/claude-mem/main/docs/public/claude-mem-logo-for-light-mode.webp" alt="Claude-Mem" width="400">
    </picture>
  </a>
  <br>
</h1>

<h4 align="center">Sistema de compresión de memoria persistente construido para <a href="https://claude.com/claude-code" target="_blank">Claude Code</a>.</h4>

<p align="center">
  <a href="LICENSE">
    <img src="https://img.shields.io/badge/License-AGPL%203.0-blue.svg" alt="License">
  </a>
  <a href="package.json">
    <img src="https://img.shields.io/badge/version-6.5.0-green.svg" alt="Version">
  </a>
  <a href="package.json">
    <img src="https://img.shields.io/badge/node-%3E%3D18.0.0-brightgreen.svg" alt="Node">
  </a>
  <a href="https://github.com/thedotmack/awesome-claude-code">
    <img src="https://awesome.re/mentioned-badge.svg" alt="Mentioned in Awesome Claude Code">
  </a>
</p>

<br>

<p align="center">
  <a href="https://github.com/thedotmack/claude-mem">
    <picture>
      <img src="https://raw.githubusercontent.com/thedotmack/claude-mem/main/docs/public/cm-preview.gif" alt="Claude-Mem Preview" width="800">
    </picture>
  </a>
</p>

<p align="center">
  <a href="#inicio-rápido">Inicio Rápido</a> •
  <a href="#cómo-funciona">Cómo Funciona</a> •
  <a href="#herramientas-de-búsqueda-mcp">Herramientas de Búsqueda</a> •
  <a href="#documentación">Documentación</a> •
  <a href="#configuración">Configuración</a> •
  <a href="#solución-de-problemas">Solución de Problemas</a> •
  <a href="#licencia">Licencia</a>
</p>

<p align="center">
  Claude-Mem preserva el contexto de manera fluida entre sesiones al capturar automáticamente observaciones del uso de herramientas, generar resúmenes semánticos y ponerlos a disposición de sesiones futuras. Esto permite a Claude mantener la continuidad del conocimiento sobre proyectos incluso después de que las sesiones terminen o se reconecten.
</p>

---

## Inicio Rápido

Inicia una nueva sesión de Claude Code en la terminal e ingresa los siguientes comandos:

```
> /plugin marketplace add thedotmack/claude-mem

> /plugin install claude-mem
```

Reinicia Claude Code. El contexto de sesiones anteriores aparecerá automáticamente en nuevas sesiones.

**Características Clave:**

- 🧠 **Memoria Persistente** - El contexto sobrevive entre sesiones
- 📊 **Divulgación Progresiva** - Recuperación de memoria por capas con visibilidad de costos de tokens
- 🔍 **Búsqueda Basada en Habilidades** - Consulta el historial de tu proyecto con la habilidad mem-search (~2,250 tokens de ahorro)
- 🖥️ **Interfaz de Visor Web** - Flujo de memoria en tiempo real en http://localhost:37777
- 🔒 **Control de Privacidad** - Usa etiquetas `<private>` para excluir contenido sensible del almacenamiento
- ⚙️ **Configuración de Contexto** - Control detallado sobre qué contexto se inyecta
- 🤖 **Operación Automática** - No requiere intervención manual
- 🔗 **Citas** - Referencia decisiones pasadas con URIs `claude-mem://`
- 🧪 **Canal Beta** - Prueba características experimentales como Endless Mode mediante cambio de versión

---

## Documentación

📚 **[Ver Documentación Completa](docs/)** - Explora documentos markdown en GitHub

💻 **Vista Previa Local**: Ejecuta documentación Mintlify localmente:

```bash
cd docs
npx mintlify dev
```

### Primeros Pasos

- **[Guía de Instalación](https://docs.claude-mem.ai/installation)** - Inicio rápido e instalación avanzada
- **[Guía de Uso](https://docs.claude-mem.ai/usage/getting-started)** - Cómo funciona Claude-Mem automáticamente
- **[Herramientas de Búsqueda](https://docs.claude-mem.ai/usage/search-tools)** - Consulta el historial de tu proyecto con lenguaje natural
- **[Características Beta](https://docs.claude-mem.ai/beta-features)** - Prueba características experimentales como Endless Mode

### Mejores Prácticas

- **[Ingeniería de Contexto](https://docs.claude-mem.ai/context-engineering)** - Principios de optimización de contexto para agentes IA
- **[Divulgación Progresiva](https://docs.claude-mem.ai/progressive-disclosure)** - Filosofía detrás de la estrategia de preparación de contexto de Claude-Mem

### Arquitectura

- **[Descripción General](https://docs.claude-mem.ai/architecture/overview)** - Componentes del sistema y flujo de datos
- **[Evolución de Arquitectura](https://docs.claude-mem.ai/architecture-evolution)** - El viaje de v3 a v5
- **[Arquitectura de Hooks](https://docs.claude-mem.ai/hooks-architecture)** - Cómo Claude-Mem usa hooks de ciclo de vida
- **[Referencia de Hooks](https://docs.claude-mem.ai/architecture/hooks)** - 7 scripts de hooks explicados
- **[Servicio Worker](https://docs.claude-mem.ai/architecture/worker-service)** - API HTTP y gestión PM2
- **[Base de Datos](https://docs.claude-mem.ai/architecture/database)** - Esquema SQLite y búsqueda FTS5
- **[Arquitectura de Búsqueda](https://docs.claude-mem.ai/architecture/search-architecture)** - Búsqueda híbrida con base de datos vectorial Chroma

### Configuración y Desarrollo

- **[Configuración](https://docs.claude-mem.ai/configuration)** - Variables de entorno y ajustes
- **[Desarrollo](https://docs.claude-mem.ai/development)** - Construcción, pruebas, contribución
- **[Solución de Problemas](https://docs.claude-mem.ai/troubleshooting)** - Problemas comunes y soluciones

---

## Cómo Funciona

```
┌─────────────────────────────────────────────────────────────┐
│ Inicio de Sesión → Inyectar observaciones recientes como   │
│ contexto                                                     │
└─────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────┐
│ Indicaciones del Usuario → Crear sesión, guardar prompts   │
└─────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────┐
│ Ejecuciones de Herramientas → Capturar observaciones       │
│ (Read, Write, etc.)                                         │
└─────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────┐
│ Procesos Worker → Extraer aprendizajes vía Claude Agent SDK│
└─────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────┐
│ Fin de Sesión → Generar resumen, listo para próxima sesión │
└─────────────────────────────────────────────────────────────┘
```

**Componentes Principales:**

1. **5 Hooks de Ciclo de Vida** - SessionStart, UserPromptSubmit, PostToolUse, Stop, SessionEnd (6 scripts de hooks)
2. **Instalación Inteligente** - Verificador de dependencias en caché (script pre-hook, no es un hook de ciclo de vida)
3. **Servicio Worker** - API HTTP en puerto 37777 con interfaz de visor web y 10 endpoints de búsqueda, administrado por PM2
4. **Base de Datos SQLite** - Almacena sesiones, observaciones, resúmenes con búsqueda de texto completo FTS5
5. **Habilidad mem-search** - Consultas en lenguaje natural con divulgación progresiva (~2,250 tokens de ahorro vs MCP)
6. **Base de Datos Vectorial Chroma** - Búsqueda híbrida semántica + palabras clave para recuperación inteligente de contexto

Ver [Descripción General de Arquitectura](https://docs.claude-mem.ai/architecture/overview) para más detalles.

---

## Habilidad mem-search

Claude-Mem proporciona búsqueda inteligente a través de la habilidad mem-search que se invoca automáticamente cuando preguntas sobre trabajo pasado:

**Cómo Funciona:**
- Solo pregunta naturalmente: *"¿Qué hicimos la última sesión?"* o *"¿Arreglamos este error antes?"*
- Claude invoca automáticamente la habilidad mem-search para encontrar contexto relevante
- ~2,250 tokens de ahorro por inicio de sesión vs enfoque MCP

**Operaciones de Búsqueda Disponibles:**

1. **Buscar Observaciones** - Búsqueda de texto completo en observaciones
2. **Buscar Sesiones** - Búsqueda de texto completo en resúmenes de sesiones
3. **Buscar Prompts** - Buscar solicitudes brutas de usuario
4. **Por Concepto** - Buscar por etiquetas de concepto (discovery, problem-solution, pattern, etc.)
5. **Por Archivo** - Buscar observaciones que referencian archivos específicos
6. **Por Tipo** - Buscar por tipo (decision, bugfix, feature, refactor, discovery, change)
7. **Contexto Reciente** - Obtener contexto de sesión reciente para un proyecto
8. **Línea de Tiempo** - Obtener línea de tiempo unificada de contexto alrededor de un punto específico en el tiempo
9. **Línea de Tiempo por Consulta** - Buscar observaciones y obtener contexto de línea de tiempo alrededor de la mejor coincidencia
10. **Ayuda API** - Obtener documentación de API de búsqueda

**Ejemplos de Consultas en Lenguaje Natural:**

```
"¿Qué errores arreglamos la última sesión?"
"¿Cómo implementamos la autenticación?"
"¿Qué cambios se hicieron en worker-service.ts?"
"Muéstrame el trabajo reciente en este proyecto"
"¿Qué estaba pasando cuando agregamos la interfaz del visor?"
```

Ver [Guía de Herramientas de Búsqueda](https://docs.claude-mem.ai/usage/search-tools) para ejemplos detallados.

---

## Características Beta y Endless Mode

Claude-Mem ofrece un **canal beta** con características experimentales. Cambia entre versiones estables y beta directamente desde la interfaz del visor web.

### Cómo Probar Beta

1. Abre http://localhost:37777
2. Haz clic en Configuración (ícono de engranaje)
3. En **Version Channel**, haz clic en "Try Beta (Endless Mode)"
4. Espera a que el worker se reinicie

Tus datos de memoria se preservan al cambiar versiones.

### Endless Mode (Beta)

La característica beta insignia es **Endless Mode** - una arquitectura de memoria biomimética que extiende dramáticamente la duración de la sesión:

**El Problema**: Las sesiones estándar de Claude Code alcanzan límites de contexto después de ~50 usos de herramientas. Cada herramienta agrega 1-10k+ tokens, y Claude re-sintetiza todas las salidas anteriores en cada respuesta (complejidad O(N²)).

**La Solución**: Endless Mode comprime salidas de herramientas en observaciones de ~500 tokens y transforma la transcripción en tiempo real:

```
Memoria de Trabajo (Contexto):     Observaciones comprimidas (~500 tokens cada una)
Memoria Archivo (Disco):           Salidas completas de herramientas preservadas para recordar
```

**Resultados Esperados**:
- ~95% de reducción de tokens en ventana de contexto
- ~20x más usos de herramientas antes del agotamiento de contexto
- Escalado lineal O(N) en lugar de cuadrático O(N²)
- Transcripciones completas preservadas para recordar perfecto

**Advertencias**: Agrega latencia (60-90s por herramienta para generación de observación), aún experimental.

Ver [Documentación de Características Beta](https://docs.claude-mem.ai/beta-features) para más detalles.

---

## Novedades

**v6.4.9 - Configuración de Contexto:**
- 11 nuevos ajustes para control detallado sobre inyección de contexto
- Configurar visualización de economía de tokens, filtrado de observaciones por tipo/concepto
- Controlar número de observaciones y qué campos mostrar

**v6.4.0 - Sistema de Privacidad de Doble Etiqueta:**
- Etiquetas `<private>` para privacidad controlada por el usuario - envuelve contenido sensible para excluirlo del almacenamiento
- Etiquetas `<claude-mem-context>` a nivel de sistema previenen almacenamiento recursivo de observaciones
- Procesamiento en el borde asegura que el contenido privado nunca llegue a la base de datos

**v6.3.0 - Canal de Versión:**
- Cambia entre versiones estables y beta desde la interfaz del visor web
- Prueba características experimentales como Endless Mode sin operaciones git manuales

**Destacados Anteriores:**
- **v6.0.0**: Mejoras importantes en gestión de sesiones y procesamiento de transcripciones
- **v5.5.0**: Mejora de habilidad mem-search con tasa de efectividad del 100%
- **v5.4.0**: Arquitectura de búsqueda basada en habilidades (~2,250 tokens ahorrados por sesión)
- **v5.1.0**: Interfaz de visor basada en web con actualizaciones en tiempo real
- **v5.0.0**: Búsqueda híbrida con base de datos vectorial Chroma

Ver [CHANGELOG.md](CHANGELOG.md) para historial completo de versiones.

---

## Requisitos del Sistema

- **Node.js**: 18.0.0 o superior
- **Claude Code**: Última versión con soporte de plugins
- **PM2**: Administrador de procesos (incluido - no requiere instalación global)
- **SQLite 3**: Para almacenamiento persistente (incluido)

---

## Beneficios Clave

### Contexto de Divulgación Progresiva

- **Recuperación de memoria por capas** refleja patrones de memoria humana
- **Capa 1 (Índice)**: Ver qué observaciones existen con costos de tokens al inicio de sesión
- **Capa 2 (Detalles)**: Obtener narrativas completas bajo demanda vía búsqueda MCP
- **Capa 3 (Recordar Perfecto)**: Acceder a código fuente y transcripciones originales
- **Toma de decisiones inteligente**: Los conteos de tokens ayudan a Claude a elegir entre obtener detalles o leer código
- **Indicadores de tipo**: Señales visuales (🔴 crítico, 🟤 decisión, 🔵 informacional) resaltan importancia de observación

### Memoria Automática

- Contexto inyectado automáticamente cuando Claude inicia
- No se necesitan comandos manuales o configuración
- Funciona transparentemente en segundo plano

### Búsqueda de Historial Completo

- Buscar en todas las sesiones y observaciones
- Búsqueda de texto completo FTS5 para consultas rápidas
- Las citas enlazan de vuelta a observaciones específicas

### Observaciones Estructuradas

- Extracción de aprendizajes potenciada por IA
- Categorizadas por tipo (decision, bugfix, feature, etc.)
- Etiquetadas con conceptos y referencias de archivos

### Sesiones Multi-Prompt

- Las sesiones abarcan múltiples prompts de usuario
- Contexto preservado entre comandos `/clear`
- Rastrear hilos de conversación completos

---

## Configuración

Los ajustes se gestionan en `~/.claude-mem/settings.json`. El archivo se crea automáticamente con valores predeterminados en la primera ejecución.

**Ajustes Disponibles:**

| Ajuste | Predeterminado | Descripción |
|---------|---------|-------------|
| `CLAUDE_MEM_MODEL` | `claude-haiku-4-5` | Modelo de IA para observaciones |
| `CLAUDE_MEM_WORKER_PORT` | `37777` | Puerto del servicio worker |
| `CLAUDE_MEM_DATA_DIR` | `~/.claude-mem` | Ubicación del directorio de datos |
| `CLAUDE_MEM_LOG_LEVEL` | `INFO` | Verbosidad de registros (DEBUG, INFO, WARN, ERROR, SILENT) |
| `CLAUDE_MEM_PYTHON_VERSION` | `3.13` | Versión de Python para chroma-mcp |
| `CLAUDE_CODE_PATH` | _(auto-detectar)_ | Ruta al ejecutable de Claude |
| `CLAUDE_MEM_CONTEXT_OBSERVATIONS` | `50` | Número de observaciones a inyectar en SessionStart |

**Gestión de Ajustes:**

```bash
# Editar ajustes vía ayudante CLI
./claude-mem-settings.sh

# O editar directamente
nano ~/.claude-mem/settings.json

# Ver ajustes actuales
curl http://localhost:37777/api/settings
```

**Formato del Archivo de Ajustes:**

```json
{
  "CLAUDE_MEM_MODEL": "claude-haiku-4-5",
  "CLAUDE_MEM_WORKER_PORT": "37777",
  "CLAUDE_MEM_CONTEXT_OBSERVATIONS": "50"
}
```

Ver [Guía de Configuración](https://docs.claude-mem.ai/configuration) para más detalles.

---

## Desarrollo

```bash
# Clonar y construir
git clone https://github.com/thedotmack/claude-mem.git
cd claude-mem
npm install
npm run build

# Ejecutar pruebas
npm test

# Iniciar worker
npm run worker:start

# Ver registros
npm run worker:logs
```

Ver [Guía de Desarrollo](https://docs.claude-mem.ai/development) para instrucciones detalladas.

---

## Solución de Problemas

**Diagnóstico Rápido:**

Si estás experimentando problemas, describe el problema a Claude y la habilidad troubleshoot se activará automáticamente para diagnosticar y proporcionar correcciones.

**Problemas Comunes:**

- Worker no inicia → `npm run worker:restart`
- No aparece contexto → `npm run test:context`
- Problemas de base de datos → `sqlite3 ~/.claude-mem/claude-mem.db "PRAGMA integrity_check;"`
- Búsqueda no funciona → Verifica que existan tablas FTS5

Ver [Guía de Solución de Problemas](https://docs.claude-mem.ai/troubleshooting) para soluciones completas.

---

## Contribuir

¡Las contribuciones son bienvenidas! Por favor:

1. Haz fork del repositorio
2. Crea una rama de característica
3. Realiza tus cambios con pruebas
4. Actualiza documentación
5. Envía un Pull Request

Ver [Guía de Desarrollo](https://docs.claude-mem.ai/development) para flujo de trabajo de contribución.

---

## Licencia

Este proyecto está licenciado bajo la **GNU Affero General Public License v3.0** (AGPL-3.0).

Copyright (C) 2025 Alex Newman (@thedotmack). Todos los derechos reservados.

Ver el archivo [LICENSE](LICENSE) para detalles completos.

**Lo Que Esto Significa:**

- Puedes usar, modificar y distribuir este software libremente
- Si modificas y despliegas en un servidor de red, debes hacer tu código fuente disponible
- Los trabajos derivados también deben estar licenciados bajo AGPL-3.0
- NO HAY GARANTÍA para este software

---

## Soporte

- **Documentación**: [docs/](docs/)
- **Problemas**: [GitHub Issues](https://github.com/thedotmack/claude-mem/issues)
- **Repositorio**: [github.com/thedotmack/claude-mem](https://github.com/thedotmack/claude-mem)
- **Autor**: Alex Newman ([@thedotmack](https://github.com/thedotmack))

---

**Construido con Claude Agent SDK** | **Potenciado por Claude Code** | **Hecho con TypeScript**