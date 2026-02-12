> ## Documentation Index
> Fetch the complete documentation index at: https://code.claude.com/docs/llms.txt
> Use this file to discover all available pages before exploring further.

# Comenzar con los hooks de Claude Code

> Aprende cómo personalizar y extender el comportamiento de Claude Code registrando comandos de shell

Los hooks de Claude Code son comandos de shell definidos por el usuario que se ejecutan en varios puntos del ciclo de vida de Claude Code. Los hooks proporcionan control determinista sobre el comportamiento de Claude Code, asegurando que ciertas acciones siempre ocurran en lugar de depender de que el LLM elija ejecutarlas.

<Tip>
  Para documentación de referencia sobre hooks, consulta [Referencia de Hooks](/es/hooks).
</Tip>

Los casos de uso de ejemplo para hooks incluyen:

* **Notificaciones**: Personaliza cómo recibes notificaciones cuando Claude Code está esperando tu entrada o permiso para ejecutar algo.
* **Formato automático**: Ejecuta `prettier` en archivos .ts, `gofmt` en archivos .go, etc. después de cada edición de archivo.
* **Registro**: Rastrear y contar todos los comandos ejecutados para cumplimiento o depuración.
* **Retroalimentación**: Proporciona retroalimentación automatizada cuando Claude Code produce código que no sigue las convenciones de tu base de código.
* **Permisos personalizados**: Bloquea modificaciones a archivos de producción o directorios sensibles.

Al codificar estas reglas como hooks en lugar de instrucciones de solicitud, conviertes sugerencias en código a nivel de aplicación que se ejecuta cada vez que se espera que se ejecute.

