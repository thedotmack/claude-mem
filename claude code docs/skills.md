> ## Documentation Index
> Fetch the complete documentation index at: https://code.claude.com/docs/llms.txt
> Use this file to discover all available pages before exploring further.

# Extender Claude con habilidades

> Crea, gestiona y comparte habilidades para extender las capacidades de Claude en Claude Code. Incluye comandos de barra diagonal personalizados.

Las habilidades extienden lo que Claude puede hacer. Crea un archivo `SKILL.md` con instrucciones, y Claude lo añade a su kit de herramientas. Claude usa habilidades cuando es relevante, o puedes invocar una directamente con `/nombre-habilidad`.

<Note>
  Para comandos integrados como `/help` y `/compact`, consulta [modo interactivo](/es/interactive-mode#built-in-commands).

  **Los comandos de barra diagonal personalizados se han fusionado en habilidades.** Un archivo en `.claude/commands/review.md` y una habilidad en `.claude/skills/review/SKILL.md` ambos crean `/review` y funcionan de la misma manera. Tus archivos existentes en `.claude/commands/` siguen funcionando. Las habilidades añaden características opcionales: un directorio para archivos de apoyo, frontmatter para [controlar si tú o Claude las invoca](#control-who-invokes-a-skill), y la capacidad de que Claude las cargue automáticamente cuando sea relevante.
</Note>

Las habilidades de Claude Code siguen el estándar abierto [Agent Skills](https://agentskills.io), que funciona en múltiples herramientas de IA. Claude Code extiende el estándar con características adicionales como [control de invocación](#control-who-invokes-a-skill), [ejecución de subagentes](#run-skills-in-a-subagent), e [inyección de contexto dinámico](#inject-dynamic-context).

## Primeros pasos

### Crea tu primera habilidad

Este ejemplo crea una habilidad que enseña a Claude a explicar código usando diagramas visuales y analogías. Como usa frontmatter predeterminado, Claude puede cargarla automáticamente cuando preguntes cómo funciona algo, o puedes invocarla directamente con `/explain-code`.

<Steps>
  <Step title="Crea el directorio de habilidad">
    Crea un directorio para la habilidad en tu carpeta de habilidades personales. Las habilidades personales están disponibles en todos tus proyectos.

    ```bash  theme={null}
    mkdir -p ~/.claude/skills/explain-code
    ```
  </Step>

  <Step title="Escribe SKILL.md">
    Cada habilidad necesita un archivo `SKILL.md` con dos partes: frontmatter YAML (entre marcadores `---`) que le dice a Claude cuándo usar la habilidad, y contenido markdown con instrucciones que Claude sigue cuando se invoca la habilidad. El campo `name` se convierte en el `/comando-barra-diagonal`, y la `description` ayuda a Claude a decidir cuándo cargarla automáticamente.

    Crea `~/.claude/skills/explain-code/SKILL.md`:

    ```yaml  theme={null}
    ---
    name: explain-code
    description: Explains code with visual diagrams and analogies. Use when explaining how code works, teaching about a codebase, or when the user asks "how does this work?"
    ---

    When explaining code, always include:

    1. **Start with an analogy**: Compare the code to something from everyday life
    2. **Draw a diagram**: Use ASCII art to show the flow, structure, or relationships
    3. **Walk through the code**: Explain step-by-step what happens
    4. **Highlight a gotcha**: What's a common mistake or misconception?

    Keep explanations conversational. For complex concepts, use multiple analogies.
    ```
  </Step>

  <Step title="Prueba la habilidad">
    Puedes probarla de dos maneras:

    **Deja que Claude la invoque automáticamente** preguntando algo que coincida con la descripción:

    ```
    How does this code work?
    ```

    **O invócala directamente** con el nombre de la habilidad:

    ```
    /explain-code src/auth/login.ts
    ```

    De cualquier manera, Claude debería incluir una analogía y un diagrama ASCII en su explicación.
  </Step>
</Steps>

### Dónde viven las habilidades

Dónde almacenes una habilidad determina quién puede usarla:

| Ubicación | Ruta                                                            | Se aplica a                           |
| :-------- | :-------------------------------------------------------------- | :------------------------------------ |
| Empresa   | Consulta [configuración administrada](/es/iam#managed-settings) | Todos los usuarios en tu organización |
| Personal  | `~/.claude/skills/<nombre-habilidad>/SKILL.md`                  | Todos tus proyectos                   |
| Proyecto  | `.claude/skills/<nombre-habilidad>/SKILL.md`                    | Solo este proyecto                    |
| Plugin    | `<plugin>/skills/<nombre-habilidad>/SKILL.md`                   | Donde el plugin está habilitado       |

Las habilidades del proyecto anulan las habilidades personales con el mismo nombre. Si tienes archivos en `.claude/commands/`, funcionan de la misma manera pero una habilidad tiene precedencia sobre un comando con el mismo nombre.

#### Descubrimiento automático desde directorios anidados

Cuando trabajas con archivos en subdirectorios, Claude Code descubre automáticamente habilidades desde directorios `.claude/skills/` anidados. Por ejemplo, si estás editando un archivo en `packages/frontend/`, Claude Code también busca habilidades en `packages/frontend/.claude/skills/`. Esto soporta configuraciones de monorepo donde los paquetes tienen sus propias habilidades.

Cada habilidad es un directorio con `SKILL.md` como punto de entrada:

```
my-skill/
├── SKILL.md           # Main instructions (required)
├── template.md        # Template for Claude to fill in
├── examples/
│   └── sample.md      # Example output showing expected format
└── scripts/
    └── validate.sh    # Script Claude can execute
```

El `SKILL.md` contiene las instrucciones principales y es obligatorio. Otros archivos son opcionales y te permiten construir habilidades más poderosas: plantillas para que Claude complete, salidas de ejemplo mostrando el formato esperado, scripts que Claude puede ejecutar, o documentación de referencia detallada. Referencia estos archivos desde tu `SKILL.md` para que Claude sepa qué contienen y cuándo cargarlos. Consulta [Añadir archivos de apoyo](#add-supporting-files) para más detalles.

<Note>
  Los archivos en `.claude/commands/` siguen funcionando y soportan el mismo [frontmatter](#frontmatter-reference). Las habilidades se recomiendan ya que soportan características adicionales como archivos de apoyo.
</Note>

## Configura habilidades

Las habilidades se configuran a través de frontmatter YAML en la parte superior de `SKILL.md` y el contenido markdown que sigue.

### Tipos de contenido de habilidad

Los archivos de habilidad pueden contener cualquier instrucción, pero pensar en cómo quieres invocarlas ayuda a guiar qué incluir:

**Contenido de referencia** añade conocimiento que Claude aplica a tu trabajo actual. Convenciones, patrones, guías de estilo, conocimiento del dominio. Este contenido se ejecuta en línea para que Claude pueda usarlo junto con el contexto de tu conversación.

```yaml  theme={null}
---
name: api-conventions
description: API design patterns for this codebase
---

When writing API endpoints:
- Use RESTful naming conventions
- Return consistent error formats
- Include request validation
```

**Contenido de tarea** le da a Claude instrucciones paso a paso para una acción específica, como despliegues, commits o generación de código. Estas son a menudo acciones que quieres invocar directamente con `/nombre-habilidad` en lugar de dejar que Claude decida cuándo ejecutarlas. Añade `disable-model-invocation: true` para evitar que Claude la dispare automáticamente.

```yaml  theme={null}
---
name: deploy
description: Deploy the application to production
context: fork
disable-model-invocation: true
---

Deploy the application:
1. Run the test suite
2. Build the application
3. Push to the deployment target
```

Tu `SKILL.md` puede contener cualquier cosa, pero pensar en cómo quieres que se invoque la habilidad (por ti, por Claude, o ambos) y dónde quieres que se ejecute (en línea o en un subagente) ayuda a guiar qué incluir. Para habilidades complejas, también puedes [añadir archivos de apoyo](#add-supporting-files) para mantener la habilidad principal enfocada.

### Referencia de frontmatter

Más allá del contenido markdown, puedes configurar el comportamiento de la habilidad usando campos de frontmatter YAML entre marcadores `---` en la parte superior de tu archivo `SKILL.md`:

```yaml  theme={null}
---
name: my-skill
description: What this skill does
disable-model-invocation: true
allowed-tools: Read, Grep
---

Your skill instructions here...
```

Todos los campos son opcionales. Solo `description` se recomienda para que Claude sepa cuándo usar la habilidad.

| Campo                      | Requerido   | Descripción                                                                                                                                                                         |
| :------------------------- | :---------- | :---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`                     | No          | Nombre para mostrar de la habilidad. Si se omite, usa el nombre del directorio. Solo letras minúsculas, números y guiones (máximo 64 caracteres).                                   |
| `description`              | Recomendado | Qué hace la habilidad y cuándo usarla. Claude usa esto para decidir cuándo aplicar la habilidad. Si se omite, usa el primer párrafo del contenido markdown.                         |
| `argument-hint`            | No          | Sugerencia mostrada durante autocompletado para indicar argumentos esperados. Ejemplo: `[issue-number]` o `[filename] [format]`.                                                    |
| `disable-model-invocation` | No          | Establece en `true` para evitar que Claude cargue automáticamente esta habilidad. Usa para flujos de trabajo que quieres disparar manualmente con `/name`. Predeterminado: `false`. |
| `user-invocable`           | No          | Establece en `false` para ocultar del menú `/`. Usa para conocimiento de fondo que los usuarios no deberían invocar directamente. Predeterminado: `true`.                           |
| `allowed-tools`            | No          | Herramientas que Claude puede usar sin pedir permiso cuando esta habilidad está activa.                                                                                             |
| `model`                    | No          | Modelo a usar cuando esta habilidad está activa.                                                                                                                                    |
| `context`                  | No          | Establece en `fork` para ejecutar en un contexto de subagente bifurcado.                                                                                                            |
| `agent`                    | No          | Qué tipo de subagente usar cuando `context: fork` está establecido.                                                                                                                 |
| `hooks`                    | No          | Hooks limitados al ciclo de vida de esta habilidad. Consulta [Hooks](/es/hooks) para el formato de configuración.                                                                   |

#### Sustituciones de cadena disponibles

Las habilidades soportan sustitución de cadena para valores dinámicos en el contenido de la habilidad:

| Variable               | Descripción                                                                                                                                                       |
| :--------------------- | :---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `$ARGUMENTS`           | Todos los argumentos pasados cuando se invoca la habilidad. Si `$ARGUMENTS` no está presente en el contenido, los argumentos se añaden como `ARGUMENTS: <value>`. |
| `${CLAUDE_SESSION_ID}` | El ID de sesión actual. Útil para logging, crear archivos específicos de sesión, o correlacionar la salida de habilidad con sesiones.                             |

**Ejemplo usando sustituciones:**

```yaml  theme={null}
---
name: session-logger
description: Log activity for this session
---

Log the following to logs/${CLAUDE_SESSION_ID}.log:

$ARGUMENTS
```

### Añadir archivos de apoyo

Las habilidades pueden incluir múltiples archivos en su directorio. Esto mantiene `SKILL.md` enfocado en lo esencial mientras permite que Claude acceda a material de referencia detallado solo cuando sea necesario. Documentos de referencia grandes, especificaciones de API, o colecciones de ejemplos no necesitan cargarse en contexto cada vez que se ejecuta la habilidad.

```
my-skill/
├── SKILL.md (required - overview and navigation)
├── reference.md (detailed API docs - loaded when needed)
├── examples.md (usage examples - loaded when needed)
└── scripts/
    └── helper.py (utility script - executed, not loaded)
```

Referencia archivos de apoyo desde `SKILL.md` para que Claude sepa qué contiene cada archivo y cuándo cargarlo:

```markdown  theme={null}
## Additional resources

- For complete API details, see [reference.md](reference.md)
- For usage examples, see [examples.md](examples.md)
```

<Tip>Mantén `SKILL.md` bajo 500 líneas. Mueve material de referencia detallado a archivos separados.</Tip>

### Controla quién invoca una habilidad

Por defecto, tanto tú como Claude pueden invocar cualquier habilidad. Puedes escribir `/nombre-habilidad` para invocarla directamente, y Claude puede cargarla automáticamente cuando sea relevante para tu conversación. Dos campos de frontmatter te permiten restringir esto:

* **`disable-model-invocation: true`**: Solo tú puedes invocar la habilidad. Usa esto para flujos de trabajo con efectos secundarios o que quieres controlar el timing, como `/commit`, `/deploy`, o `/send-slack-message`. No quieres que Claude decida desplegar porque tu código se ve listo.

* **`user-invocable: false`**: Solo Claude puede invocar la habilidad. Usa esto para conocimiento de fondo que no es accionable como un comando. Una habilidad `legacy-system-context` explica cómo funciona un sistema antiguo. Claude debería saber esto cuando sea relevante, pero `/legacy-system-context` no es una acción significativa para que los usuarios realicen.

Este ejemplo crea una habilidad de despliegue que solo tú puedes disparar. El campo `disable-model-invocation: true` evita que Claude la ejecute automáticamente:

```yaml  theme={null}
---
name: deploy
description: Deploy the application to production
disable-model-invocation: true
---

Deploy $ARGUMENTS to production:

1. Run the test suite
2. Build the application
3. Push to the deployment target
4. Verify the deployment succeeded
```

Aquí está cómo los dos campos afectan la invocación y la carga de contexto:

| Frontmatter                      | Puedes invocar | Claude puede invocar | Cuándo se carga en contexto                                                   |
| :------------------------------- | :------------- | :------------------- | :---------------------------------------------------------------------------- |
| (predeterminado)                 | Sí             | Sí                   | Descripción siempre en contexto, habilidad completa se carga cuando se invoca |
| `disable-model-invocation: true` | Sí             | No                   | Descripción no en contexto, habilidad completa se carga cuando la invocas     |
| `user-invocable: false`          | No             | Sí                   | Descripción siempre en contexto, habilidad completa se carga cuando se invoca |

<Note>
  En una sesión regular, las descripciones de habilidades se cargan en contexto para que Claude sepa qué está disponible, pero el contenido completo de la habilidad solo se carga cuando se invoca. [Subagentes con habilidades precargadas](/es/sub-agents#preload-skills-into-subagents) funcionan diferente: el contenido completo de la habilidad se inyecta al inicio.
</Note>

### Restringe el acceso a herramientas

Usa el campo `allowed-tools` para limitar qué herramientas puede usar Claude cuando una habilidad está activa. Esta habilidad crea un modo de solo lectura donde Claude puede explorar archivos pero no modificarlos:

```yaml  theme={null}
---
name: safe-reader
description: Read files without making changes
allowed-tools: Read, Grep, Glob
---
```

### Pasa argumentos a habilidades

Tanto tú como Claude pueden pasar argumentos cuando invocas una habilidad. Los argumentos están disponibles a través del placeholder `$ARGUMENTS`.

Esta habilidad arregla un problema de GitHub por número. El placeholder `$ARGUMENTS` se reemplaza con lo que sigue al nombre de la habilidad:

```yaml  theme={null}
---
name: fix-issue
description: Fix a GitHub issue
disable-model-invocation: true
---

Fix GitHub issue $ARGUMENTS following our coding standards.

1. Read the issue description
2. Understand the requirements
3. Implement the fix
4. Write tests
5. Create a commit
```

Cuando ejecutas `/fix-issue 123`, Claude recibe "Fix GitHub issue 123 following our coding standards..."

Si invocas una habilidad con argumentos pero la habilidad no incluye `$ARGUMENTS`, Claude Code añade `ARGUMENTS: <tu entrada>` al final del contenido de la habilidad para que Claude siga viendo lo que escribiste.

## Patrones avanzados

### Inyecta contexto dinámico

La sintaxis `!`comando\`\` ejecuta comandos de shell antes de que el contenido de la habilidad se envíe a Claude. La salida del comando reemplaza el placeholder, para que Claude reciba datos reales, no el comando en sí.

Esta habilidad resume una solicitud de extracción obteniendo datos de PR en vivo con GitHub CLI. Los comandos `!`gh pr diff\`\` y otros se ejecutan primero, y su salida se inserta en el prompt:

```yaml  theme={null}
---
name: pr-summary
description: Summarize changes in a pull request
context: fork
agent: Explore
allowed-tools: Bash(gh:*)
---

## Pull request context
- PR diff: !`gh pr diff`
- PR comments: !`gh pr view --comments`
- Changed files: !`gh pr diff --name-only`

## Your task
Summarize this pull request...
```

Cuando se ejecuta esta habilidad:

1. Cada `!`comando\`\` se ejecuta inmediatamente (antes de que Claude vea algo)
2. La salida reemplaza el placeholder en el contenido de la habilidad
3. Claude recibe el prompt completamente renderizado con datos de PR reales

Esto es preprocesamiento, no algo que Claude ejecute. Claude solo ve el resultado final.

<Tip>
  Para habilitar [pensamiento extendido](/es/common-workflows#use-extended-thinking-thinking-mode) en una habilidad, incluye la palabra "ultrathink" en cualquier lugar en el contenido de tu habilidad.
</Tip>

### Ejecuta habilidades en un subagente

Añade `context: fork` a tu frontmatter cuando quieras que una habilidad se ejecute en aislamiento. El contenido de la habilidad se convierte en el prompt que impulsa el subagente. No tendrá acceso a tu historial de conversación.

<Warning>
  `context: fork` solo tiene sentido para habilidades con instrucciones explícitas. Si tu habilidad contiene directrices como "usa estas convenciones de API" sin una tarea, el subagente recibe las directrices pero sin un prompt accionable, y regresa sin salida significativa.
</Warning>

Las habilidades y [subagentes](/es/sub-agents) funcionan juntos en dos direcciones:

| Enfoque                       | Prompt del sistema                           | Tarea                           | También carga                       |
| :---------------------------- | :------------------------------------------- | :------------------------------ | :---------------------------------- |
| Habilidad con `context: fork` | Del tipo de agente (`Explore`, `Plan`, etc.) | Contenido de SKILL.md           | CLAUDE.md                           |
| Subagente con campo `skills`  | Cuerpo markdown del subagente                | Mensaje de delegación de Claude | Habilidades precargadas + CLAUDE.md |

Con `context: fork`, escribes la tarea en tu habilidad y eliges un tipo de agente para ejecutarla. Para lo inverso (definir un subagente personalizado que use habilidades como material de referencia), consulta [Subagentes](/es/sub-agents#preload-skills-into-subagents).

#### Ejemplo: Habilidad de investigación usando agente Explore

Esta habilidad ejecuta investigación en un agente Explore bifurcado. El contenido de la habilidad se convierte en la tarea, y el agente proporciona herramientas de solo lectura optimizadas para exploración de base de código:

```yaml  theme={null}
---
name: deep-research
description: Research a topic thoroughly
context: fork
agent: Explore
---

Research $ARGUMENTS thoroughly:

1. Find relevant files using Glob and Grep
2. Read and analyze the code
3. Summarize findings with specific file references
```

Cuando se ejecuta esta habilidad:

1. Se crea un nuevo contexto aislado
2. El subagente recibe el contenido de la habilidad como su prompt ("Research \$ARGUMENTS thoroughly...")
3. El campo `agent` determina el entorno de ejecución (modelo, herramientas y permisos)
4. Los resultados se resumen y se devuelven a tu conversación principal

El campo `agent` especifica qué configuración de subagente usar. Las opciones incluyen agentes integrados (`Explore`, `Plan`, `general-purpose`) o cualquier subagente personalizado de `.claude/agents/`. Si se omite, usa `general-purpose`.

### Restringe el acceso de Claude a habilidades

Por defecto, Claude puede invocar cualquier habilidad que no tenga `disable-model-invocation: true` establecido. Los comandos integrados como `/compact` e `/init` no están disponibles a través de la herramienta Skill.

Tres formas de controlar qué habilidades puede invocar Claude:

**Deshabilita todas las habilidades** negando la herramienta Skill en `/permissions`:

```
# Add to deny rules:
Skill
```

**Permite o deniega habilidades específicas** usando [reglas de permiso](/es/iam):

```
# Allow only specific skills
Skill(commit)
Skill(review-pr:*)

# Deny specific skills
Skill(deploy:*)
```

Sintaxis de permiso: `Skill(name)` para coincidencia exacta, `Skill(name:*)` para coincidencia de prefijo con cualquier argumento.

**Oculta habilidades individuales** añadiendo `disable-model-invocation: true` a su frontmatter. Esto elimina la habilidad del contexto de Claude completamente.

<Note>
  El campo `user-invocable` solo controla la visibilidad del menú, no el acceso a la herramienta Skill. Usa `disable-model-invocation: true` para bloquear la invocación programática.
</Note>

## Comparte habilidades

Las habilidades pueden distribuirse en diferentes alcances dependiendo de tu audiencia:

* **Habilidades de proyecto**: Confirma `.claude/skills/` al control de versiones
* **Plugins**: Crea un directorio `skills/` en tu [plugin](/es/plugins)
* **Administrado**: Despliega en toda la organización a través de [configuración administrada](/es/iam#managed-settings)

### Genera salida visual

Las habilidades pueden agrupar y ejecutar scripts en cualquier lenguaje, dándole a Claude capacidades más allá de lo que es posible en un único prompt. Un patrón poderoso es generar salida visual: archivos HTML interactivos que se abren en tu navegador para explorar datos, depurar o crear reportes.

Este ejemplo crea un explorador de base de código: una vista de árbol interactiva donde puedes expandir y contraer directorios, ver tamaños de archivo de un vistazo, e identificar tipos de archivo por color.

Crea el directorio de Habilidad:

```bash  theme={null}
mkdir -p ~/.claude/skills/codebase-visualizer/scripts
```

Crea `~/.claude/skills/codebase-visualizer/SKILL.md`. La descripción le dice a Claude cuándo activar esta Habilidad, y las instrucciones le dicen a Claude que ejecute el script agrupado:

````yaml  theme={null}
---
name: codebase-visualizer
description: Generate an interactive collapsible tree visualization of your codebase. Use when exploring a new repo, understanding project structure, or identifying large files.
allowed-tools: Bash(python:*)
---

# Codebase Visualizer

Generate an interactive HTML tree view that shows your project's file structure with collapsible directories.

## Usage

Run the visualization script from your project root:

```bash
python ~/.claude/skills/codebase-visualizer/scripts/visualize.py .
```

This creates `codebase-map.html` in the current directory and opens it in your default browser.

## What the visualization shows

- **Collapsible directories**: Click folders to expand/collapse
- **File sizes**: Displayed next to each file
- **Colors**: Different colors for different file types
- **Directory totals**: Shows aggregate size of each folder
````

Crea `~/.claude/skills/codebase-visualizer/scripts/visualize.py`. Este script escanea un árbol de directorio y genera un archivo HTML autónomo con:

* Una **barra lateral de resumen** mostrando conteo de archivos, conteo de directorios, tamaño total, y número de tipos de archivo
* Un **gráfico de barras** desglosando la base de código por tipo de archivo (top 8 por tamaño)
* Un **árbol colapsable** donde puedes expandir y contraer directorios, con indicadores de tipo de archivo codificados por color

El script requiere Python pero usa solo bibliotecas integradas, así que no hay paquetes para instalar:

```python expandable theme={null}
#!/usr/bin/env python3
"""Generate an interactive collapsible tree visualization of a codebase."""

import json
import sys
import webbrowser
from pathlib import Path
from collections import Counter

IGNORE = {'.git', 'node_modules', '__pycache__', '.venv', 'venv', 'dist', 'build'}

def scan(path: Path, stats: dict) -> dict:
    result = {"name": path.name, "children": [], "size": 0}
    try:
        for item in sorted(path.iterdir()):
            if item.name in IGNORE or item.name.startswith('.'):
                continue
            if item.is_file():
                size = item.stat().st_size
                ext = item.suffix.lower() or '(no ext)'
                result["children"].append({"name": item.name, "size": size, "ext": ext})
                result["size"] += size
                stats["files"] += 1
                stats["extensions"][ext] += 1
                stats["ext_sizes"][ext] += size
            elif item.is_dir():
                stats["dirs"] += 1
                child = scan(item, stats)
                if child["children"]:
                    result["children"].append(child)
                    result["size"] += child["size"]
    except PermissionError:
        pass
    return result

def generate_html(data: dict, stats: dict, output: Path) -> None:
    ext_sizes = stats["ext_sizes"]
    total_size = sum(ext_sizes.values()) or 1
    sorted_exts = sorted(ext_sizes.items(), key=lambda x: -x[1])[:8]
    colors = {
        '.js': '#f7df1e', '.ts': '#3178c6', '.py': '#3776ab', '.go': '#00add8',
        '.rs': '#dea584', '.rb': '#cc342d', '.css': '#264de4', '.html': '#e34c26',
        '.json': '#6b7280', '.md': '#083fa1', '.yaml': '#cb171e', '.yml': '#cb171e',
        '.mdx': '#083fa1', '.tsx': '#3178c6', '.jsx': '#61dafb', '.sh': '#4eaa25',
    }
    lang_bars = "".join(
        f'<div class="bar-row"><span class="bar-label">{ext}</span>'
        f'<div class="bar" style="width:{(size/total_size)*100}%;background:{colors.get(ext,"#6b7280")}"></div>'
        f'<span class="bar-pct">{(size/total_size)*100:.1f}%</span></div>'
        for ext, size in sorted_exts
    )
    def fmt(b):
        if b < 1024: return f"{b} B"
        if b < 1048576: return f"{b/1024:.1f} KB"
        return f"{b/1048576:.1f} MB"

    html = f'''<!DOCTYPE html>
<html><head>
  <meta charset="utf-8"><title>Codebase Explorer</title>
  <style>
    body {{ font: 14px/1.5 system-ui, sans-serif; margin: 0; background: #1a1a2e; color: #eee; }}
    .container {{ display: flex; height: 100vh; }}
    .sidebar {{ width: 280px; background: #252542; padding: 20px; border-right: 1px solid #3d3d5c; overflow-y: auto; flex-shrink: 0; }}
    .main {{ flex: 1; padding: 20px; overflow-y: auto; }}
    h1 {{ margin: 0 0 10px 0; font-size: 18px; }}
    h2 {{ margin: 20px 0 10px 0; font-size: 14px; color: #888; text-transform: uppercase; }}
    .stat {{ display: flex; justify-content: space-between; padding: 8px 0; border-bottom: 1px solid #3d3d5c; }}
    .stat-value {{ font-weight: bold; }}
    .bar-row {{ display: flex; align-items: center; margin: 6px 0; }}
    .bar-label {{ width: 55px; font-size: 12px; color: #aaa; }}
    .bar {{ height: 18px; border-radius: 3px; }}
    .bar-pct {{ margin-left: 8px; font-size: 12px; color: #666; }}
    .tree {{ list-style: none; padding-left: 20px; }}
    details {{ cursor: pointer; }}
    summary {{ padding: 4px 8px; border-radius: 4px; }}
    summary:hover {{ background: #2d2d44; }}
    .folder {{ color: #ffd700; }}
    .file {{ display: flex; align-items: center; padding: 4px 8px; border-radius: 4px; }}
    .file:hover {{ background: #2d2d44; }}
    .size {{ color: #888; margin-left: auto; font-size: 12px; }}
    .dot {{ width: 8px; height: 8px; border-radius: 50%; margin-right: 8px; }}
  </style>
</head><body>
  <div class="container">
    <div class="sidebar">
      <h1>📊 Summary</h1>
      <div class="stat"><span>Files</span><span class="stat-value">{stats["files"]:,}</span></div>
      <div class="stat"><span>Directories</span><span class="stat-value">{stats["dirs"]:,}</span></div>
      <div class="stat"><span>Total size</span><span class="stat-value">{fmt(data["size"])}</span></div>
      <div class="stat"><span>File types</span><span class="stat-value">{len(stats["extensions"])}</span></div>
      <h2>By file type</h2>
      {lang_bars}
    </div>
    <div class="main">
      <h1>📁 {data["name"]}</h1>
      <ul class="tree" id="root"></ul>
    </div>
  </div>
  <script>
    const data = {json.dumps(data)};
    const colors = {json.dumps(colors)};
    function fmt(b) {{ if (b < 1024) return b + ' B'; if (b < 1048576) return (b/1024).toFixed(1) + ' KB'; return (b/1048576).toFixed(1) + ' MB'; }}
    function render(node, parent) {{
      if (node.children) {{
        const det = document.createElement('details');
        det.open = parent === document.getElementById('root');
        det.innerHTML = `<summary><span class="folder">📁 ${{node.name}}</span><span class="size">${{fmt(node.size)}}</span></summary>`;
        const ul = document.createElement('ul'); ul.className = 'tree';
        node.children.sort((a,b) => (b.children?1:0)-(a.children?1:0) || a.name.localeCompare(b.name));
        node.children.forEach(c => render(c, ul));
        det.appendChild(ul);
        const li = document.createElement('li'); li.appendChild(det); parent.appendChild(li);
      }} else {{
        const li = document.createElement('li'); li.className = 'file';
        li.innerHTML = `<span class="dot" style="background:${{colors[node.ext]||'#6b7280'}}"></span>${{node.name}}<span class="size">${{fmt(node.size)}}</span>`;
        parent.appendChild(li);
      }}
    }}
    data.children.forEach(c => render(c, document.getElementById('root')));
  </script>
</body></html>'''
    output.write_text(html)

if __name__ == '__main__':
    target = Path(sys.argv[1] if len(sys.argv) > 1 else '.').resolve()
    stats = {"files": 0, "dirs": 0, "extensions": Counter(), "ext_sizes": Counter()}
    data = scan(target, stats)
    out = Path('codebase-map.html')
    generate_html(data, stats, out)
    print(f'Generated {out.absolute()}')
    webbrowser.open(f'file://{out.absolute()}')
```

Para probar, abre Claude Code en cualquier proyecto y pregunta "Visualiza esta base de código." Claude ejecuta el script, genera `codebase-map.html`, y lo abre en tu navegador.

Este patrón funciona para cualquier salida visual: gráficos de dependencias, reportes de cobertura de pruebas, documentación de API, o visualizaciones de esquema de base de datos. El script agrupado hace el trabajo pesado mientras Claude maneja la orquestación.

## Solución de problemas

### La habilidad no se dispara

Si Claude no usa tu habilidad cuando se espera:

1. Verifica que la descripción incluya palabras clave que los usuarios dirían naturalmente
2. Verifica que la habilidad aparezca en `What skills are available?`
3. Intenta reformular tu solicitud para que coincida más estrechamente con la descripción
4. Invócala directamente con `/nombre-habilidad` si la habilidad es invocable por el usuario

### La habilidad se dispara demasiado a menudo

Si Claude usa tu habilidad cuando no quieres:

1. Haz la descripción más específica
2. Añade `disable-model-invocation: true` si solo quieres invocación manual

### Claude no ve todas mis habilidades

Las descripciones de habilidades se cargan en contexto para que Claude sepa qué está disponible. Si tienes muchas habilidades, pueden exceder el presupuesto de caracteres (predeterminado 15,000 caracteres). Ejecuta `/context` para verificar una advertencia sobre habilidades excluidas.

Para aumentar el límite, establece la variable de entorno `SLASH_COMMAND_TOOL_CHAR_BUDGET`.

## Recursos relacionados

* **[Subagentes](/es/sub-agents)**: delega tareas a agentes especializados
* **[Plugins](/es/plugins)**: empaqueta y distribuye habilidades con otras extensiones
* **[Hooks](/es/hooks)**: automatiza flujos de trabajo alrededor de eventos de herramientas
* **[Memoria](/es/memory)**: gestiona archivos CLAUDE.md para contexto persistente
* **[Modo interactivo](/es/interactive-mode#built-in-commands)**: comandos integrados y atajos
* **[Permisos](/es/iam)**: controla el acceso a herramientas y habilidades
