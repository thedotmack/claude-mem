> ## Documentation Index
> Fetch the complete documentation index at: https://code.claude.com/docs/llms.txt
> Use this file to discover all available pages before exploring further.

# Crear subagentes personalizados

> Crea y utiliza subagentes de IA especializados en Claude Code para flujos de trabajo específicos de tareas y una mejor gestión del contexto.

Los subagentes son asistentes de IA especializados que manejan tipos específicos de tareas. Cada subagente se ejecuta en su propia ventana de contexto con un prompt del sistema personalizado, acceso a herramientas específicas y permisos independientes. Cuando Claude encuentra una tarea que coincide con la descripción de un subagente, delega en ese subagente, que trabaja de forma independiente y devuelve resultados.

<Note>
  Si necesitas múltiples agentes trabajando en paralelo y comunicándose entre sí, consulta [equipos de agentes](/es/agent-teams) en su lugar. Los subagentes funcionan dentro de una única sesión; los equipos de agentes se coordinan entre sesiones separadas.
</Note>

Los subagentes te ayudan a:

* **Preservar contexto** manteniendo la exploración e implementación fuera de tu conversación principal
* **Aplicar restricciones** limitando qué herramientas puede usar un subagente
* **Reutilizar configuraciones** en proyectos con subagentes a nivel de usuario
* **Especializar comportamiento** con prompts del sistema enfocados para dominios específicos
* **Controlar costos** enrutando tareas a modelos más rápidos y económicos como Haiku

Claude usa la descripción de cada subagente para decidir cuándo delegar tareas. Cuando creas un subagente, escribe una descripción clara para que Claude sepa cuándo usarlo.

