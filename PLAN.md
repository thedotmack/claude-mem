# Plan: Implementar Skills basadas en la Documentacion Oficial de Claude Code

## Contexto

La documentacion oficial de Claude Code en `claude code docs/` cubre 9 archivos con el ecosistema completo de extensiones: Skills, Subagents, Hooks, MCP, Plugins, Marketplaces, Memory y Agent Teams.

Se propone crear **3 skills** para el plugin claude-mem que ayuden a los usuarios a extender Claude Code correctamente, utilizando los patrones oficiales de la documentacion.

## Skills a Crear

| Skill | Tipo | Proposito |
|-------|------|-----------|
| `cc-skill-creator` | Tarea (manual) | Crea skills de Claude Code siguiendo patrones oficiales |
| `cc-subagent-creator` | Tarea (manual) | Crea subagents de Claude Code siguiendo patrones oficiales |
| `cc-extend` | Referencia (auto) | Guia de decision para elegir el mecanismo de extension correcto |

Ubicacion: `plugin/skills/<nombre>/SKILL.md` (junto al existente `mem-search`)

---

## Phase 0: Documentacion de Referencia y APIs Permitidas

### Fuentes Documentales

| Archivo | Tamanio | Skill que lo usa |
|---------|---------|------------------|
| `claude code docs/skills.md` | 34K | cc-skill-creator |
| `claude code docs/sub-agents.md` | 41K | cc-subagent-creator |
| `claude code docs/features-overview.md` | 27K | cc-extend |
| `claude code docs/hooks-guide.md` | 11K | cc-extend (referencia) |
| `claude code docs/mcp.md` | 44K | cc-extend (referencia) |
| `claude code docs/plugins.md` | 19K | cc-extend (referencia) |

### APIs/Patrones Permitidos (verificados en la documentacion)

**Formato de Skill (skills.md)**:
- Archivo: `SKILL.md` con frontmatter YAML entre `---`
- Campos frontmatter: `name`, `description`, `disable-model-invocation`, `user-invocable`, `allowed-tools`, `model`, `context`, `agent`, `argument-hint`, `hooks`
- Sustituciones: `$ARGUMENTS`, `${CLAUDE_SESSION_ID}`
- Contexto dinamico: `` !`comando` `` (ejecuta antes de enviar a Claude)
- Archivos de soporte: referenciados como links markdown desde SKILL.md
- Limite: SKILL.md bajo 500 lineas; material de referencia en archivos separados

**Formato de Subagent (sub-agents.md)**:
- Archivo: markdown con frontmatter YAML
- Campos frontmatter: `name`, `description`, `tools`, `disallowedTools`, `model`, `permissionMode`, `skills`, `hooks`, `memory`
- Modelos: `sonnet`, `opus`, `haiku`, `inherit`
- Modos de permiso: `default`, `acceptEdits`, `dontAsk`, `bypassPermissions`, `plan`
- Herramientas: `Read`, `Grep`, `Glob`, `Bash`, `Edit`, `Write`, etc.
- Ubicaciones: `.claude/agents/` (proyecto), `~/.claude/agents/` (usuario), `agents/` (plugin)

**Formato de Plugin Skill (plugins.md)**:
- Ubicacion: `plugin/skills/<nombre>/SKILL.md`
- Namespace: `/<plugin-name>:<skill-name>` (ej: `/claude-mem:cc-skill-creator`)
- Descubrimiento automatico: Claude Code detecta skills en `skills/` del plugin

### Anti-patrones a Evitar

- NO inventar campos de frontmatter que no existen en la documentacion
- NO usar `context: fork` sin instrucciones explicitas de tarea (el subagente no tendra prompt accionable)
- NO cargar documentacion completa en SKILL.md (usar archivos de soporte)
- NO omitir `description` (Claude la necesita para decidir cuando usar la skill)
- NO crear skills que necesiten herramientas MCP que el usuario pueda no tener instaladas
- NO usar `$ARGUMENTS` en skills de referencia (no tienen argumentos)

### Patron Existente a Copiar: `mem-search`

Ubicacion: `plugin/skills/mem-search/SKILL.md` (141 lineas)
Estructura verificada:
```
---
name: mem-search
description: Search claude-mem's persistent cross-session memory database. Use when user asks "did we already solve this?", "how did we do X last time?", or needs work from previous sessions.
---

# Memory Search

Search past work across all sessions. Simple workflow: search -> filter -> fetch.
[... instrucciones detalladas con ejemplos de uso de MCP tools ...]
```

---

## Phase 1: Crear skill `cc-skill-creator`

### Que implementar

Crear el directorio y archivos para la skill que guia la creacion de nuevas skills de Claude Code.

