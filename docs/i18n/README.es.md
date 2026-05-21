🌐 Esta es una traducción mantenida por la comunidad. ¡Las correcciones son bienvenidas!

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

**Languages:** [English](../../README.md) · [中文](./README.zh.md) · [Español](./README.es.md) · [Français](./README.fr.md) · [Português](./README.pt-br.md) · [Русский](./README.ru.md) · [Deutsch](./README.de.md)

<h4 align="center">Sistema de compresión de memoria persistente creado para <a href="https://claude.com/claude-code" target="_blank">Claude Code</a>.</h4>

<p align="center">
  <a href="LICENSE">
    <img src="https://img.shields.io/badge/License-Apache%202.0-blue.svg" alt="License">
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

<table align="center">
  <tr>
    <td align="center">
      <a href="https://github.com/thedotmack/claude-mem">
        <picture>
          <img
            src="https://raw.githubusercontent.com/thedotmack/claude-mem/main/docs/public/cm-preview.gif"
            alt="Claude-Mem Preview"
            width="500"
          >
        </picture>
      </a>
    </td>
    <td align="center">
      <a href="https://www.star-history.com/#thedotmack/claude-mem&Date">
        <picture>
          <source
            media="(prefers-color-scheme: dark)"
            srcset="https://api.star-history.com/image?repos=thedotmack/claude-mem&type=date&theme=dark&legend=top-left"
          />
          <source
            media="(prefers-color-scheme: light)"
            srcset="https://api.star-history.com/image?repos=thedotmack/claude-mem&type=date&legend=top-left"
          />
          <img
            alt="Star History Chart"
            src="https://api.star-history.com/image?repos=thedotmack/claude-mem&type=date&legend=top-left"
            width="500"
          />
        </picture>
      </a>
    </td>
  </tr>
</table>

<p align="center">
  <a href="#quick-start">Inicio rápido</a> •
  <a href="#how-it-works">Cómo funciona</a> •
  <a href="#mcp-search-tools">Herramientas de búsqueda</a> •
  <a href="#documentation">Documentación</a> •
  <a href="#configuration">Configuración</a> •
  <a href="#troubleshooting">Solución de problemas</a> •
  <a href="#license">Licencia</a>
</p>

<p align="center">
  Claude-Mem preserva sin problemas el contexto entre sesiones al capturar automáticamente observaciones del uso de herramientas, generar resúmenes semánticos y ponerlos a disposición de sesiones futuras. Esto permite que Claude mantenga la continuidad del conocimiento sobre proyectos incluso después de que las sesiones terminen o se reconecten.
</p>

---

## Inicio rápido

Instale con un solo comando:

```bash
npx claude-mem install
```

O instale para Gemini CLI (detecta automáticamente `~/.gemini`):

```bash
npx claude-mem install --ide gemini-cli
```
O instale para OpenCode:

```bash
npx claude-mem install --ide opencode
```

O instale desde el marketplace de plugins dentro de Claude Code:

```bash
/plugin marketplace add thedotmack/claude-mem

/plugin install claude-mem
```

Reinicie Claude Code o Gemini CLI. El contexto de sesiones anteriores aparecerá automáticamente en las nuevas sesiones.

> **Nota:** Claude-Mem también está publicado en npm, pero `npm install -g claude-mem` instala **solo el SDK/biblioteca** — no registra los hooks del plugin ni configura el servicio worker. Instale siempre con `npx claude-mem install` o los comandos `/plugin` anteriores.

### 🦞 OpenClaw Gateway