Claude Code incluye varios subagentes integrados como **Explore**, **Plan** y **general-purpose**. También puedes crear subagentes personalizados para manejar tareas específicas. Esta página cubre los [subagentes integrados](#built-in-subagents), [cómo crear los tuyos](#quickstart-create-your-first-subagent), [opciones de configuración completas](#configure-subagents), [patrones para trabajar con subagentes](#work-with-subagents) y [subagentes de ejemplo](#example-subagents).

## Built-in subagents

Claude Code incluye subagentes integrados que Claude usa automáticamente cuando es apropiado. Cada uno hereda los permisos de la conversación principal con restricciones de herramientas adicionales.

<Tabs>
  <Tab title="Explore">
    Un agente rápido y de solo lectura optimizado para buscar y analizar bases de código.

    * **Model**: Haiku (rápido, baja latencia)
    * **Tools**: Herramientas de solo lectura (acceso denegado a herramientas Write y Edit)
    * **Purpose**: Descubrimiento de archivos, búsqueda de código, exploración de base de código

    Claude delega en Explore cuando necesita buscar o entender una base de código sin hacer cambios. Esto mantiene los resultados de exploración fuera del contexto de tu conversación principal.

    Al invocar Explore, Claude especifica un nivel de exhaustividad: **quick** para búsquedas dirigidas, **medium** para exploración equilibrada, o **very thorough** para análisis exhaustivo.
  </Tab>

  <Tab title="Plan">
    Un agente de investigación utilizado durante [plan mode](/es/common-workflows#use-plan-mode-for-safe-code-analysis) para recopilar contexto antes de presentar un plan.

    * **Model**: Hereda de la conversación principal
    * **Tools**: Herramientas de solo lectura (acceso denegado a herramientas Write y Edit)
    * **Purpose**: Investigación de base de código para planificación

    Cuando estás en plan mode y Claude necesita entender tu base de código, delega la investigación al subagente Plan. Esto previene anidamiento infinito (los subagentes no pueden generar otros subagentes) mientras aún recopila el contexto necesario.
  </Tab>

  <Tab title="General-purpose">
    Un agente capaz para tareas complejas de múltiples pasos que requieren tanto exploración como acción.

    * **Model**: Hereda de la conversación principal
    * **Tools**: Todas las herramientas
    * **Purpose**: Investigación compleja, operaciones de múltiples pasos, modificaciones de código

    Claude delega en general-purpose cuando la tarea requiere tanto exploración como modificación, razonamiento complejo para interpretar resultados, o múltiples pasos dependientes.
  </Tab>

  <Tab title="Other">
    Claude Code incluye agentes auxiliares adicionales para tareas específicas. Estos generalmente se invocan automáticamente, por lo que no necesitas usarlos directamente.

    | Agent             | Model  | When Claude uses it                                              |
    | :---------------- | :----- | :--------------------------------------------------------------- |
    | Bash              | Hereda | Ejecutar comandos de terminal en un contexto separado            |
    | statusline-setup  | Sonnet | Cuando ejecutas `/statusline` para configurar tu línea de estado |
    | Claude Code Guide | Haiku  | Cuando haces preguntas sobre características de Claude Code      |
  </Tab>
</Tabs>

Más allá de estos subagentes integrados, puedes crear los tuyos propios con prompts personalizados, restricciones de herramientas, modos de permisos, hooks y skills. Las siguientes secciones muestran cómo comenzar y personalizar subagentes.

## Quickstart: create your first subagent

Los subagentes se definen en archivos Markdown con frontmatter YAML. Puedes [crearlos manualmente](#write-subagent-files) o usar el comando `/agents`.

Este tutorial te guía a través de la creación de un subagente a nivel de usuario con el comando `/agent`. El subagente revisa código y sugiere mejoras para la base de código.

<Steps>
  <Step title="Open the subagents interface">
    En Claude Code, ejecuta:

    ```
    /agents
    ```
  </Step>

  <Step title="Create a new user-level agent">
    Selecciona **Create new agent**, luego elige **User-level**. Esto guarda el subagente en `~/.claude/agents/` para que esté disponible en todos tus proyectos.
  </Step>

  <Step title="Generate with Claude">
    Selecciona **Generate with Claude**. Cuando se te solicite, describe el subagente:

    ```
    A code improvement agent that scans files and suggests improvements
    for readability, performance, and best practices. It should explain
    each issue, show the current code, and provide an improved version.
    ```

    Claude genera el prompt del sistema y la configuración. Presiona `e` para abrirlo en tu editor si deseas personalizarlo.
  </Step>

  <Step title="Select tools">
    Para un revisor de solo lectura, deselecciona todo excepto **Read-only tools**. Si mantienes todas las herramientas seleccionadas, el subagente hereda todas las herramientas disponibles para la conversación principal.
  </Step>

  <Step title="Select model">
    Elige qué modelo usa el subagente. Para este agente de ejemplo, selecciona **Sonnet**, que equilibra capacidad y velocidad para analizar patrones de código.
  </Step>

  <Step title="Choose a color">
    Elige un color de fondo para el subagente. Esto te ayuda a identificar qué subagente se está ejecutando en la interfaz de usuario.
  </Step>

  <Step title="Save and try it out">
    Guarda el subagente. Está disponible inmediatamente (no se requiere reinicio). Pruébalo:

    ```
    Use the code-improver agent to suggest improvements in this project
    ```

    Claude delega en tu nuevo subagente, que escanea la base de código y devuelve sugerencias de mejora.
  </Step>
</Steps>

Ahora tienes un subagente que puedes usar en cualquier proyecto en tu máquina para analizar bases de código y sugerir mejoras.

También puedes crear subagentes manualmente como archivos Markdown, definirlos a través de banderas CLI, o distribuirlos a través de plugins. Las siguientes secciones cubren todas las opciones de configuración.

## Configure subagents

### Use the /agents command

El comando `/agents` proporciona una interfaz interactiva para gestionar subagentes. Ejecuta `/agents` para:

* Ver todos los subagentes disponibles (integrados, usuario, proyecto y plugin)
* Crear nuevos subagentes con configuración guiada o generación de Claude
* Editar la configuración de subagentes existentes y acceso a herramientas
* Eliminar subagentes personalizados
* Ver qué subagentes están activos cuando existen duplicados

Esta es la forma recomendada de crear y gestionar subagentes. Para creación manual o automatización, también puedes agregar archivos de subagentes directamente.

### Choose the subagent scope

Los subagentes son archivos Markdown con frontmatter YAML. Guárdalos en diferentes ubicaciones según el alcance. Cuando múltiples subagentes comparten el mismo nombre, la ubicación de mayor prioridad gana.

| Location                     | Scope                           | Priority     | How to create                        |
| :--------------------------- | :------------------------------ | :----------- | :----------------------------------- |
| `--agents` CLI flag          | Sesión actual                   | 1 (más alta) | Pasar JSON al lanzar Claude Code     |
| `.claude/agents/`            | Proyecto actual                 | 2            | Interactivo o manual                 |
| `~/.claude/agents/`          | Todos tus proyectos             | 3            | Interactivo o manual                 |
| Plugin's `agents/` directory | Donde el plugin está habilitado | 4 (más baja) | Instalado con [plugins](/es/plugins) |

**Project subagents** (`.claude/agents/`) son ideales para subagentes específicos de una base de código. Verifica que estén en control de versiones para que tu equipo pueda usarlos y mejorarlos colaborativamente.

**User subagents** (`~/.claude/agents/`) son subagentes personales disponibles en todos tus proyectos.

**CLI-defined subagents** se pasan como JSON al lanzar Claude Code. Existen solo para esa sesión y no se guardan en disco, lo que los hace útiles para pruebas rápidas o scripts de automatización:

```bash  theme={null}
claude --agents '{
  "code-reviewer": {
    "description": "Expert code reviewer. Use proactively after code changes.",
    "prompt": "You are a senior code reviewer. Focus on code quality, security, and best practices.",
    "tools": ["Read", "Grep", "Glob", "Bash"],
    "model": "sonnet"
  }
}'
```

La bandera `--agents` acepta JSON con los mismos campos que [frontmatter](#supported-frontmatter-fields). Usa `prompt` para el prompt del sistema (equivalente al cuerpo markdown en subagentes basados en archivos). Consulta la [referencia CLI](/es/cli-reference#agents-flag-format) para el formato JSON completo.

**Plugin subagents** provienen de [plugins](/es/plugins) que has instalado. Aparecen en `/agents` junto a tus subagentes personalizados. Consulta la [referencia de componentes de plugins](/es/plugins-reference#agents) para detalles sobre la creación de subagentes de plugins.

### Write subagent files

Los archivos de subagentes usan frontmatter YAML para configuración, seguido del prompt del sistema en Markdown:

<Note>
  Los subagentes se cargan al inicio de la sesión. Si creas un subagente agregando manualmente un archivo, reinicia tu sesión o usa `/agents` para cargarlo inmediatamente.
</Note>

```markdown  theme={null}
---
name: code-reviewer
description: Reviews code for quality and best practices
tools: Read, Glob, Grep
model: sonnet
---

You are a code reviewer. When invoked, analyze the code and provide
specific, actionable feedback on quality, security, and best practices.
```

El frontmatter define los metadatos y configuración del subagente. El cuerpo se convierte en el prompt del sistema que guía el comportamiento del subagente. Los subagentes reciben solo este prompt del sistema (más detalles básicos del entorno como directorio de trabajo), no el prompt completo del sistema de Claude Code.

#### Supported frontmatter fields

Los siguientes campos se pueden usar en el frontmatter YAML. Solo `name` y `description` son requeridos.

| Field             | Required | Description                                                                                                                                                                                                                   |
| :---------------- | :------- | :---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`            | Yes      | Identificador único usando letras minúsculas y guiones                                                                                                                                                                        |
| `description`     | Yes      | Cuándo Claude debe delegar en este subagente                                                                                                                                                                                  |
| `tools`           | No       | [Herramientas](#available-tools) que el subagente puede usar. Hereda todas las herramientas si se omite                                                                                                                       |
| `disallowedTools` | No       | Herramientas a denegar, removidas de la lista heredada o especificada                                                                                                                                                         |
| `model`           | No       | [Modelo](#choose-a-model) a usar: `sonnet`, `opus`, `haiku`, o `inherit`. Por defecto es `inherit`                                                                                                                            |
| `permissionMode`  | No       | [Modo de permiso](#permission-modes): `default`, `acceptEdits`, `dontAsk`, `bypassPermissions`, o `plan`                                                                                                                      |
| `skills`          | No       | [Skills](/es/skills) a cargar en el contexto del subagente al inicio. El contenido completo de la skill se inyecta, no solo se pone disponible para invocación. Los subagentes no heredan skills de la conversación principal |
| `hooks`           | No       | [Lifecycle hooks](#define-hooks-for-subagents) limitados a este subagente                                                                                                                                                     |
| `memory`          | No       | [Alcance de memoria persistente](#enable-persistent-memory): `user`, `project`, o `local`. Habilita aprendizaje entre sesiones                                                                                                |

### Choose a model

El campo `model` controla qué [modelo de IA](/es/model-config) usa el subagente:

* **Model alias**: Usa uno de los alias disponibles: `sonnet`, `opus`, o `haiku`
* **inherit**: Usa el mismo modelo que la conversación principal
* **Omitted**: Si no se especifica, por defecto es `inherit` (usa el mismo modelo que la conversación principal)

### Control subagent capabilities

Puedes controlar qué pueden hacer los subagentes a través del acceso a herramientas, modos de permisos y reglas condicionales.

#### Available tools

Los subagentes pueden usar cualquiera de las [herramientas internas](/es/settings#tools-available-to-claude) de Claude Code. Por defecto, los subagentes heredan todas las herramientas de la conversación principal, incluyendo herramientas MCP.

Para restringir herramientas, usa el campo `tools` (lista blanca) o el campo `disallowedTools` (lista negra):

```yaml  theme={null}
---
name: safe-researcher
description: Research agent with restricted capabilities
tools: Read, Grep, Glob, Bash
disallowedTools: Write, Edit
---
```

#### Permission modes

El campo `permissionMode` controla cómo el subagente maneja prompts de permiso. Los subagentes heredan el contexto de permiso de la conversación principal pero pueden anular el modo.

| Mode                | Behavior                                                                                   |
| :------------------ | :----------------------------------------------------------------------------------------- |
| `default`           | Verificación de permiso estándar con prompts                                               |
| `acceptEdits`       | Auto-aceptar ediciones de archivo                                                          |
| `dontAsk`           | Auto-denegar prompts de permiso (las herramientas explícitamente permitidas aún funcionan) |
| `bypassPermissions` | Saltar todas las verificaciones de permiso                                                 |
| `plan`              | Plan mode (exploración de solo lectura)                                                    |

<Warning>
  Usa `bypassPermissions` con cuidado. Salta todas las verificaciones de permiso, permitiendo que el subagente ejecute cualquier operación sin aprobación.
</Warning>

Si el principal usa `bypassPermissions`, esto toma precedencia y no puede ser anulado.

#### Preload skills into subagents

Usa el campo `skills` para inyectar contenido de skill en el contexto de un subagente al inicio. Esto le da al subagente conocimiento de dominio sin requerir que descubra y cargue skills durante la ejecución.

```yaml  theme={null}
---
name: api-developer
description: Implement API endpoints following team conventions
skills:
  - api-conventions
  - error-handling-patterns
---

Implement API endpoints. Follow the conventions and patterns from the preloaded skills.
```

El contenido completo de cada skill se inyecta en el contexto del subagente, no solo se pone disponible para invocación. Los subagentes no heredan skills de la conversación principal; debes enumerarlas explícitamente.

<Note>
  Esto es lo inverso de [ejecutar una skill en un subagente](/es/skills#run-skills-in-a-subagent). Con `skills` en un subagente, el subagente controla el prompt del sistema y carga contenido de skill. Con `context: fork` en una skill, el contenido de la skill se inyecta en el agente que especifiques. Ambos usan el mismo sistema subyacente.
</Note>

#### Enable persistent memory

El campo `memory` le da al subagente un directorio persistente que sobrevive entre conversaciones. El subagente usa este directorio para acumular conocimiento con el tiempo, como patrones de base de código, insights de depuración y decisiones arquitectónicas.

```yaml  theme={null}
---
name: code-reviewer
description: Reviews code for quality and best practices
memory: user
---

You are a code reviewer. As you review code, update your agent memory with
patterns, conventions, and recurring issues you discover.
```

Elige un alcance basado en qué tan ampliamente debe aplicarse la memoria:

| Scope     | Location                                      | Use when                                                                                                  |
| :-------- | :-------------------------------------------- | :-------------------------------------------------------------------------------------------------------- |
| `user`    | `~/.claude/agent-memory/<name-of-agent>/`     | el subagente debe recordar aprendizajes en todos los proyectos                                            |
| `project` | `.claude/agent-memory/<name-of-agent>/`       | el conocimiento del subagente es específico del proyecto y compartible a través de control de versiones   |
| `local`   | `.claude/agent-memory-local/<name-of-agent>/` | el conocimiento del subagente es específico del proyecto pero no debe verificarse en control de versiones |

Cuando la memoria está habilitada:

* El prompt del sistema del subagente incluye instrucciones para leer y escribir en el directorio de memoria.
* El prompt del sistema del subagente también incluye las primeras 200 líneas de `MEMORY.md` en el directorio de memoria, con instrucciones para curar `MEMORY.md` si excede 200 líneas.
* Las herramientas Read, Write y Edit se habilitan automáticamente para que el subagente pueda gestionar sus archivos de memoria.

##### Persistent memory tips

* `user` es el alcance recomendado por defecto. Usa `project` o `local` cuando el conocimiento del subagente es solo relevante para una base de código específica.
* Pide al subagente que consulte su memoria antes de comenzar el trabajo: "Review this PR, and check your memory for patterns you've seen before."
* Pide al subagente que actualice su memoria después de completar una tarea: "Now that you're done, save what you learned to your memory." Con el tiempo, esto construye una base de conocimiento que hace que el subagente sea más efectivo.
* Incluye instrucciones de memoria directamente en el archivo markdown del subagente para que mantenga proactivamente su propia base de conocimiento:

  ```markdown  theme={null}
  Update your agent memory as you discover codepaths, patterns, library
  locations, and key architectural decisions. This builds up institutional
  knowledge across conversations. Write concise notes about what you found
  and where.
  ```

#### Conditional rules with hooks

Para un control más dinámico sobre el uso de herramientas, usa hooks `PreToolUse` para validar operaciones antes de que se ejecuten. Esto es útil cuando necesitas permitir algunas operaciones de una herramienta mientras bloqueas otras.

Este ejemplo crea un subagente que solo permite consultas de base de datos de solo lectura. El hook `PreToolUse` ejecuta el script especificado en `command` antes de que se ejecute cada comando Bash:

```yaml  theme={null}
---
name: db-reader
description: Execute read-only database queries
tools: Bash
hooks:
  PreToolUse:
    - matcher: "Bash"
      hooks:
        - type: command
          command: "./scripts/validate-readonly-query.sh"
---
```

Claude Code [pasa entrada de hook como JSON](/es/hooks#pretooluse-input) a través de stdin a comandos de hook. El script de validación lee este JSON, extrae el comando Bash, y [sale con código 2](/es/hooks#exit-code-2-behavior-per-event) para bloquear operaciones de escritura:

```bash  theme={null}
#!/bin/bash
# ./scripts/validate-readonly-query.sh

INPUT=$(cat)
COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // empty')

# Block SQL write operations (case-insensitive)
if echo "$COMMAND" | grep -iE '\b(INSERT|UPDATE|DELETE|DROP|CREATE|ALTER|TRUNCATE)\b' > /dev/null; then
  echo "Blocked: Only SELECT queries are allowed" >&2
  exit 2
fi

exit 0
```

Consulta [Hook input](/es/hooks#pretooluse-input) para el esquema de entrada completo y [exit codes](/es/hooks#exit-code-output) para cómo los códigos de salida afectan el comportamiento.

#### Disable specific subagents

Puedes prevenir que Claude use subagentes específicos agregándolos al array `deny` en tu [settings](/es/settings#permission-settings). Usa el formato `Task(subagent-name)` donde `subagent-name` coincide con el campo name del subagente.

```json  theme={null}
{
  "permissions": {
    "deny": ["Task(Explore)", "Task(my-custom-agent)"]
  }
}
```

Esto funciona para subagentes integrados y personalizados. También puedes usar la bandera CLI `--disallowedTools`:

```bash  theme={null}
claude --disallowedTools "Task(Explore)"
```

Consulta [Documentación de Permisos](/es/permissions#tool-specific-permission-rules) para más detalles sobre reglas de permisos.

### Define hooks for subagents

Los subagentes pueden definir [hooks](/es/hooks) que se ejecutan durante el ciclo de vida del subagente. Hay dos formas de configurar hooks:

1. **En el frontmatter del subagente**: Define hooks que se ejecutan solo mientras ese subagente está activo
2. **En `settings.json`**: Define hooks que se ejecutan en la sesión principal cuando los subagentes comienzan o se detienen

#### Hooks in subagent frontmatter

Define hooks directamente en el archivo markdown del subagente. Estos hooks solo se ejecutan mientras ese subagente específico está activo y se limpian cuando termina.

Todos los [eventos de hook](/es/hooks#hook-events) son soportados. Los eventos más comunes para subagentes son:

| Event         | Matcher input         | When it fires                                                                    |
| :------------ | :-------------------- | :------------------------------------------------------------------------------- |
| `PreToolUse`  | Nombre de herramienta | Antes de que el subagente use una herramienta                                    |
| `PostToolUse` | Nombre de herramienta | Después de que el subagente usa una herramienta                                  |
| `Stop`        | (ninguno)             | Cuando el subagente termina (convertido a `SubagentStop` en tiempo de ejecución) |

Este ejemplo valida comandos Bash con el hook `PreToolUse` y ejecuta un linter después de ediciones de archivo con `PostToolUse`:

```yaml  theme={null}
---
name: code-reviewer
description: Review code changes with automatic linting
hooks:
  PreToolUse:
    - matcher: "Bash"
      hooks:
        - type: command
          command: "./scripts/validate-command.sh $TOOL_INPUT"
  PostToolUse:
    - matcher: "Edit|Write"
      hooks:
        - type: command
          command: "./scripts/run-linter.sh"
---
```

Los hooks `Stop` en frontmatter se convierten automáticamente a eventos `SubagentStop`.

#### Project-level hooks for subagent events

Configura hooks en `settings.json` que respondan a eventos del ciclo de vida del subagente en la sesión principal.

| Event           | Matcher input            | When it fires                             |
| :-------------- | :----------------------- | :---------------------------------------- |
| `SubagentStart` | Nombre de tipo de agente | Cuando un subagente comienza la ejecución |
| `SubagentStop`  | (ninguno)                | Cuando cualquier subagente se completa    |

`SubagentStart` soporta matchers para dirigirse a tipos de agentes específicos por nombre. `SubagentStop` se dispara para todas las completaciones de subagentes independientemente de los valores del matcher. Este ejemplo ejecuta un script de configuración solo cuando el subagente `db-agent` comienza, y un script de limpieza cuando cualquier subagente se detiene:

```json  theme={null}
{
  "hooks": {
    "SubagentStart": [
      {
        "matcher": "db-agent",
        "hooks": [
          { "type": "command", "command": "./scripts/setup-db-connection.sh" }
        ]
      }
    ],
    "SubagentStop": [
      {
        "hooks": [
          { "type": "command", "command": "./scripts/cleanup-db-connection.sh" }
        ]
      }
    ]
  }
}
```

Consulta [Hooks](/es/hooks) para el formato de configuración de hook completo.

## Work with subagents

### Understand automatic delegation

Claude delega automáticamente tareas basadas en la descripción de la tarea en tu solicitud, el campo `description` en configuraciones de subagentes, y contexto actual. Para alentar delegación proactiva, incluye frases como "use proactively" en el campo description de tu subagente.

También puedes solicitar un subagente específico explícitamente:

```
Use the test-runner subagent to fix failing tests
Have the code-reviewer subagent look at my recent changes
```

### Run subagents in foreground or background

Los subagentes pueden ejecutarse en primer plano (bloqueante) o fondo (concurrente):

* **Foreground subagents** bloquean la conversación principal hasta completarse. Los prompts de permiso y preguntas aclaratorias (como [`AskUserQuestion`](/es/settings#tools-available-to-claude)) se pasan a través hacia ti.
* **Background subagents** se ejecutan concurrentemente mientras continúas trabajando. Antes de lanzar, Claude Code solicita cualquier permiso de herramienta que el subagente necesitará, asegurando que tenga las aprobaciones necesarias por adelantado. Una vez en ejecución, el subagente hereda estos permisos y auto-deniega cualquier cosa no pre-aprobada. Si un subagente de fondo necesita hacer preguntas aclaratorias, esa llamada de herramienta falla pero el subagente continúa. Las herramientas MCP no están disponibles en subagentes de fondo.

Si un subagente de fondo falla debido a permisos faltantes, puedes [reanudarlo](#resume-subagents) en primer plano para reintentar con prompts interactivos.

Claude decide si ejecutar subagentes en primer plano o fondo basado en la tarea. También puedes:

* Pedir a Claude que "run this in the background"
* Presionar **Ctrl+B** para poner en fondo una tarea en ejecución

Para deshabilitar toda la funcionalidad de tareas de fondo, establece la variable de entorno `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS` a `1`. Consulta [Variables de entorno](/es/settings#environment-variables).

### Common patterns

#### Isolate high-volume operations

Uno de los usos más efectivos para subagentes es aislar operaciones que producen grandes cantidades de salida. Ejecutar pruebas, obtener documentación, o procesar archivos de registro puede consumir contexto significativo. Al delegar estos a un subagente, la salida detallada permanece en el contexto del subagente mientras solo el resumen relevante regresa a tu conversación principal.

```
Use a subagent to run the test suite and report only the failing tests with their error messages
```

#### Run parallel research

Para investigaciones independientes, genera múltiples subagentes para trabajar simultáneamente:

```
Research the authentication, database, and API modules in parallel using separate subagents
```

Cada subagente explora su área independientemente, luego Claude sintetiza los hallazgos. Esto funciona mejor cuando las rutas de investigación no dependen una de la otra.

<Warning>
  Cuando los subagentes se completan, sus resultados regresan a tu conversación principal. Ejecutar muchos subagentes que cada uno devuelve resultados detallados puede consumir contexto significativo.
</Warning>

Para tareas que necesitan paralelismo sostenido o exceden tu ventana de contexto, [equipos de agentes](/es/agent-teams) le dan a cada trabajador su propio contexto independiente.

#### Chain subagents

Para flujos de trabajo de múltiples pasos, pide a Claude que use subagentes en secuencia. Cada subagente completa su tarea y devuelve resultados a Claude, que luego pasa contexto relevante al siguiente subagente.

```
Use the code-reviewer subagent to find performance issues, then use the optimizer subagent to fix them
```

### Choose between subagents and main conversation

Usa la **conversación principal** cuando:

* La tarea necesita frecuente ida y vuelta o refinamiento iterativo
* Múltiples fases comparten contexto significativo (planificación → implementación → prueba)
* Estás haciendo un cambio rápido y dirigido
* La latencia importa. Los subagentes comienzan frescos y pueden necesitar tiempo para recopilar contexto

Usa **subagentes** cuando:

* La tarea produce salida detallada que no necesitas en tu contexto principal
* Quieres aplicar restricciones de herramientas o permisos específicos
* El trabajo es autónomo y puede devolver un resumen

Considera [Skills](/es/skills) en su lugar cuando quieras prompts o flujos de trabajo reutilizables que se ejecuten en el contexto de conversación principal en lugar de contexto de subagente aislado.

<Note>
  Los subagentes no pueden generar otros subagentes. Si tu flujo de trabajo requiere delegación anidada, usa [Skills](/es/skills) o [encadena subagentes](#chain-subagents) desde la conversación principal.
</Note>

### Manage subagent context

#### Resume subagents

Cada invocación de subagente crea una nueva instancia con contexto fresco. Para continuar el trabajo de un subagente existente en lugar de comenzar de nuevo, pide a Claude que lo reanude.

Los subagentes reanudados retienen su historial de conversación completo, incluyendo todas las llamadas de herramienta anteriores, resultados y razonamiento. El subagente continúa exactamente donde se detuvo en lugar de comenzar de nuevo.

Cuando un subagente se completa, Claude recibe su ID de agente. Para reanudar un subagente, pide a Claude que continúe el trabajo anterior:

```
Use the code-reviewer subagent to review the authentication module
[Agent completes]

Continue that code review and now analyze the authorization logic
[Claude resumes the subagent with full context from previous conversation]
```

También puedes pedir a Claude el ID del agente si quieres referenciarlo explícitamente, o encontrar IDs en los archivos de transcripción en `~/.claude/projects/{project}/{sessionId}/subagents/`. Cada transcripción se almacena como `agent-{agentId}.jsonl`.

Las transcripciones de subagentes persisten independientemente de la conversación principal:

* **Compactación de conversación principal**: Cuando la conversación principal se compacta, las transcripciones de subagentes no se ven afectadas. Se almacenan en archivos separados.
* **Persistencia de sesión**: Las transcripciones de subagentes persisten dentro de su sesión. Puedes [reanudar un subagente](#resume-subagents) después de reiniciar Claude Code reanudando la misma sesión.
* **Limpieza automática**: Las transcripciones se limpian basadas en la configuración `cleanupPeriodDays` (por defecto: 30 días).

#### Auto-compaction

Los subagentes soportan compactación automática usando la misma lógica que la conversación principal. Por defecto, la compactación automática se dispara aproximadamente al 95% de capacidad. Para disparar compactación más temprano, establece `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` a un porcentaje más bajo (por ejemplo, `50`). Consulta [variables de entorno](/es/settings#environment-variables) para detalles.

Los eventos de compactación se registran en archivos de transcripción de subagentes:

```json  theme={null}
{
  "type": "system",
  "subtype": "compact_boundary",
  "compactMetadata": {
    "trigger": "auto",
    "preTokens": 167189
  }
}
```

El valor `preTokens` muestra cuántos tokens se usaron antes de que ocurriera la compactación.

## Example subagents

Estos ejemplos demuestran patrones efectivos para construir subagentes. Úsalos como puntos de partida, o genera una versión personalizada con Claude.

<Tip>
  **Best practices:**

  * **Design focused subagents:** cada subagente debe sobresalir en una tarea específica
  * **Write detailed descriptions:** Claude usa la descripción para decidir cuándo delegar
  * **Limit tool access:** otorga solo permisos necesarios para seguridad y enfoque
  * **Check into version control:** comparte subagentes de proyecto con tu equipo
</Tip>

### Code reviewer

Un subagente de solo lectura que revisa código sin modificarlo. Este ejemplo muestra cómo diseñar un subagente enfocado con acceso limitado a herramientas (sin Edit o Write) y un prompt detallado que especifica exactamente qué buscar y cómo formatear la salida.

```markdown  theme={null}
---
name: code-reviewer
description: Expert code review specialist. Proactively reviews code for quality, security, and maintainability. Use immediately after writing or modifying code.
tools: Read, Grep, Glob, Bash
model: inherit
---

You are a senior code reviewer ensuring high standards of code quality and security.

When invoked:
1. Run git diff to see recent changes
2. Focus on modified files
3. Begin review immediately

Review checklist:
- Code is clear and readable
- Functions and variables are well-named
- No duplicated code
- Proper error handling
- No exposed secrets or API keys
- Input validation implemented
- Good test coverage
- Performance considerations addressed

Provide feedback organized by priority:
- Critical issues (must fix)
- Warnings (should fix)
- Suggestions (consider improving)

Include specific examples of how to fix issues.
```

### Debugger

Un subagente que puede tanto analizar como arreglar problemas. A diferencia del revisor de código, este incluye Edit porque arreglar bugs requiere modificar código. El prompt proporciona un flujo de trabajo claro desde diagnóstico hasta verificación.

```markdown  theme={null}
---
name: debugger
description: Debugging specialist for errors, test failures, and unexpected behavior. Use proactively when encountering any issues.
tools: Read, Edit, Bash, Grep, Glob
---

You are an expert debugger specializing in root cause analysis.

When invoked:
1. Capture error message and stack trace
2. Identify reproduction steps
3. Isolate the failure location
4. Implement minimal fix
5. Verify solution works

Debugging process:
- Analyze error messages and logs
- Check recent code changes
- Form and test hypotheses
- Add strategic debug logging
- Inspect variable states

For each issue, provide:
- Root cause explanation
- Evidence supporting the diagnosis
- Specific code fix
- Testing approach
- Prevention recommendations

Focus on fixing the underlying issue, not the symptoms.
```

### Data scientist

Un subagente específico de dominio para trabajo de análisis de datos. Este ejemplo muestra cómo crear subagentes para flujos de trabajo especializados fuera de tareas de codificación típicas. Explícitamente establece `model: sonnet` para análisis más capaz.

```markdown  theme={null}
---
name: data-scientist
description: Data analysis expert for SQL queries, BigQuery operations, and data insights. Use proactively for data analysis tasks and queries.
tools: Bash, Read, Write
model: sonnet
---

You are a data scientist specializing in SQL and BigQuery analysis.

When invoked:
1. Understand the data analysis requirement
2. Write efficient SQL queries
3. Use BigQuery command line tools (bq) when appropriate
4. Analyze and summarize results
5. Present findings clearly

Key practices:
- Write optimized SQL queries with proper filters
- Use appropriate aggregations and joins
- Include comments explaining complex logic
- Format results for readability
- Provide data-driven recommendations

For each analysis:
- Explain the query approach
- Document any assumptions
- Highlight key findings
- Suggest next steps based on data

Always ensure queries are efficient and cost-effective.
```

### Database query validator

Un subagente que permite acceso Bash pero valida comandos para permitir solo consultas SQL de solo lectura. Este ejemplo muestra cómo usar hooks `PreToolUse` para validación condicional cuando necesitas control más fino que el campo `tools` proporciona.

```markdown  theme={null}
---
name: db-reader
description: Execute read-only database queries. Use when analyzing data or generating reports.
tools: Bash
hooks:
  PreToolUse:
    - matcher: "Bash"
      hooks:
        - type: command
          command: "./scripts/validate-readonly-query.sh"
---

You are a database analyst with read-only access. Execute SELECT queries to answer questions about the data.

When asked to analyze data:
1. Identify which tables contain the relevant data
2. Write efficient SELECT queries with appropriate filters
3. Present results clearly with context

You cannot modify data. If asked to INSERT, UPDATE, DELETE, or modify schema, explain that you only have read access.
```

Claude Code [pasa entrada de hook como JSON](/es/hooks#pretooluse-input) a través de stdin a comandos de hook. El script de validación lee este JSON, extrae el comando siendo ejecutado, y lo verifica contra una lista de operaciones de escritura SQL. Si se detecta una operación de escritura, el script [sale con código 2](/es/hooks#exit-code-2-behavior-per-event) para bloquear la ejecución y devuelve un mensaje de error a Claude a través de stderr.

Crea el script de validación en cualquier lugar en tu proyecto. La ruta debe coincidir con el campo `command` en tu configuración de hook:

```bash  theme={null}
#!/bin/bash
# Blocks SQL write operations, allows SELECT queries

# Read JSON input from stdin
INPUT=$(cat)

# Extract the command field from tool_input using jq
COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // empty')

if [ -z "$COMMAND" ]; then
  exit 0
fi

# Block write operations (case-insensitive)
if echo "$COMMAND" | grep -iE '\b(INSERT|UPDATE|DELETE|DROP|CREATE|ALTER|TRUNCATE|REPLACE|MERGE)\b' > /dev/null; then
  echo "Blocked: Write operations not allowed. Use SELECT queries only." >&2
  exit 2
fi

exit 0
```

Haz el script ejecutable:

```bash  theme={null}
chmod +x ./scripts/validate-readonly-query.sh
```

El hook recibe JSON a través de stdin con el comando Bash en `tool_input.command`. El código de salida 2 bloquea la operación y alimenta el mensaje de error de vuelta a Claude. Consulta [Hooks](/es/hooks#exit-code-output) para detalles sobre códigos de salida y [Hook input](/es/hooks#pretooluse-input) para el esquema de entrada completo.

## Next steps

Ahora que entiendes subagentes, explora estas características relacionadas:

* [Distribuir subagentes con plugins](/es/plugins) para compartir subagentes entre equipos o proyectos
* [Ejecutar Claude Code programáticamente](/es/headless) con el Agent SDK para CI/CD y automatización
* [Usar servidores MCP](/es/mcp) para dar a los subagentes acceso a herramientas externas y datos