**Archivos a crear:**
1. `plugin/skills/cc-skill-creator/SKILL.md` - Instrucciones principales (~150 lineas)
2. `plugin/skills/cc-skill-creator/reference.md` - Referencia completa de frontmatter y patrones (~200 lineas)

**Contenido de SKILL.md:**
- Frontmatter: `name: cc-skill-creator`, `description`, `disable-model-invocation: true`, `argument-hint: [description of the skill to create]`
- Workflow paso a paso: (1) Preguntar objetivo, (2) Decidir tipo (referencia/tarea), (3) Decidir scope (personal/proyecto/plugin), (4) Generar SKILL.md con frontmatter correcto, (5) Crear archivos de soporte si es necesario
- Tabla de decision: cuando usar `disable-model-invocation`, `context: fork`, `allowed-tools`
- Referencia a `reference.md` para detalles de frontmatter

**Contenido de reference.md:**
- Tabla completa de campos de frontmatter (copiada de skills.md lineas 167-178)
- Tabla de control de invocacion (copiada de skills.md lineas 253-257)
- Ejemplos de patrones comunes: skill de referencia, skill de tarea, skill con subagente
- Estructura de directorio de skill
- Sustituciones de cadena disponibles

### Documentacion de referencia
- `claude code docs/skills.md` - Lineas 19-53 (primera skill), 110-178 (frontmatter), 225-257 (control invocacion), 263-298 (herramientas y argumentos), 301-382 (patrones avanzados)
- `plugin/skills/mem-search/SKILL.md` - Patron completo a replicar

### Verificacion
- [ ] `plugin/skills/cc-skill-creator/SKILL.md` existe y tiene frontmatter YAML valido
- [ ] `plugin/skills/cc-skill-creator/reference.md` existe
- [ ] SKILL.md tiene menos de 500 lineas
- [ ] Campos de frontmatter son SOLO los documentados en skills.md
- [ ] Grep por campos inventados: no debe haber `type:`, `priority:`, `tags:` u otros campos inexistentes
- [ ] La skill referencia `reference.md` con link markdown

---

## Phase 2: Crear skill `cc-subagent-creator`

### Que implementar

Crear el directorio y archivos para la skill que guia la creacion de nuevos subagents de Claude Code.

**Archivos a crear:**
1. `plugin/skills/cc-subagent-creator/SKILL.md` - Instrucciones principales (~150 lineas)
2. `plugin/skills/cc-subagent-creator/reference.md` - Referencia completa de frontmatter y patrones (~200 lineas)

**Contenido de SKILL.md:**
- Frontmatter: `name: cc-subagent-creator`, `description`, `disable-model-invocation: true`, `argument-hint: [description of the subagent to create]`
- Workflow paso a paso: (1) Preguntar proposito, (2) Decidir scope (proyecto/usuario/plugin), (3) Elegir modelo, (4) Definir herramientas, (5) Escribir prompt del sistema, (6) Generar archivo markdown con frontmatter
- Tabla de decision de modelo (haiku para rapido/barato, sonnet para equilibrio, opus para maximo, inherit para heredar)
- Guia de seleccion de herramientas (solo lectura vs completo)
- Referencia a `reference.md` para detalles

**Contenido de reference.md:**
- Tabla completa de campos de frontmatter de subagent (copiada de sub-agents.md lineas 206-217)
- Opciones de modelo (sub-agents.md lineas 219-225)
- Herramientas disponibles y restriccion (sub-agents.md lineas 231-244)
- Modos de permiso (sub-agents.md lineas 248-262)
- Memoria persistente (sub-agents.md lineas 286-327)
- Ejemplos completos: code-reviewer, debugger, data-scientist, db-reader (sub-agents.md lineas 607-778)

### Documentacion de referencia
- `claude code docs/sub-agents.md` - Lineas 77-133 (quickstart), 135-177 (scope), 181-217 (frontmatter), 219-327 (configuracion), 594-778 (ejemplos)
- `plugin/skills/mem-search/SKILL.md` - Patron de estructura

### Verificacion
- [ ] `plugin/skills/cc-subagent-creator/SKILL.md` existe y tiene frontmatter YAML valido
- [ ] `plugin/skills/cc-subagent-creator/reference.md` existe
- [ ] SKILL.md tiene menos de 500 lineas
- [ ] Campos de frontmatter del subagent generado son SOLO los documentados en sub-agents.md
- [ ] No se mencionan campos inventados
- [ ] Ejemplos usan solo modelos validos: `sonnet`, `opus`, `haiku`, `inherit`
- [ ] Herramientas listadas son solo las reales: `Read`, `Grep`, `Glob`, `Bash`, `Edit`, `Write`, etc.

---

## Phase 3: Crear skill `cc-extend`

### Que implementar