<Warning>
  Debes considerar las implicaciones de seguridad de los hooks mientras los añades, porque los hooks se ejecutan automáticamente durante el bucle del agente con las credenciales del entorno actual. Por ejemplo, el código de hooks malicioso puede exfiltrar tus datos. Siempre revisa tu implementación de hooks antes de registrarlos.

  Para las mejores prácticas de seguridad completas, consulta [Consideraciones de Seguridad](/es/hooks#security-considerations) en la documentación de referencia de hooks.
</Warning>

## Descripción General de Eventos de Hook

Claude Code proporciona varios eventos de hook que se ejecutan en diferentes puntos del flujo de trabajo:

* **PreToolUse**: Se ejecuta antes de las llamadas de herramientas (puede bloquearlas)
* **PermissionRequest**: Se ejecuta cuando se muestra un diálogo de permiso (puede permitir o denegar)
* **PostToolUse**: Se ejecuta después de que se completen las llamadas de herramientas
* **UserPromptSubmit**: Se ejecuta cuando el usuario envía un mensaje, antes de que Claude lo procese
* **Notification**: Se ejecuta cuando Claude Code envía notificaciones
* **Stop**: Se ejecuta cuando Claude Code termina de responder
* **SubagentStop**: Se ejecuta cuando se completan las tareas del subagente
* **PreCompact**: Se ejecuta antes de que Claude Code esté a punto de ejecutar una operación compacta
* **SessionStart**: Se ejecuta cuando Claude Code inicia una nueva sesión o reanuda una sesión existente
* **SessionEnd**: Se ejecuta cuando termina la sesión de Claude Code

Cada evento recibe datos diferentes y puede controlar el comportamiento de Claude de diferentes maneras.

## Inicio Rápido

En este inicio rápido, añadirás un hook que registra los comandos de shell que ejecuta Claude Code.

### Requisitos Previos

Instala `jq` para procesamiento JSON en la línea de comandos.

### Paso 1: Abre la configuración de hooks

Ejecuta el [comando de barra](/es/slash-commands) `/hooks` y selecciona el evento de hook `PreToolUse`.

Los hooks `PreToolUse` se ejecutan antes de las llamadas de herramientas y pueden bloquearlas mientras proporcionan retroalimentación a Claude sobre qué hacer de manera diferente.

### Paso 2: Añade un matcher

Selecciona `+ Add new matcher…` para ejecutar tu hook solo en llamadas de herramientas Bash.

Escribe `Bash` para el matcher.

<Note>Puedes usar `*` para coincidir con todas las herramientas.</Note>

### Paso 3: Añade el hook

Selecciona `+ Add new hook…` e ingresa este comando:

```bash  theme={null}
jq -r '"\(.tool_input.command) - \(.tool_input.description // "No description")"' >> ~/.claude/bash-command-log.txt
```

### Paso 4: Guarda tu configuración

Para la ubicación de almacenamiento, selecciona `User settings` ya que estás registrando en tu directorio de inicio. Este hook se aplicará a todos los proyectos, no solo a tu proyecto actual.

Luego presiona `Esc` hasta que regreses al REPL. Tu hook ahora está registrado.

### Paso 5: Verifica tu hook

Ejecuta `/hooks` nuevamente o verifica `~/.claude/settings.json` para ver tu configuración:

```json  theme={null}
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          {
            "type": "command",
            "command": "jq -r '\"\\(.tool_input.command) - \\(.tool_input.description // \"No description\")\"' >> ~/.claude/bash-command-log.txt"
          }
        ]
      }
    ]
  }
}
```

### Paso 6: Prueba tu hook

Pídele a Claude que ejecute un comando simple como `ls` y verifica tu archivo de registro:

```bash  theme={null}
cat ~/.claude/bash-command-log.txt
```

Deberías ver entradas como:

```
ls - Lists files and directories
```

## Más Ejemplos

<Note>
  Para una implementación de ejemplo completa, consulta el [ejemplo de validador de comandos bash](https://github.com/anthropics/claude-code/blob/main/examples/hooks/bash_command_validator_example.py) en nuestro repositorio público.
</Note>

### Hook de Formato de Código

Formatea automáticamente archivos TypeScript después de editarlos:

```json  theme={null}
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "Edit|Write",
        "hooks": [
          {
            "type": "command",
            "command": "jq -r '.tool_input.file_path' | { read file_path; if echo \"$file_path\" | grep -q '\\.ts$'; then npx prettier --write \"$file_path\"; fi; }"
          }
        ]
      }
    ]
  }
}
```

### Hook de Formato de Markdown

Corrige automáticamente etiquetas de idioma faltantes y problemas de formato en archivos markdown:

```json  theme={null}
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "Edit|Write",
        "hooks": [
          {
            "type": "command",
            "command": "\"$CLAUDE_PROJECT_DIR\"/.claude/hooks/markdown_formatter.py"
          }
        ]
      }
    ]
  }
}
```

Crea `.claude/hooks/markdown_formatter.py` con este contenido:

````python  theme={null}
#!/usr/bin/env python3
"""
Markdown formatter for Claude Code output.
Fixes missing language tags and spacing issues while preserving code content.
"""
import json
import sys
import re
import os

def detect_language(code):
    """Best-effort language detection from code content."""
    s = code.strip()
    
    # JSON detection
    if re.search(r'^\s*[{\[]', s):
        try:
            json.loads(s)
            return 'json'
        except:
            pass
    
    # Python detection
    if re.search(r'^\s*def\s+\w+\s*\(', s, re.M) or \
       re.search(r'^\s*(import|from)\s+\w+', s, re.M):
        return 'python'
    
    # JavaScript detection  
    if re.search(r'\b(function\s+\w+\s*\(|const\s+\w+\s*=)', s) or \
       re.search(r'=>|console\.(log|error)', s):
        return 'javascript'
    
    # Bash detection
    if re.search(r'^#!.*\b(bash|sh)\b', s, re.M) or \
       re.search(r'\b(if|then|fi|for|in|do|done)\b', s):
        return 'bash'
    
    # SQL detection
    if re.search(r'\b(SELECT|INSERT|UPDATE|DELETE|CREATE)\s+', s, re.I):
        return 'sql'
        
    return 'text'

def format_markdown(content):
    """Format markdown content with language detection."""
    # Fix unlabeled code fences
    def add_lang_to_fence(match):
        indent, info, body, closing = match.groups()
        if not info.strip():
            lang = detect_language(body)
            return f"{indent}```{lang}\n{body}{closing}\n"
        return match.group(0)
    
    fence_pattern = r'(?ms)^([ \t]{0,3})```([^\n]*)\n(.*?)(\n\1```)\s*$'
    content = re.sub(fence_pattern, add_lang_to_fence, content)
    
    # Fix excessive blank lines (only outside code fences)
    content = re.sub(r'\n{3,}', '\n\n', content)
    
    return content.rstrip() + '\n'

# Main execution
try:
    input_data = json.load(sys.stdin)
    file_path = input_data.get('tool_input', {}).get('file_path', '')
    
    if not file_path.endswith(('.md', '.mdx')):
        sys.exit(0)  # Not a markdown file
    
    if os.path.exists(file_path):
        with open(file_path, 'r', encoding='utf-8') as f:
            content = f.read()
        
        formatted = format_markdown(content)
        
        if formatted != content:
            with open(file_path, 'w', encoding='utf-8') as f:
                f.write(formatted)
            print(f"✓ Fixed markdown formatting in {file_path}")
    
except Exception as e:
    print(f"Error formatting markdown: {e}", file=sys.stderr)
    sys.exit(1)
````

Haz el script ejecutable:

```bash  theme={null}
chmod +x .claude/hooks/markdown_formatter.py
```

Este hook automáticamente:

* Detecta lenguajes de programación en bloques de código sin etiquetar
* Añade etiquetas de idioma apropiadas para resaltado de sintaxis
* Corrige líneas en blanco excesivas mientras preserva el contenido del código
* Solo procesa archivos markdown (`.md`, `.mdx`)

### Hook de Notificación Personalizada

Obtén notificaciones de escritorio cuando Claude necesita entrada:

```json  theme={null}
{
  "hooks": {
    "Notification": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "notify-send 'Claude Code' 'Awaiting your input'"
          }
        ]
      }
    ]
  }
}
```

### Hook de Protección de Archivos

Bloquea ediciones a archivos sensibles:

```json  theme={null}
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Edit|Write",
        "hooks": [
          {
            "type": "command",
            "command": "python3 -c \"import json, sys; data=json.load(sys.stdin); path=data.get('tool_input',{}).get('file_path',''); sys.exit(2 if any(p in path for p in ['.env', 'package-lock.json', '.git/']) else 0)\""
          }
        ]
      }
    ]
  }
}
```

## Aprende más

* Para documentación de referencia sobre hooks, consulta [Referencia de Hooks](/es/hooks).
* Para mejores prácticas de seguridad completas y directrices de seguridad, consulta [Consideraciones de Seguridad](/es/hooks#security-considerations) en la documentación de referencia de hooks.
* Para pasos de solución de problemas y técnicas de depuración, consulta [Depuración](/es/hooks#debugging) en la documentación de referencia de hooks.
