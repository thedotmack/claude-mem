🌐 Esta es una traducción automática. ¡Las correcciones de la comunidad son bienvenidas!

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

<p align="center">
  <a href="https://trendshift.io/repositories/15496" target="_blank">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/thedotmack/claude-mem/main/docs/public/trendshift-badge-dark.svg">
      <source media="(prefers-color-scheme: light)" srcset="https://raw.githubusercontent.com/thedotmack/claude-mem/main/docs/public/trendshift-badge.svg">
      <img src="https://raw.githubusercontent.com/thedotmack/claude-mem/main/docs/public/trendshift-badge.svg" alt="thedotmack/claude-mem | Trendshift" width="250" height="55"/>
    </picture>
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
  Claude-Mem preserva el contexto sin interrupciones entre sesiones al capturar automáticamente observaciones de uso de herramientas, generar resúmenes semánticos y ponerlos a disposición de sesiones futuras. Esto permite a Claude mantener la continuidad del conocimiento sobre proyectos incluso después de que las sesiones terminen o se reconecten.
</p>

---

## Inicio Rápido

Inicia una nueva sesión de Claude Code en la terminal e ingresa los siguientes comandos:

```
> /plugin marketplace add thedotmack/claude-mem

> /plugin install claude-mem
```

Reinicia Claude Code. El contexto de sesiones anteriores aparecerá automáticamente en nuevas sesiones.

**Características Principales:**