Crear la skill de referencia/decision que ayuda a elegir el mecanismo de extension correcto de Claude Code.

**Archivos a crear:**
1. `plugin/skills/cc-extend/SKILL.md` - Guia de decision principal (~200 lineas)

**Contenido de SKILL.md:**
- Frontmatter: `name: cc-extend`, `description: Guide for choosing the right Claude Code extension mechanism. Use when users ask "how should I extend Claude Code?", "should I use a skill or subagent?", "what's the difference between hooks and skills?", or need help deciding between extension features.`
- NO `disable-model-invocation` (Claude debe poder auto-invocarlo)
- Tabla comparativa de todas las extensiones (CLAUDE.md, Skills, Subagents, Agent Teams, MCP, Hooks, Plugins)
- Arboles de decision claros:
  - "Necesito que Claude siempre sepa algo" -> CLAUDE.md
  - "Necesito un flujo de trabajo reutilizable" -> Skill
  - "Necesito aislar trabajo pesado" -> Subagent
  - "Necesito conectar a un servicio externo" -> MCP
  - "Necesito automatizar algo determinista" -> Hook
  - "Necesito compartir configuracion" -> Plugin
- Comparaciones directas: Skill vs Subagent, CLAUDE.md vs Skill, Subagent vs Agent Team, MCP vs Skill
- Costo de contexto por feature
- Patrones de combinacion (Skill+MCP, Skill+Subagent, CLAUDE.md+Skills, Hook+MCP)

### Documentacion de referencia
- `claude code docs/features-overview.md` - Lineas 33-43 (tabla principal), 46-129 (comparaciones), 130-151 (combinaciones), 153-240 (costos de contexto)

### Verificacion
- [ ] `plugin/skills/cc-extend/SKILL.md` existe y tiene frontmatter YAML valido
- [ ] SKILL.md tiene menos de 500 lineas
- [ ] NO tiene `disable-model-invocation: true` (debe ser invocable por Claude)
- [ ] Cubre las 7 extensiones: CLAUDE.md, Skills, Subagents, Agent Teams, MCP, Hooks, Plugins
- [ ] Arboles de decision son consistentes con features-overview.md
- [ ] No inventa funcionalidades que no existen en la documentacion

---

## Phase 4: Build, Sync y Verificacion Final

### Que hacer

1. **Build y Sync**: Ejecutar `npm run build-and-sync` para compilar el plugin y sincronizarlo al marketplace local
2. **Verificacion de estructura**: Confirmar que los archivos existen en la ubicacion de instalacion (`~/.claude/plugins/marketplaces/thedotmack/`)
3. **Verificacion de contenido**: Grep por anti-patrones en todos los archivos creados

### Comandos de verificacion

```bash
# Verificar que los archivos existen
ls -la plugin/skills/cc-skill-creator/
ls -la plugin/skills/cc-subagent-creator/
ls -la plugin/skills/cc-extend/

# Verificar frontmatter valido (debe empezar con ---)
head -1 plugin/skills/cc-skill-creator/SKILL.md
head -1 plugin/skills/cc-subagent-creator/SKILL.md
head -1 plugin/skills/cc-extend/SKILL.md

# Verificar que no hay campos de frontmatter inventados
grep -n "^type:" plugin/skills/*/SKILL.md        # NO debe encontrar nada
grep -n "^priority:" plugin/skills/*/SKILL.md     # NO debe encontrar nada
grep -n "^tags:" plugin/skills/*/SKILL.md         # NO debe encontrar nada

# Verificar que cc-extend NO tiene disable-model-invocation
grep "disable-model-invocation" plugin/skills/cc-extend/SKILL.md  # NO debe encontrar

# Verificar que cc-skill-creator y cc-subagent-creator SI lo tienen
grep "disable-model-invocation: true" plugin/skills/cc-skill-creator/SKILL.md   # DEBE encontrar
grep "disable-model-invocation: true" plugin/skills/cc-subagent-creator/SKILL.md # DEBE encontrar

# Contar lineas (debe ser < 500)
wc -l plugin/skills/*/SKILL.md

# Build y sync
npm run build-and-sync
```

### Checklist final
- [ ] 3 skills creadas correctamente en `plugin/skills/`
- [ ] Todas las skills siguen el patron de `mem-search`
- [ ] Todos los campos de frontmatter son validos segun la documentacion oficial
- [ ] SKILL.md < 500 lineas para todas las skills
- [ ] reference.md existe para cc-skill-creator y cc-subagent-creator
- [ ] cc-extend NO tiene disable-model-invocation
- [ ] cc-skill-creator y cc-subagent-creator SI tienen disable-model-invocation
- [ ] Build exitoso sin errores
- [ ] No hay anti-patrones (campos inventados, modelos invalidos, herramientas inexistentes)
