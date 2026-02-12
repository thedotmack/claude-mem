> ## Documentation Index
> Fetch the complete documentation index at: https://code.claude.com/docs/llms.txt
> Use this file to discover all available pages before exploring further.

# Gestionar la memoria de Claude

> Aprende cómo gestionar la memoria de Claude Code en diferentes sesiones con diferentes ubicaciones de memoria y mejores prácticas.

Claude Code puede recordar tus preferencias en diferentes sesiones, como directrices de estilo y comandos comunes en tu flujo de trabajo.

## Determinar el tipo de memoria

Claude Code ofrece cuatro ubicaciones de memoria en una estructura jerárquica, cada una sirviendo un propósito diferente:

| Tipo de Memoria                  | Ubicación                                                                                                                                                       | Propósito                                                       | Ejemplos de Casos de Uso                                                                     | Compartido Con                                        |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| **Política empresarial**         | • macOS: `/Library/Application Support/ClaudeCode/CLAUDE.md`<br />• Linux: `/etc/claude-code/CLAUDE.md`<br />• Windows: `C:\Program Files\ClaudeCode\CLAUDE.md` | Instrucciones de toda la organización gestionadas por TI/DevOps | Estándares de codificación de la empresa, políticas de seguridad, requisitos de cumplimiento | Todos los usuarios de la organización                 |
| **Memoria del proyecto**         | `./CLAUDE.md` o `./.claude/CLAUDE.md`                                                                                                                           | Instrucciones compartidas por el equipo para el proyecto        | Arquitectura del proyecto, estándares de codificación, flujos de trabajo comunes             | Miembros del equipo a través del control de versiones |
| **Reglas del proyecto**          | `./.claude/rules/*.md`                                                                                                                                          | Instrucciones modulares específicas por tema para el proyecto   | Directrices específicas del lenguaje, convenciones de prueba, estándares de API              | Miembros del equipo a través del control de versiones |
| **Memoria del usuario**          | `~/.claude/CLAUDE.md`                                                                                                                                           | Preferencias personales para todos los proyectos                | Preferencias de estilo de código, atajos de herramientas personales                          | Solo tú (todos los proyectos)                         |
| **Memoria del proyecto (local)** | `./CLAUDE.local.md`                                                                                                                                             | Preferencias personales específicas del proyecto                | Tus URLs de sandbox, datos de prueba preferidos                                              | Solo tú (proyecto actual)                             |

Todos los archivos de memoria se cargan automáticamente en el contexto de Claude Code cuando se inicia. Los archivos más altos en la jerarquía tienen prioridad y se cargan primero, proporcionando una base sobre la que se construyen memorias más específicas.

<Note>
  Los archivos CLAUDE.local.md se agregan automáticamente a .gitignore, lo que los hace ideales para preferencias privadas específicas del proyecto que no deben verificarse en el control de versiones.
</Note>

## Importaciones de CLAUDE.md

Los archivos CLAUDE.md pueden importar archivos adicionales usando la sintaxis `@path/to/import`. El siguiente ejemplo importa 3 archivos:

```
Ver @README para la descripción general del proyecto y @package.json para los comandos npm disponibles para este proyecto.

# Instrucciones Adicionales
- flujo de trabajo git @docs/git-instructions.md
```

Se permiten rutas relativas y absolutas. En particular, importar archivos en el directorio de inicio del usuario es una forma conveniente para que los miembros de tu equipo proporcionen instrucciones individuales que no se verifiquen en el repositorio. Las importaciones son una alternativa a CLAUDE.local.md que funciona mejor en múltiples árboles de trabajo de git.

```
# Preferencias Individuales
- @~/.claude/my-project-instructions.md
```

Para evitar posibles colisiones, las importaciones no se evalúan dentro de espacios de código markdown y bloques de código.

```
Este espacio de código no será tratado como una importación: `@anthropic-ai/claude-code`
```

Los archivos importados pueden importar recursivamente archivos adicionales, con una profundidad máxima de 5 saltos. Puedes ver qué archivos de memoria se cargan ejecutando el comando `/memory`.

## Cómo Claude busca memorias

Claude Code lee memorias recursivamente: comenzando en el cwd, Claude Code recurre hacia arriba hasta (pero sin incluir) el directorio raíz */* y lee cualquier archivo CLAUDE.md o CLAUDE.local.md que encuentre. Esto es especialmente conveniente cuando trabajas en repositorios grandes donde ejecutas Claude Code en *foo/bar/*, y tienes memorias tanto en *foo/CLAUDE.md* como en *foo/bar/CLAUDE.md*.

Claude también descubrirá CLAUDE.md anidado en subárboles bajo tu directorio de trabajo actual. En lugar de cargarlos al iniciar, solo se incluyen cuando Claude lee archivos en esos subárboles.

## Editar directamente memorias con `/memory`

Usa el comando de barra `/memory` durante una sesión para abrir cualquier archivo de memoria en el editor del sistema para adiciones u organización más extensas.

## Configurar memoria del proyecto

Supongamos que deseas configurar un archivo CLAUDE.md para almacenar información importante del proyecto, convenciones y comandos frecuentemente utilizados. La memoria del proyecto se puede almacenar en `./CLAUDE.md` o `./.claude/CLAUDE.md`.

Inicia un CLAUDE.md para tu base de código con el siguiente comando:

```
> /init
```

<Tip>
  Consejos:

  * Incluye comandos frecuentemente utilizados (build, test, lint) para evitar búsquedas repetidas
  * Documenta preferencias de estilo de código y convenciones de nomenclatura
  * Agrega patrones arquitectónicos importantes específicos de tu proyecto
  * Las memorias CLAUDE.md se pueden usar tanto para instrucciones compartidas con tu equipo como para tus preferencias individuales.
</Tip>

## Reglas modulares con `.claude/rules/`

Para proyectos más grandes, puedes organizar instrucciones en múltiples archivos usando el directorio `.claude/rules/`. Esto permite a los equipos mantener archivos de reglas enfocados y bien organizados en lugar de un CLAUDE.md grande.

### Estructura básica

Coloca archivos markdown en el directorio `.claude/rules/` de tu proyecto:

```
your-project/
├── .claude/
│   ├── CLAUDE.md           # Instrucciones principales del proyecto
│   └── rules/
│       ├── code-style.md   # Directrices de estilo de código
│       ├── testing.md      # Convenciones de prueba
│       └── security.md     # Requisitos de seguridad
```

Todos los archivos `.md` en `.claude/rules/` se cargan automáticamente como memoria del proyecto, con la misma prioridad que `.claude/CLAUDE.md`.

### Reglas específicas de ruta

Las reglas se pueden limitar a archivos específicos usando frontmatter YAML con el campo `paths`. Estas reglas condicionales solo se aplican cuando Claude está trabajando con archivos que coinciden con los patrones especificados.

```markdown  theme={null}
---
paths: src/api/**/*.ts
---

