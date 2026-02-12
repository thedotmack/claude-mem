> ## Documentation Index
> Fetch the complete documentation index at: https://code.claude.com/docs/llms.txt
> Use this file to discover all available pages before exploring further.

# Crear plugins

> Crea plugins personalizados para extender Claude Code con skills, agentes, hooks y servidores MCP.

Los plugins te permiten extender Claude Code con funcionalidad personalizada que se puede compartir entre proyectos y equipos. Esta guía cubre la creación de tus propios plugins con skills, agentes, hooks y servidores MCP.

¿Buscas instalar plugins existentes? Consulta [Descubrir e instalar plugins](/es/discover-plugins). Para especificaciones técnicas completas, consulta [Referencia de plugins](/es/plugins-reference).

## Cuándo usar plugins frente a configuración independiente

Claude Code admite dos formas de agregar skills, agentes y hooks personalizados:

| Enfoque                                                    | Nombres de skills    | Mejor para                                                                                                                   |
| :--------------------------------------------------------- | :------------------- | :--------------------------------------------------------------------------------------------------------------------------- |
| **Independiente** (directorio `.claude/`)                  | `/hello`             | Flujos de trabajo personales, personalizaciones específicas del proyecto, experimentos rápidos                               |
| **Plugins** (directorios con `.claude-plugin/plugin.json`) | `/plugin-name:hello` | Compartir con compañeros de equipo, distribuir a la comunidad, lanzamientos versionados, reutilizable en múltiples proyectos |

**Usa configuración independiente cuando**:

* Estés personalizando Claude Code para un único proyecto
* La configuración es personal y no necesita ser compartida
* Estés experimentando con skills o hooks antes de empaquetarlos
* Quieras nombres de skills cortos como `/hello` o `/review`

**Usa plugins cuando**:

* Quieras compartir funcionalidad con tu equipo o comunidad
* Necesites los mismos skills/agentes en múltiples proyectos
* Quieras control de versiones y actualizaciones fáciles para tus extensiones
* Estés distribuyendo a través de un marketplace
* Estés de acuerdo con skills con espacios de nombres como `/my-plugin:hello` (los espacios de nombres previenen conflictos entre plugins)