Instale claude-mem como plugin de memoria persistente en gateways de [OpenClaw](https://openclaw.ai) con un solo comando:

```bash
curl -fsSL https://install.cmem.ai/openclaw.sh | bash
```

El instalador gestiona dependencias, configuración del plugin, proveedor de IA, inicio del worker y feeds opcionales de observación en tiempo real a Telegram, Discord, Slack y más. Consulte la [Guía de integración de OpenClaw](https://docs.claude-mem.ai/openclaw-integration) para más detalles.

**Características principales:**

- 🧠 **Memoria persistente** - El contexto sobrevive entre sesiones
- 📊 **Divulgación progresiva** - Recuperación de memoria por capas con visibilidad del costo en tokens
- 🔍 **Búsqueda basada en skills** - Consulte el historial del proyecto con la skill mem-search
- 🖥️ **Interfaz web** - Flujo de memoria en tiempo real en http://localhost:37777
- 💻 **Skill de Claude Desktop** - Busque en la memoria desde conversaciones de Claude Desktop
- 🔒 **Control de privacidad** - Use etiquetas `<private>` para excluir contenido sensible del almacenamiento
- ⚙️ **Configuración de contexto** - Control detallado sobre qué contexto se inyecta
- 🤖 **Funcionamiento automático** - No requiere intervención manual
- 🔗 **Citas** - Referencie observaciones anteriores por ID (acceda vía http://localhost:37777/api/observation/{id} o vea todas en la interfaz web en http://localhost:37777)
- 🧪 **Canal beta** - Pruebe funciones experimentales como Endless Mode cambiando de versión

---

## Documentación

📚 **[Ver documentación completa](https://docs.claude-mem.ai/)** - Explore en el sitio oficial

### Primeros pasos

- **[Guía de instalación](https://docs.claude-mem.ai/installation)** - Inicio rápido e instalación avanzada
- **[Configuración de Gemini CLI](https://docs.claude-mem.ai/gemini-cli/setup)** - Guía dedicada para la integración con Gemini CLI de Google
- **[Guía de uso](https://docs.claude-mem.ai/usage/getting-started)** - Cómo funciona Claude-Mem automáticamente
- **[Herramientas de búsqueda](https://docs.claude-mem.ai/usage/search-tools)** - Consulte el historial del proyecto con lenguaje natural
- **[Funciones beta](https://docs.claude-mem.ai/beta-features)** - Pruebe funciones experimentales como Endless Mode

### Buenas prácticas

- **[Ingeniería de contexto](https://docs.claude-mem.ai/context-engineering)** - Principios de optimización del contexto de agentes de IA
- **[Divulgación progresiva](https://docs.claude-mem.ai/progressive-disclosure)** - Filosofía detrás de la estrategia de preparación de contexto de Claude-Mem

### Arquitectura

- **[Visión general](https://docs.claude-mem.ai/architecture/overview)** - Componentes del sistema y flujo de datos
- **[Evolución de la arquitectura](https://docs.claude-mem.ai/architecture-evolution)** - El camino de v3 a v5
- **[Arquitectura de hooks](https://docs.claude-mem.ai/hooks-architecture)** - Cómo Claude-Mem usa hooks del ciclo de vida
- **[Referencia de hooks](https://docs.claude-mem.ai/architecture/hooks)** - Explicación de 7 scripts de hooks
- **[Servicio worker](https://docs.claude-mem.ai/architecture/worker-service)** - API HTTP y gestión con Bun
- **[Base de datos](https://docs.claude-mem.ai/architecture/database)** - Esquema SQLite y búsqueda FTS5
- **[Arquitectura de búsqueda](https://docs.claude-mem.ai/architecture/search-architecture)** - Búsqueda híbrida con base de datos vectorial Chroma

### Configuración y desarrollo

- **[Configuración](https://docs.claude-mem.ai/configuration)** - Variables de entorno y ajustes
- **[Desarrollo](https://docs.claude-mem.ai/development)** - Compilación, pruebas y contribución
- **[Solución de problemas](https://docs.claude-mem.ai/troubleshooting)** - Problemas comunes y soluciones

---

## Cómo funciona

**Componentes principales:**

1. **5 hooks del ciclo de vida** - SessionStart, UserPromptSubmit, PostToolUse, Stop, SessionEnd (6 scripts de hooks)
2. **Smart Install** - Comprobador de dependencias en caché (script pre-hook, no es un hook del ciclo de vida)
3. **Servicio worker** - API HTTP en el puerto 37777 con interfaz web y 10 endpoints de búsqueda, gestionado por Bun
4. **Base de datos SQLite** - Almacena sesiones, observaciones y resúmenes
5. **Skill mem-search** - Consultas en lenguaje natural con divulgación progresiva
6. **Base de datos vectorial Chroma** - Búsqueda híbrida semántica + por palabras clave para recuperación inteligente de contexto

Consulte la [Visión general de arquitectura](https://docs.claude-mem.ai/architecture/overview) para más detalles.

---

## Herramientas de búsqueda MCP

Claude-Mem ofrece búsqueda inteligente de memoria mediante **4 herramientas MCP** siguiendo un **patrón de flujo de trabajo de 3 capas** eficiente en tokens:

**Flujo de trabajo de 3 capas:**

1. **`search`** - Obtenga un índice compacto con IDs (~50-100 tokens/resultado)
2. **`timeline`** - Obtenga contexto cronológico alrededor de resultados interesantes
3. **`get_observations`** - Obtenga detalles completos SOLO para IDs filtrados (~500-1,000 tokens/resultado)

**Cómo funciona:**
- Claude usa herramientas MCP para buscar en su memoria
- Comience con `search` para obtener un índice de resultados
- Use `timeline` para ver qué ocurría alrededor de observaciones específicas
- Use `get_observations` para obtener detalles completos de IDs relevantes
- **~10x ahorro de tokens** al filtrar antes de obtener detalles

**Herramientas MCP disponibles:**

1. **`search`** - Busque en el índice de memoria con consultas de texto completo, filtros por tipo/fecha/proyecto
2. **`timeline`** - Obtenga contexto cronológico alrededor de una observación o consulta específica
3. **`get_observations`** - Obtenga detalles completos de observaciones por IDs (siempre agrupe varios IDs)

**Ejemplo de uso:**

```typescript
// Step 1: Search for index
search(query="authentication bug", type="bugfix", limit=10)

// Step 2: Review index, identify relevant IDs (e.g., #123, #456)

// Step 3: Fetch full details
get_observations(ids=[123, 456])
```

Consulte la [Guía de herramientas de búsqueda](https://docs.claude-mem.ai/usage/search-tools) para ejemplos detallados.

---

## Funciones beta

Claude-Mem ofrece un **canal beta** con funciones experimentales como **Endless Mode** (arquitectura de memoria biomimética para sesiones extendidas). Cambie entre versiones estable y beta desde la interfaz web en http://localhost:37777 → Settings.

Consulte la **[Documentación de funciones beta](https://docs.claude-mem.ai/beta-features)** para detalles sobre Endless Mode y cómo probarlo.

---

## Requisitos del sistema

- **Node.js**: 18.0.0 o superior
- **Claude Code**: Última versión con soporte de plugins
- **Bun**: Runtime y gestor de procesos JavaScript (se instala automáticamente si falta)
- **uv**: Gestor de paquetes Python para búsqueda vectorial (se instala automáticamente si falta)
- **SQLite 3**: Para almacenamiento persistente (incluido)

---
### Notas de instalación en Windows

Si ve un error como:

```powershell
npm : The term 'npm' is not recognized as the name of a cmdlet
```

Asegúrese de que Node.js y npm estén instalados y agregados a su PATH. Descargue el instalador más reciente de Node.js desde https://nodejs.org y reinicie su terminal después de la instalación.

---

## Configuración

Los ajustes se gestionan en `~/.claude-mem/settings.json` (se crea automáticamente con valores predeterminados en la primera ejecución). Configure el modelo de IA, puerto del worker, directorio de datos, nivel de registro y ajustes de inyección de contexto.

Consulte la **[Guía de configuración](https://docs.claude-mem.ai/configuration)** para todos los ajustes disponibles y ejemplos.

### Configuración de modo e idioma

Claude-Mem admite múltiples modos de flujo de trabajo e idiomas mediante el ajuste `CLAUDE_MEM_MODE`.

Esta opción controla ambos:
- El comportamiento del flujo de trabajo (p. ej. code, chill, investigation)
- El idioma usado en las observaciones generadas

#### Cómo configurar

Edite su archivo de ajustes en `~/.claude-mem/settings.json`:

```json
{
  "CLAUDE_MEM_MODE": "code--zh"
}
```

Los modos se definen en `plugin/modes/`. Para ver todos los modos disponibles localmente:

```bash
ls ~/.claude/plugins/marketplaces/thedotmack/plugin/modes/
```

#### Modos disponibles

| Modo | Descripción |
|------------|-------------------------|
| `code` | Modo predeterminado en inglés |
| `code--zh` | Modo de chino simplificado |
| `code--ja` | Modo de japonés |

Los modos específicos de idioma siguen el patrón `code--[lang]`, donde `[lang]` es el código de idioma ISO 639-1 (p. ej., `zh` para chino, `ja` para japonés, `es` para español).

> Nota: `code--zh` (chino simplificado) ya está integrado — no se requiere instalación adicional ni actualización del plugin.

#### Después de cambiar el modo

Reinicie Claude Code para aplicar la nueva configuración de modo.
---

## Desarrollo

Consulte la **[Guía de desarrollo](https://docs.claude-mem.ai/development)** para instrucciones de compilación, pruebas y flujo de contribución.

---

## Solución de problemas

Si experimenta problemas, describa el problema a Claude y la skill troubleshoot diagnosticará automáticamente y proporcionará soluciones.

Consulte la **[Guía de solución de problemas](https://docs.claude-mem.ai/troubleshooting)** para problemas comunes y soluciones.

---

## Informes de errores

Cree informes de errores completos con el generador automatizado:

```bash
cd ~/.claude/plugins/marketplaces/thedotmack
npm run bug-report
```

## Contribuir

¡Las contribuciones son bienvenidas! Por favor:

1. Haga fork del repositorio
2. Cree una rama de funcionalidad
3. Realice sus cambios con pruebas
4. Actualice la documentación
5. Envíe un Pull Request

Consulte la [Guía de desarrollo](https://docs.claude-mem.ai/development) para el flujo de contribución.

---

## Licencia

Claude-Mem está licenciado bajo Apache License 2.0.

Elegimos Apache-2.0 porque la memoria persistente de agentes debe ser fácil de integrar en
herramientas para desarrolladores, agentes locales, servidores MCP, sistemas empresariales, stacks de robótica,
y frameworks de agentes en producción.

Consulte el archivo [LICENSE](LICENSE) para detalles completos. Consulte [docs/license.md](docs/license.md)
y [docs/ip-boundary.md](docs/ip-boundary.md) para el alcance de la licencia y el
límite open/comercial.

**Nota sobre Ragtime**: El directorio `ragtime/` está licenciado bajo **Apache License 2.0**. Consulte [ragtime/LICENSE](ragtime/LICENSE) para más detalles.

---

## Soporte

- **Documentación**: [docs/](docs/)
- **Incidencias**: [GitHub Issues](https://github.com/thedotmack/claude-mem/issues)
- **Repositorio**: [github.com/thedotmack/claude-mem](https://github.com/thedotmack/claude-mem)
- **Cuenta oficial de X**: [@Claude_Memory](https://x.com/Claude_Memory)
- **Discord oficial**: [Unirse a Discord](https://discord.com/invite/J4wttp9vDu)
- **Autor**: Alex Newman ([@thedotmack](https://github.com/thedotmack))

---

**Creado con Claude Agent SDK** | **Compatible con Claude Code** | **Hecho con TypeScript**

---

### ¿Qué hay de $CMEM?

$CMEM es un token de Solana creado por un tercero sin el consentimiento previo de Claude-Mem, pero adoptado oficialmente por el creador de Claude-Mem (Alex Newman, @thedotmack). El token actúa como catalizador comunitario para el crecimiento y como vehículo para llevar datos de agentes en tiempo real a los desarrolladores y trabajadores del conocimiento que más los necesitan. $CMEM: 2TsmuYUrsctE57VLckZBYEEzdokUF8j8e1GavekWBAGS