- 🧠 **Memoria Persistente** - El contexto sobrevive entre sesiones
- 📊 **Divulgación Progresiva** - Recuperación de memoria en capas con visibilidad del costo de tokens
- 🔍 **Búsqueda Basada en Habilidades** - Consulta el historial de tu proyecto con la habilidad mem-search
- 🖥️ **Interfaz de Visor Web** - Transmisión de memoria en tiempo real en http://localhost:37777
- 💻 **Habilidad para Claude Desktop** - Busca en la memoria desde conversaciones de Claude Desktop
- 🔒 **Control de Privacidad** - Usa etiquetas `<private>` para excluir contenido sensible del almacenamiento
- ⚙️ **Configuración de Contexto** - Control detallado sobre qué contexto se inyecta
- 🤖 **Operación Automática** - No se requiere intervención manual
- 🔗 **Citas** - Referencias a observaciones pasadas con IDs (accede vía http://localhost:37777/api/observation/{id} o visualiza todas en el visor web en http://localhost:37777)
- 🧪 **Canal Beta** - Prueba características experimentales como Endless Mode mediante cambio de versión

---

## Documentación

📚 **[Ver Documentación Completa](docs/)** - Explora documentos markdown en GitHub

### Primeros Pasos

- **[Guía de Instalación](https://docs.claude-mem.ai/installation)** - Inicio rápido e instalación avanzada
- **[Guía de Uso](https://docs.claude-mem.ai/usage/getting-started)** - Cómo funciona Claude-Mem automáticamente
- **[Herramientas de Búsqueda](https://docs.claude-mem.ai/usage/search-tools)** - Consulta el historial de tu proyecto con lenguaje natural
- **[Características Beta](https://docs.claude-mem.ai/beta-features)** - Prueba características experimentales como Endless Mode

### Mejores Prácticas

- **[Ingeniería de Contexto](https://docs.claude-mem.ai/context-engineering)** - Principios de optimización de contexto para agentes de IA
- **[Divulgación Progresiva](https://docs.claude-mem.ai/progressive-disclosure)** - Filosofía detrás de la estrategia de preparación de contexto de Claude-Mem

### Arquitectura

- **[Descripción General](https://docs.claude-mem.ai/architecture/overview)** - Componentes del sistema y flujo de datos
- **[Evolución de la Arquitectura](https://docs.claude-mem.ai/architecture-evolution)** - El viaje de v3 a v5
- **[Arquitectura de Hooks](https://docs.claude-mem.ai/hooks-architecture)** - Cómo Claude-Mem usa hooks de ciclo de vida
- **[Referencia de Hooks](https://docs.claude-mem.ai/architecture/hooks)** - 7 scripts de hooks explicados
- **[Servicio Worker](https://docs.claude-mem.ai/architecture/worker-service)** - API HTTP y gestión de Bun
- **[Base de Datos](https://docs.claude-mem.ai/architecture/database)** - Esquema SQLite y búsqueda FTS5
- **[Arquitectura de Búsqueda](https://docs.claude-mem.ai/architecture/search-architecture)** - Búsqueda híbrida con base de datos vectorial Chroma

### Configuración y Desarrollo

- **[Configuración](https://docs.claude-mem.ai/configuration)** - Variables de entorno y ajustes
- **[Desarrollo](https://docs.claude-mem.ai/development)** - Compilación, pruebas y contribución
- **[Solución de Problemas](https://docs.claude-mem.ai/troubleshooting)** - Problemas comunes y soluciones

---

## Cómo Funciona

**Componentes Principales:**

1. **5 Hooks de Ciclo de Vida** - SessionStart, UserPromptSubmit, PostToolUse, Stop, SessionEnd (6 scripts de hooks)
2. **Instalación Inteligente** - Verificador de dependencias en caché (script pre-hook, no un hook de ciclo de vida)
3. **Servicio Worker** - API HTTP en el puerto 37777 con interfaz de visor web y 10 endpoints de búsqueda, gestionado por Bun
4. **Base de Datos SQLite** - Almacena sesiones, observaciones, resúmenes
5. **Habilidad mem-search** - Consultas en lenguaje natural con divulgación progresiva
6. **Base de Datos Vectorial Chroma** - Búsqueda híbrida semántica + palabras clave para recuperación inteligente de contexto

Ver [Descripción General de la Arquitectura](https://docs.claude-mem.ai/architecture/overview) para más detalles.

---

## Habilidad mem-search

Claude-Mem proporciona búsqueda inteligente a través de la habilidad mem-search que se invoca automáticamente cuando preguntas sobre trabajo previo:

**Cómo Funciona:**
- Simplemente pregunta naturalmente: *"¿Qué hicimos en la última sesión?"* o *"¿Arreglamos este error antes?"*
- Claude invoca automáticamente la habilidad mem-search para encontrar contexto relevante

**Operaciones de Búsqueda Disponibles:**

1. **Search Observations** - Búsqueda de texto completo en observaciones
2. **Search Sessions** - Búsqueda de texto completo en resúmenes de sesiones
3. **Search Prompts** - Búsqueda de solicitudes de usuario sin procesar
4. **By Concept** - Buscar por etiquetas de concepto (discovery, problem-solution, pattern, etc.)
5. **By File** - Buscar observaciones que referencian archivos específicos
6. **By Type** - Buscar por tipo (decision, bugfix, feature, refactor, discovery, change)
7. **Recent Context** - Obtener contexto de sesión reciente para un proyecto
8. **Timeline** - Obtener línea de tiempo unificada de contexto alrededor de un punto específico en el tiempo
9. **Timeline by Query** - Buscar observaciones y obtener contexto de línea de tiempo alrededor de la mejor coincidencia
10. **API Help** - Obtener documentación de la API de búsqueda

**Ejemplos de Consultas en Lenguaje Natural:**

```
"What bugs did we fix last session?"
"How did we implement authentication?"
"What changes were made to worker-service.ts?"
"Show me recent work on this project"
"What was happening when we added the viewer UI?"
```

Ver [Guía de Herramientas de Búsqueda](https://docs.claude-mem.ai/usage/search-tools) para ejemplos detallados.

---

## Características Beta

Claude-Mem ofrece un **canal beta** con características experimentales como **Endless Mode** (arquitectura de memoria biomimética para sesiones extendidas). Cambia entre versiones estables y beta desde la interfaz del visor web en http://localhost:37777 → Settings.

Ver **[Documentación de Características Beta](https://docs.claude-mem.ai/beta-features)** para detalles sobre Endless Mode y cómo probarlo.

---

## Requisitos del Sistema

- **Node.js**: 18.0.0 o superior
- **Claude Code**: Última versión con soporte de plugins
- **Bun**: Runtime de JavaScript y gestor de procesos (se instala automáticamente si falta)
- **uv**: Gestor de paquetes de Python para búsqueda vectorial (se instala automáticamente si falta)
- **SQLite 3**: Para almacenamiento persistente (incluido)

---

## Configuración

Los ajustes se gestionan en `~/.claude-mem/settings.json` (se crea automáticamente con valores predeterminados en la primera ejecución). Configura el modelo de IA, puerto del worker, directorio de datos, nivel de registro y ajustes de inyección de contexto.

Ver la **[Guía de Configuración](https://docs.claude-mem.ai/configuration)** para todos los ajustes disponibles y ejemplos.

---

## Desarrollo

Ver la **[Guía de Desarrollo](https://docs.claude-mem.ai/development)** para instrucciones de compilación, pruebas y flujo de contribución.

---

## Solución de Problemas

Si experimentas problemas, describe el problema a Claude y la habilidad troubleshoot diagnosticará automáticamente y proporcionará soluciones.

Ver la **[Guía de Solución de Problemas](https://docs.claude-mem.ai/troubleshooting)** para problemas comunes y soluciones.

---

## Reportes de Errores

Crea reportes de errores completos con el generador automático:

```bash
cd ~/.claude/plugins/marketplaces/thedotmack
npm run bug-report
```

## Contribuciones

¡Las contribuciones son bienvenidas! Por favor:

1. Haz fork del repositorio
2. Crea una rama de característica
3. Realiza tus cambios con pruebas
4. Actualiza la documentación
5. Envía un Pull Request

Ver [Guía de Desarrollo](https://docs.claude-mem.ai/development) para el flujo de contribución.

---

## Licencia

Este proyecto está licenciado bajo la **GNU Affero General Public License v3.0** (AGPL-3.0).

Copyright (C) 2025 Alex Newman (@thedotmack). Todos los derechos reservados.

Ver el archivo [LICENSE](LICENSE) para detalles completos.

**Lo Que Esto Significa:**

- Puedes usar, modificar y distribuir este software libremente
- Si modificas y despliegas en un servidor de red, debes hacer tu código fuente disponible
- Los trabajos derivados también deben estar licenciados bajo AGPL-3.0
- NO hay GARANTÍA para este software

**Nota sobre Ragtime**: El directorio `ragtime/` está licenciado por separado bajo la **PolyForm Noncommercial License 1.0.0**. Ver [ragtime/LICENSE](ragtime/LICENSE) para detalles.

---

## Soporte

- **Documentación**: [docs/](docs/)
- **Problemas**: [GitHub Issues](https://github.com/thedotmack/claude-mem/issues)
- **Repositorio**: [github.com/thedotmack/claude-mem](https://github.com/thedotmack/claude-mem)
- **Autor**: Alex Newman ([@thedotmack](https://github.com/thedotmack))

---

**Construido con Claude Agent SDK** | **Impulsado por Claude Code** | **Hecho con TypeScript**