<Tip>
  Comienza con configuración independiente en `.claude/` para iteración rápida, luego [convierte a un plugin](#convert-existing-configurations-to-plugins) cuando estés listo para compartir.
</Tip>

## Inicio rápido

Este inicio rápido te guía a través de la creación de un plugin con un skill personalizado. Crearás un manifiesto (el archivo de configuración que define tu plugin), agregarás un skill y lo probarás localmente usando la bandera `--plugin-dir`.

### Requisitos previos

* Claude Code [instalado y autenticado](/es/quickstart#step-1-install-claude-code)
* Claude Code versión 1.0.33 o posterior (ejecuta `claude --version` para verificar)

<Note>
  Si no ves el comando `/plugin`, actualiza Claude Code a la última versión. Consulta [Troubleshooting](/es/troubleshooting) para obtener instrucciones de actualización.
</Note>

### Crea tu primer plugin

<Steps>
  <Step title="Crea el directorio del plugin">
    Cada plugin vive en su propio directorio que contiene un manifiesto y tus skills, agentes o hooks. Crea uno ahora:

    ```bash  theme={null}
    mkdir my-first-plugin
    ```
  </Step>

  <Step title="Crea el manifiesto del plugin">
    El archivo de manifiesto en `.claude-plugin/plugin.json` define la identidad de tu plugin: su nombre, descripción y versión. Claude Code usa estos metadatos para mostrar tu plugin en el administrador de plugins.

    Crea el directorio `.claude-plugin` dentro de tu carpeta de plugin:

    ```bash  theme={null}
    mkdir my-first-plugin/.claude-plugin
    ```

    Luego crea `my-first-plugin/.claude-plugin/plugin.json` con este contenido:

    ```json my-first-plugin/.claude-plugin/plugin.json theme={null}
    {
    "name": "my-first-plugin",
    "description": "A greeting plugin to learn the basics",
    "version": "1.0.0",
    "author": {
    "name": "Your Name"
    }
    }
    ```

    | Campo         | Propósito                                                                                                                  |
    | :------------ | :------------------------------------------------------------------------------------------------------------------------- |
    | `name`        | Identificador único y espacio de nombres de skill. Los skills tienen este prefijo (por ejemplo, `/my-first-plugin:hello`). |
    | `description` | Se muestra en el administrador de plugins al examinar o instalar plugins.                                                  |
    | `version`     | Rastrear lanzamientos usando [versionado semántico](/es/plugins-reference#version-management).                             |
    | `author`      | Opcional. Útil para atribución.                                                                                            |

    Para campos adicionales como `homepage`, `repository` y `license`, consulta el [esquema de manifiesto completo](/es/plugins-reference#plugin-manifest-schema).
  </Step>

  <Step title="Agrega un skill">
    Los skills viven en el directorio `skills/`. Cada skill es una carpeta que contiene un archivo `SKILL.md`. El nombre de la carpeta se convierte en el nombre del skill, con el prefijo del espacio de nombres del plugin (`hello/` en un plugin llamado `my-first-plugin` crea `/my-first-plugin:hello`).

    Crea un directorio de skill en tu carpeta de plugin:

    ```bash  theme={null}
    mkdir -p my-first-plugin/skills/hello
    ```

    Luego crea `my-first-plugin/skills/hello/SKILL.md` con este contenido:

    ```markdown my-first-plugin/skills/hello/SKILL.md theme={null}
    ---
    description: Greet the user with a friendly message
    disable-model-invocation: true
    ---

    Greet the user warmly and ask how you can help them today.
    ```
  </Step>

  <Step title="Prueba tu plugin">
    Ejecuta Claude Code con la bandera `--plugin-dir` para cargar tu plugin:

    ```bash  theme={null}
    claude --plugin-dir ./my-first-plugin
    ```

    Una vez que Claude Code se inicie, prueba tu nuevo comando:

    ```shell  theme={null}
    /my-first-plugin:hello
    ```

    Verás que Claude responde con un saludo. Ejecuta `/help` para ver tu comando listado bajo el espacio de nombres del plugin.

    <Note>
      **¿Por qué espacios de nombres?** Los skills de plugin siempre tienen espacios de nombres (como `/greet:hello`) para prevenir conflictos cuando múltiples plugins tienen skills con el mismo nombre.

      Para cambiar el prefijo del espacio de nombres, actualiza el campo `name` en `plugin.json`.
    </Note>
  </Step>

  <Step title="Agrega argumentos de skill">
    Haz tu skill dinámico aceptando entrada del usuario. El marcador de posición `$ARGUMENTS` captura cualquier texto que el usuario proporcione después del nombre del skill.

    Actualiza tu archivo `hello.md`:

    ```markdown my-first-plugin/commands/hello.md theme={null}
    ---
    description: Greet the user with a personalized message
    ---

    # Hello Command

    Greet the user named "$ARGUMENTS" warmly and ask how you can help them today. Make the greeting personal and encouraging.
    ```

    Reinicia Claude Code para recoger los cambios, luego prueba el comando con tu nombre:

    ```shell  theme={null}
    /my-first-plugin:hello Alex
    ```

    Claude te saludará por tu nombre. Para más información sobre pasar argumentos a skills, consulta [Skills](/es/skills#pass-arguments-to-skills).
  </Step>
</Steps>

Has creado y probado exitosamente un plugin con estos componentes clave:

* **Manifiesto del plugin** (`.claude-plugin/plugin.json`): describe los metadatos de tu plugin
* **Directorio de comandos** (`commands/`): contiene tus skills personalizados
* **Argumentos de skill** (`$ARGUMENTS`): captura entrada del usuario para comportamiento dinámico

<Tip>
  La bandera `--plugin-dir` es útil para desarrollo y pruebas. Cuando estés listo para compartir tu plugin con otros, consulta [Crear y distribuir un marketplace de plugins](/es/plugin-marketplaces).
</Tip>

## Descripción general de la estructura del plugin

Has creado un plugin con un skill, pero los plugins pueden incluir mucho más: agentes personalizados, hooks, servidores MCP y servidores LSP.

<Warning>
  **Error común**: No pongas `commands/`, `agents/`, `skills/` o `hooks/` dentro del directorio `.claude-plugin/`. Solo `plugin.json` va dentro de `.claude-plugin/`. Todos los otros directorios deben estar en el nivel raíz del plugin.
</Warning>

| Directorio        | Ubicación       | Propósito                                                                                           |
| :---------------- | :-------------- | :-------------------------------------------------------------------------------------------------- |
| `.claude-plugin/` | Raíz del plugin | Contiene el manifiesto `plugin.json` (opcional si los componentes usan ubicaciones predeterminadas) |
| `commands/`       | Raíz del plugin | Skills como archivos Markdown                                                                       |
| `agents/`         | Raíz del plugin | Definiciones de agentes personalizados                                                              |
| `skills/`         | Raíz del plugin | Agent Skills con archivos `SKILL.md`                                                                |
| `hooks/`          | Raíz del plugin | Manejadores de eventos en `hooks.json`                                                              |
| `.mcp.json`       | Raíz del plugin | Configuraciones de servidor MCP                                                                     |
| `.lsp.json`       | Raíz del plugin | Configuraciones de servidor LSP para inteligencia de código                                         |

<Note>
  **Próximos pasos**: ¿Listo para agregar más características? Salta a [Desarrollar plugins más complejos](#develop-more-complex-plugins) para agregar agentes, hooks, servidores MCP y servidores LSP. Para especificaciones técnicas completas de todos los componentes del plugin, consulta [Referencia de plugins](/es/plugins-reference).
</Note>

## Desarrollar plugins más complejos

Una vez que te sientas cómodo con plugins básicos, puedes crear extensiones más sofisticadas.

### Agrega Skills a tu plugin

Los plugins pueden incluir [Agent Skills](/es/skills) para extender las capacidades de Claude. Los skills son invocados por el modelo: Claude los usa automáticamente basándose en el contexto de la tarea.

Agrega un directorio `skills/` en la raíz de tu plugin con carpetas de Skill que contengan archivos `SKILL.md`:

```
my-plugin/
├── .claude-plugin/
│   └── plugin.json
└── skills/
    └── code-review/
        └── SKILL.md
```

Cada `SKILL.md` necesita frontmatter con campos `name` y `description`, seguido de instrucciones:

```yaml  theme={null}
---
name: code-review
description: Reviews code for best practices and potential issues. Use when reviewing code, checking PRs, or analyzing code quality.
---

When reviewing code, check for:
1. Code organization and structure
2. Error handling
3. Security concerns
4. Test coverage
```

Después de instalar el plugin, reinicia Claude Code para cargar los Skills. Para orientación completa sobre la creación de Skills incluyendo divulgación progresiva y restricciones de herramientas, consulta [Agent Skills](/es/skills).

### Agrega servidores LSP a tu plugin

<Tip>
  Para lenguajes comunes como TypeScript, Python y Rust, instala los plugins LSP precompilados del marketplace oficial. Crea plugins LSP personalizados solo cuando necesites soporte para lenguajes que aún no estén cubiertos.
</Tip>

Los plugins LSP (Language Server Protocol) dan a Claude inteligencia de código en tiempo real. Si necesitas soportar un lenguaje que no tiene un plugin LSP oficial, puedes crear uno propio agregando un archivo `.lsp.json` a tu plugin:

```json .lsp.json theme={null}
{
  "go": {
    "command": "gopls",
    "args": ["serve"],
    "extensionToLanguage": {
      ".go": "go"
    }
  }
}
```

Los usuarios que instalen tu plugin deben tener el binario del servidor de lenguaje instalado en su máquina.

Para opciones de configuración LSP completas, consulta [Servidores LSP](/es/plugins-reference#lsp-servers).

### Organiza plugins complejos

Para plugins con muchos componentes, organiza tu estructura de directorios por funcionalidad. Para diseños de directorios completos y patrones de organización, consulta [Estructura de directorios del plugin](/es/plugins-reference#plugin-directory-structure).

### Prueba tus plugins localmente

Usa la bandera `--plugin-dir` para probar plugins durante el desarrollo. Esto carga tu plugin directamente sin requerir instalación.

```bash  theme={null}
claude --plugin-dir ./my-plugin
```

A medida que hagas cambios en tu plugin, reinicia Claude Code para recoger las actualizaciones. Prueba los componentes de tu plugin:

* Prueba tus comandos con `/command-name`
* Verifica que los agentes aparezcan en `/agents`
* Verifica que los hooks funcionen como se espera

<Tip>
  Puedes cargar múltiples plugins a la vez especificando la bandera varias veces:

  ```bash  theme={null}
  claude --plugin-dir ./plugin-one --plugin-dir ./plugin-two
  ```
</Tip>

### Depura problemas del plugin

Si tu plugin no funciona como se espera:

1. **Verifica la estructura**: Asegúrate de que tus directorios estén en la raíz del plugin, no dentro de `.claude-plugin/`
2. **Prueba componentes individualmente**: Verifica cada comando, agente y hook por separado
3. **Usa herramientas de validación y depuración**: Consulta [Herramientas de depuración y desarrollo](/es/plugins-reference#debugging-and-development-tools) para comandos CLI y técnicas de solución de problemas

### Comparte tus plugins

Cuando tu plugin esté listo para compartir:

1. **Agrega documentación**: Incluye un `README.md` con instrucciones de instalación y uso
2. **Versiona tu plugin**: Usa [versionado semántico](/es/plugins-reference#version-management) en tu `plugin.json`
3. **Crea o usa un marketplace**: Distribuye a través de [marketplaces de plugins](/es/plugin-marketplaces) para instalación
4. **Prueba con otros**: Haz que los miembros del equipo prueben el plugin antes de una distribución más amplia

Una vez que tu plugin esté en un marketplace, otros pueden instalarlo usando las instrucciones en [Descubrir e instalar plugins](/es/discover-plugins).

<Note>
  Para especificaciones técnicas completas, técnicas de depuración y estrategias de distribución, consulta [Referencia de plugins](/es/plugins-reference).
</Note>

## Convierte configuraciones existentes en plugins

Si ya tienes skills o hooks en tu directorio `.claude/`, puedes convertirlos en un plugin para compartir y distribuir más fácilmente.

### Pasos de migración

<Steps>
  <Step title="Crea la estructura del plugin">
    Crea un nuevo directorio de plugin:

    ```bash  theme={null}
    mkdir -p my-plugin/.claude-plugin
    ```

    Crea el archivo de manifiesto en `my-plugin/.claude-plugin/plugin.json`:

    ```json my-plugin/.claude-plugin/plugin.json theme={null}
    {
      "name": "my-plugin",
      "description": "Migrated from standalone configuration",
      "version": "1.0.0"
    }
    ```
  </Step>

  <Step title="Copia tus archivos existentes">
    Copia tus configuraciones existentes al directorio del plugin:

    ```bash  theme={null}
    # Copy commands
    cp -r .claude/commands my-plugin/

    # Copy agents (if any)
    cp -r .claude/agents my-plugin/

    # Copy skills (if any)
    cp -r .claude/skills my-plugin/
    ```
  </Step>

  <Step title="Migra hooks">
    Si tienes hooks en tu configuración, crea un directorio de hooks:

    ```bash  theme={null}
    mkdir my-plugin/hooks
    ```

    Crea `my-plugin/hooks/hooks.json` con tu configuración de hooks. Copia el objeto `hooks` de tu `.claude/settings.json` o `settings.local.json`, ya que el formato es el mismo. El comando recibe entrada de hook como JSON en stdin, así que usa `jq` para extraer la ruta del archivo:

    ```json my-plugin/hooks/hooks.json theme={null}
    {
      "hooks": {
        "PostToolUse": [
          {
            "matcher": "Write|Edit",
            "hooks": [{ "type": "command", "command": "jq -r '.tool_input.file_path' | xargs npm run lint:fix" }]
          }
        ]
      }
    }
    ```
  </Step>

  <Step title="Prueba tu plugin migrado">
    Carga tu plugin para verificar que todo funciona:

    ```bash  theme={null}
    claude --plugin-dir ./my-plugin
    ```

    Prueba cada componente: ejecuta tus comandos, verifica que los agentes aparezcan en `/agents` y verifica que los hooks se activen correctamente.
  </Step>
</Steps>

### Qué cambia al migrar

| Independiente (`.claude/`)             | Plugin                                      |
| :------------------------------------- | :------------------------------------------ |
| Solo disponible en un proyecto         | Se puede compartir a través de marketplaces |
| Archivos en `.claude/commands/`        | Archivos en `plugin-name/commands/`         |
| Hooks en `settings.json`               | Hooks en `hooks/hooks.json`                 |
| Debe copiar manualmente para compartir | Instalar con `/plugin install`              |

<Note>
  Después de migrar, puedes eliminar los archivos originales de `.claude/` para evitar duplicados. La versión del plugin tendrá precedencia cuando se cargue.
</Note>

## Próximos pasos

Ahora que entiendes el sistema de plugins de Claude Code, aquí hay caminos sugeridos para diferentes objetivos:

### Para usuarios de plugins

* [Descubrir e instalar plugins](/es/discover-plugins): examina marketplaces e instala plugins
* [Configura marketplaces de equipo](/es/discover-plugins#configure-team-marketplaces): configura plugins a nivel de repositorio para tu equipo

### Para desarrolladores de plugins

* [Crear y distribuir un marketplace](/es/plugin-marketplaces): empaqueta y comparte tus plugins
* [Referencia de plugins](/es/plugins-reference): especificaciones técnicas completas
* Profundiza en componentes específicos del plugin:
  * [Skills](/es/skills): detalles de desarrollo de skills
  * [Subagents](/es/sub-agents): configuración y capacidades de agentes
  * [Hooks](/es/hooks): manejo de eventos y automatización
  * [MCP](/es/mcp): integración de herramientas externas