# Reglas de Desarrollo de API

- Todos los puntos finales de API deben incluir validación de entrada
- Usa el formato de respuesta de error estándar
- Incluye comentarios de documentación OpenAPI
```

Las reglas sin un campo `paths` se cargan incondicionalmente y se aplican a todos los archivos.

### Patrones Glob

El campo `paths` admite patrones glob estándar:

| Patrón                 | Coincide                                              |
| ---------------------- | ----------------------------------------------------- |
| `**/*.ts`              | Todos los archivos TypeScript en cualquier directorio |
| `src/**/*`             | Todos los archivos bajo el directorio `src/`          |
| `*.md`                 | Archivos Markdown en la raíz del proyecto             |
| `src/components/*.tsx` | Componentes React en un directorio específico         |

Puedes usar llaves para coincidir con múltiples patrones de manera eficiente:

```markdown  theme={null}
---
paths: src/**/*.{ts,tsx}
---

# Reglas de TypeScript/React
```

Esto se expande para coincidir tanto con `src/**/*.ts` como con `src/**/*.tsx`. También puedes combinar múltiples patrones con comas:

```markdown  theme={null}
---
paths: {src,lib}/**/*.ts, tests/**/*.test.ts
---
```

### Subdirectorios

Las reglas se pueden organizar en subdirectorios para una mejor estructura:

```
.claude/rules/
├── frontend/
│   ├── react.md
│   └── styles.md
├── backend/
│   ├── api.md
│   └── database.md
└── general.md
```

Todos los archivos `.md` se descubren recursivamente.

### Enlaces simbólicos

El directorio `.claude/rules/` admite enlaces simbólicos, permitiéndote compartir reglas comunes en múltiples proyectos:

```bash  theme={null}
# Enlace simbólico a un directorio de reglas compartidas
ln -s ~/shared-claude-rules .claude/rules/shared

# Enlace simbólico a archivos de reglas individuales
ln -s ~/company-standards/security.md .claude/rules/security.md
```

Los enlaces simbólicos se resuelven y sus contenidos se cargan normalmente. Los enlaces simbólicos circulares se detectan y se manejan correctamente.

### Reglas a nivel de usuario

Puedes crear reglas personales que se apliquen a todos tus proyectos en `~/.claude/rules/`:

```
~/.claude/rules/
├── preferences.md    # Tus preferencias personales de codificación
└── workflows.md      # Tus flujos de trabajo preferidos
```

Las reglas a nivel de usuario se cargan antes que las reglas del proyecto, dando a las reglas del proyecto mayor prioridad.

<Tip>
  Mejores prácticas para `.claude/rules/`:

  * **Mantén las reglas enfocadas**: Cada archivo debe cubrir un tema (por ejemplo, `testing.md`, `api-design.md`)
  * **Usa nombres de archivo descriptivos**: El nombre del archivo debe indicar qué cubren las reglas
  * **Usa reglas condicionales con moderación**: Solo agrega frontmatter `paths` cuando las reglas realmente se apliquen a tipos de archivo específicos
  * **Organiza con subdirectorios**: Agrupa reglas relacionadas (por ejemplo, `frontend/`, `backend/`)
</Tip>

## Gestión de memoria a nivel de organización

Las organizaciones pueden desplegar archivos CLAUDE.md gestionados centralmente que se apliquen a todos los usuarios.

Para configurar la gestión de memoria a nivel de organización:

1. Crea el archivo de memoria gestionada en la ubicación de **Política gestionada** mostrada en la [tabla de tipos de memoria anterior](#determine-memory-type).

2. Despliega a través de tu sistema de gestión de configuración (MDM, Group Policy, Ansible, etc.) para garantizar una distribución consistente en todas las máquinas de desarrolladores.

## Mejores prácticas de memoria

* **Sé específico**: "Usa indentación de 2 espacios" es mejor que "Formatea el código correctamente".
* **Usa estructura para organizar**: Formatea cada memoria individual como un punto de viñeta y agrupa memorias relacionadas bajo encabezados markdown descriptivos.
* **Revisa periódicamente**: Actualiza memorias a medida que tu proyecto evoluciona para asegurar que Claude siempre esté usando la información y contexto más actualizado.
