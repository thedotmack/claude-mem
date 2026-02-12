> ## Documentation Index
> Fetch the complete documentation index at: https://code.claude.com/docs/llms.txt
> Use this file to discover all available pages before exploring further.

# Conecta Claude Code a herramientas a través de MCP

> Aprende cómo conectar Claude Code a tus herramientas con el Model Context Protocol.

export const MCPServersTable = ({platform = "all"}) => {
  const ifYouAreAnAiAgentReadingThisYouShouldInsteadFetch = 'https://api.anthropic.com/mcp-registry/docs';
  const [servers, setServers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  useEffect(() => {
    const fetchServers = async () => {
      try {
        setLoading(true);
        const allServers = [];
        let cursor = null;
        do {
          const url = new URL('https://api.anthropic.com/mcp-registry/v0/servers');
          url.searchParams.set('version', 'latest');
          url.searchParams.set('visibility', 'commercial');
          url.searchParams.set('limit', '100');
          if (cursor) {
            url.searchParams.set('cursor', cursor);
          }
          const response = await fetch(url);
          if (!response.ok) {
            throw new Error(`Failed to fetch MCP registry: ${response.status}`);
          }
          const data = await response.json();
          allServers.push(...data.servers);
          cursor = data.metadata?.nextCursor || null;
        } while (cursor);
        const transformedServers = allServers.map(item => {
          const server = item.server;
          const meta = item._meta?.['com.anthropic.api/mcp-registry'] || ({});
          const worksWith = meta.worksWith || [];
          const availability = {
            claudeCode: worksWith.includes('claude-code'),
            mcpConnector: worksWith.includes('claude-api'),
            claudeDesktop: worksWith.includes('claude-desktop')
          };
          const remotes = server.remotes || [];
          const httpRemote = remotes.find(r => r.type === 'streamable-http');
          const sseRemote = remotes.find(r => r.type === 'sse');
          const preferredRemote = httpRemote || sseRemote;
          const remoteUrl = preferredRemote?.url || meta.url;
          const remoteType = preferredRemote?.type;
          const isTemplatedUrl = remoteUrl?.includes('{');
          let setupUrl;
          if (isTemplatedUrl && meta.requiredFields) {
            const urlField = meta.requiredFields.find(f => f.field === 'url');
            setupUrl = urlField?.sourceUrl || meta.documentation;
          }
          const urls = {};
          if (!isTemplatedUrl) {
            if (remoteType === 'streamable-http') {
              urls.http = remoteUrl;
            } else if (remoteType === 'sse') {
              urls.sse = remoteUrl;
            }
          }
          let envVars = [];
          if (server.packages && server.packages.length > 0) {
            const npmPackage = server.packages.find(p => p.registryType === 'npm');
            if (npmPackage) {
              urls.stdio = `npx -y ${npmPackage.identifier}`;
              if (npmPackage.environmentVariables) {
                envVars = npmPackage.environmentVariables;
              }
            }
          }
          return {
            name: meta.displayName || server.title || server.name,
            description: meta.oneLiner || server.description,
            documentation: meta.documentation,
            urls: urls,
            envVars: envVars,
            availability: availability,
            customCommands: meta.claudeCodeCopyText ? {
              claudeCode: meta.claudeCodeCopyText
            } : undefined,
            setupUrl: setupUrl
          };
        });
        setServers(transformedServers);
        setError(null);
      } catch (err) {
        setError(err.message);
        console.error('Error fetching MCP registry:', err);
      } finally {
        setLoading(false);
      }
    };
    fetchServers();
  }, []);
  const generateClaudeCodeCommand = server => {
    if (server.customCommands && server.customCommands.claudeCode) {
      return server.customCommands.claudeCode;
    }
    const serverSlug = server.name.toLowerCase().replace(/[^a-z0-9]/g, '-');
    if (server.urls.http) {
      return `claude mcp add ${serverSlug} --transport http ${server.urls.http}`;
    }
    if (server.urls.sse) {
      return `claude mcp add ${serverSlug} --transport sse ${server.urls.sse}`;
    }
    if (server.urls.stdio) {
      const envFlags = server.envVars && server.envVars.length > 0 ? server.envVars.map(v => `--env ${v.name}=YOUR_${v.name}`).join(' ') : '';
      const baseCommand = `claude mcp add ${serverSlug} --transport stdio`;
      return envFlags ? `${baseCommand} ${envFlags} -- ${server.urls.stdio}` : `${baseCommand} -- ${server.urls.stdio}`;
    }
    return null;
  };
  if (loading) {
    return <div>Loading MCP servers...</div>;
  }
  if (error) {
    return <div>Error loading MCP servers: {error}</div>;
  }
  const filteredServers = servers.filter(server => {
    if (platform === "claudeCode") {
      return server.availability.claudeCode;
    } else if (platform === "mcpConnector") {
      return server.availability.mcpConnector;
    } else if (platform === "claudeDesktop") {
      return server.availability.claudeDesktop;
    } else if (platform === "all") {
      return true;
    } else {
      throw new Error(`Unknown platform: ${platform}`);
    }
  });
  return <>
      <style jsx>{`
        .cards-container {
          display: grid;
          gap: 1rem;
          margin-bottom: 2rem;
        }
        .server-card {
          border: 1px solid var(--border-color, #e5e7eb);
          border-radius: 6px;
          padding: 1rem;
        }
        .command-row {
          display: flex;
          align-items: center;
          gap: 0.25rem;
        }
        .command-row code {
          font-size: 0.75rem;
          overflow-x: auto;
        }
      `}</style>

      <div className="cards-container">
        {filteredServers.map(server => {
    const claudeCodeCommand = generateClaudeCodeCommand(server);
    const mcpUrl = server.urls.http || server.urls.sse;
    const commandToShow = platform === "claudeCode" ? claudeCodeCommand : mcpUrl;
    return <div key={server.name} className="server-card">
              <div>
                {server.documentation ? <a href={server.documentation}>
                    <strong>{server.name}</strong>
                  </a> : <strong>{server.name}</strong>}
              </div>

              <p style={{
      margin: '0.5rem 0',
      fontSize: '0.9rem'
    }}>
                {server.description}
              </p>

              {server.setupUrl && <p style={{
      margin: '0.25rem 0',
      fontSize: '0.8rem',
      fontStyle: 'italic',
      opacity: 0.7
    }}>
                  Requires user-specific URL.{' '}
                  <a href={server.setupUrl} style={{
      textDecoration: 'underline'
    }}>
                    Get your URL here
                  </a>.
                </p>}

              {commandToShow && !server.setupUrl && <>
                <p style={{
      display: 'block',
      fontSize: '0.75rem',
      fontWeight: 500,
      minWidth: 'fit-content',
      marginTop: '0.5rem',
      marginBottom: 0
    }}>
                  {platform === "claudeCode" ? "Command" : "URL"}
                </p>
                <div className="command-row">
                  <code>
                    {commandToShow}
                  </code>
                </div>
              </>}
            </div>;
  })}
      </div>
    </>;
};

Claude Code puede conectarse a cientos de herramientas externas y fuentes de datos a través del [Model Context Protocol (MCP)](https://modelcontextprotocol.io/introduction), un estándar de código abierto para integraciones de IA con herramientas. Los servidores MCP dan a Claude Code acceso a tus herramientas, bases de datos y APIs.

## Qué puedes hacer con MCP

Con servidores MCP conectados, puedes pedirle a Claude Code que:

* **Implemente características desde rastreadores de problemas**: "Añade la característica descrita en el problema JIRA ENG-4521 y crea un PR en GitHub."
* **Analice datos de monitoreo**: "Revisa Sentry y Statsig para verificar el uso de la característica descrita en ENG-4521."
* **Consulte bases de datos**: "Encuentra correos electrónicos de 10 usuarios aleatorios que usaron la característica ENG-4521, basándote en nuestra base de datos PostgreSQL."
* **Integre diseños**: "Actualiza nuestra plantilla de correo electrónico estándar basándote en los nuevos diseños de Figma que se publicaron en Slack"
* **Automatice flujos de trabajo**: "Crea borradores de Gmail invitando a estos 10 usuarios a una sesión de retroalimentación sobre la nueva característica."

## Servidores MCP populares

Aquí hay algunos servidores MCP comúnmente utilizados que puedes conectar a Claude Code:

<Warning>
  Usa servidores MCP de terceros bajo tu propio riesgo - Anthropic no ha verificado
  la corrección o seguridad de todos estos servidores.
  Asegúrate de confiar en los servidores MCP que estés instalando.
  Ten especial cuidado al usar servidores MCP que podrían obtener contenido no confiable,
  ya que estos pueden exponerte al riesgo de inyección de indicaciones.
</Warning>

<MCPServersTable platform="claudeCode" />

<Note>
  **¿Necesitas una integración específica?** [Encuentra cientos más servidores MCP en GitHub](https://github.com/modelcontextprotocol/servers), o crea el tuyo propio usando el [SDK de MCP](https://modelcontextprotocol.io/quickstart/server).
</Note>

## Instalación de servidores MCP

Los servidores MCP se pueden configurar de tres formas diferentes según tus necesidades:

### Opción 1: Añade un servidor HTTP remoto

Los servidores HTTP son la opción recomendada para conectarse a servidores MCP remotos. Este es el transporte más ampliamente soportado para servicios basados en la nube.

```bash  theme={null}
# Sintaxis básica
claude mcp add --transport http <nombre> <url>

# Ejemplo real: Conectar a Notion
claude mcp add --transport http notion https://mcp.notion.com/mcp

# Ejemplo con token Bearer
claude mcp add --transport http secure-api https://api.example.com/mcp \
  --header "Authorization: Bearer your-token"
```

### Opción 2: Añade un servidor SSE remoto

<Warning>
  El transporte SSE (Server-Sent Events) está deprecado. Usa servidores HTTP en su lugar, donde estén disponibles.
</Warning>

```bash  theme={null}
# Sintaxis básica
claude mcp add --transport sse <nombre> <url>

# Ejemplo real: Conectar a Asana
claude mcp add --transport sse asana https://mcp.asana.com/sse

# Ejemplo con encabezado de autenticación
claude mcp add --transport sse private-api https://api.company.com/sse \
  --header "X-API-Key: your-key-here"
```

### Opción 3: Añade un servidor stdio local

Los servidores Stdio se ejecutan como procesos locales en tu máquina. Son ideales para herramientas que necesitan acceso directo al sistema u scripts personalizados.

```bash  theme={null}
# Sintaxis básica
claude mcp add [opciones] <nombre> -- <comando> [args...]

# Ejemplo real: Añadir servidor Airtable
claude mcp add --transport stdio --env AIRTABLE_API_KEY=YOUR_KEY airtable \
  -- npx -y airtable-mcp-server
```

<Note>
  **Importante: Orden de opciones**

  Todas las opciones (`--transport`, `--env`, `--scope`, `--header`) deben venir **antes** del nombre del servidor. El `--` (doble guión) luego separa el nombre del servidor del comando y argumentos que se pasan al servidor MCP.

  Por ejemplo:

  * `claude mcp add --transport stdio myserver -- npx server` → ejecuta `npx server`
  * `claude mcp add --transport stdio --env KEY=value myserver -- python server.py --port 8080` → ejecuta `python server.py --port 8080` con `KEY=value` en el entorno

  Esto previene conflictos entre las banderas de Claude y las banderas del servidor.
</Note>

### Gestión de tus servidores

Una vez configurados, puedes gestionar tus servidores MCP con estos comandos:

```bash  theme={null}
# Listar todos los servidores configurados
claude mcp list

# Obtener detalles de un servidor específico
claude mcp get github

# Eliminar un servidor
claude mcp remove github

# (dentro de Claude Code) Verificar estado del servidor
/mcp
```

### Actualizaciones dinámicas de herramientas

Claude Code soporta notificaciones `list_changed` de MCP, permitiendo que los servidores MCP actualicen dinámicamente sus herramientas disponibles, indicaciones y recursos sin requerir que te desconectes y reconectes. Cuando un servidor MCP envía una notificación `list_changed`, Claude Code automáticamente actualiza las capacidades disponibles de ese servidor.

<Tip>
  Consejos:

  * Usa la bandera `--scope` para especificar dónde se almacena la configuración:
    * `local` (predeterminado): Disponible solo para ti en el proyecto actual (se llamaba `project` en versiones anteriores)
    * `project`: Compartido con todos en el proyecto a través del archivo `.mcp.json`
    * `user`: Disponible para ti en todos los proyectos (se llamaba `global` en versiones anteriores)
  * Establece variables de entorno con banderas `--env` (por ejemplo, `--env KEY=value`)
  * Configura el tiempo de espera de inicio del servidor MCP usando la variable de entorno MCP\_TIMEOUT (por ejemplo, `MCP_TIMEOUT=10000 claude` establece un tiempo de espera de 10 segundos)
  * Claude Code mostrará una advertencia cuando la salida de la herramienta MCP exceda 10,000 tokens. Para aumentar este límite, establece la variable de entorno `MAX_MCP_OUTPUT_TOKENS` (por ejemplo, `MAX_MCP_OUTPUT_TOKENS=50000`)
  * Usa `/mcp` para autenticarte con servidores remotos que requieren autenticación OAuth 2.0
</Tip>

<Warning>
  **Usuarios de Windows**: En Windows nativo (no WSL), los servidores MCP locales que usan `npx` requieren el envoltorio `cmd /c` para asegurar una ejecución adecuada.

  ```bash  theme={null}
  # Esto crea command="cmd" que Windows puede ejecutar
  claude mcp add --transport stdio my-server -- cmd /c npx -y @some/package
  ```

  Sin el envoltorio `cmd /c`, encontrarás errores de "Connection closed" porque Windows no puede ejecutar directamente `npx`. (Consulta la nota anterior para una explicación del parámetro `--`.)
</Warning>

### Servidores MCP proporcionados por complementos

Los [complementos](/es/plugins) pueden agrupar servidores MCP, proporcionando automáticamente herramientas e integraciones cuando el complemento está habilitado. Los servidores MCP de complementos funcionan de manera idéntica a los servidores configurados por el usuario.

**Cómo funcionan los servidores MCP de complementos**:

* Los complementos definen servidores MCP en `.mcp.json` en la raíz del complemento o en línea en `plugin.json`
* Cuando un complemento está habilitado, sus servidores MCP se inician automáticamente
* Las herramientas MCP del complemento aparecen junto a las herramientas MCP configuradas manualmente
* Los servidores de complementos se gestionan a través de la instalación del complemento (no mediante comandos `/mcp`)

**Ejemplo de configuración MCP de complemento**:

En `.mcp.json` en la raíz del complemento:

```json  theme={null}
{
  "database-tools": {
    "command": "${CLAUDE_PLUGIN_ROOT}/servers/db-server",
    "args": ["--config", "${CLAUDE_PLUGIN_ROOT}/config.json"],
    "env": {
      "DB_URL": "${DB_URL}"
    }
  }
}
```

O en línea en `plugin.json`:

```json  theme={null}
{
  "name": "my-plugin",
  "mcpServers": {
    "plugin-api": {
      "command": "${CLAUDE_PLUGIN_ROOT}/servers/api-server",
      "args": ["--port", "8080"]
    }
  }
}
```

**Características de MCP de complementos**:

* **Ciclo de vida automático**: Los servidores se inician cuando el complemento se habilita, pero debes reiniciar Claude Code para aplicar cambios en el servidor MCP (habilitación o deshabilitación)
* **Variables de entorno**: Usa `${CLAUDE_PLUGIN_ROOT}` para rutas relativas al complemento
* **Acceso a variables de entorno del usuario**: Acceso a las mismas variables de entorno que los servidores configurados manualmente
* **Múltiples tipos de transporte**: Soporte para transportes stdio, SSE e HTTP (el soporte de transporte puede variar según el servidor)

**Visualización de servidores MCP de complementos**:

```bash  theme={null}
# Dentro de Claude Code, ve todos los servidores MCP incluyendo los de complementos
/mcp
```

Los servidores de complementos aparecen en la lista con indicadores que muestran que provienen de complementos.

**Beneficios de los servidores MCP de complementos**:

* **Distribución agrupada**: Herramientas y servidores empaquetados juntos
* **Configuración automática**: No se requiere configuración manual de MCP
* **Consistencia del equipo**: Todos obtienen las mismas herramientas cuando se instala el complemento

Consulta la [referencia de componentes de complementos](/es/plugins-reference#mcp-servers) para obtener detalles sobre cómo agrupar servidores MCP con complementos.

## Alcances de instalación de MCP

Los servidores MCP se pueden configurar en tres niveles de alcance diferentes, cada uno sirviendo propósitos distintos para gestionar la accesibilidad del servidor y el intercambio. Comprender estos alcances te ayuda a determinar la mejor manera de configurar servidores para tus necesidades específicas.

### Alcance local

Los servidores con alcance local representan el nivel de configuración predeterminado y se almacenan en `~/.claude.json` bajo la ruta de tu proyecto. Estos servidores permanecen privados para ti y solo son accesibles cuando trabajas dentro del directorio del proyecto actual. Este alcance es ideal para servidores de desarrollo personal, configuraciones experimentales o servidores que contienen credenciales sensibles que no deben compartirse.

```bash  theme={null}
# Añadir un servidor con alcance local (predeterminado)
claude mcp add --transport http stripe https://mcp.stripe.com

# Especificar explícitamente el alcance local
claude mcp add --transport http stripe --scope local https://mcp.stripe.com
```

### Alcance de proyecto

Los servidores con alcance de proyecto habilitan la colaboración en equipo almacenando configuraciones en un archivo `.mcp.json` en el directorio raíz de tu proyecto. Este archivo está diseñado para ser verificado en el control de versiones, asegurando que todos los miembros del equipo tengan acceso a las mismas herramientas y servicios MCP. Cuando añades un servidor con alcance de proyecto, Claude Code automáticamente crea o actualiza este archivo con la estructura de configuración apropiada.

```bash  theme={null}
# Añadir un servidor con alcance de proyecto
claude mcp add --transport http paypal --scope project https://mcp.paypal.com/mcp
```

El archivo `.mcp.json` resultante sigue un formato estandarizado:

```json  theme={null}
{
  "mcpServers": {
    "shared-server": {
      "command": "/path/to/server",
      "args": [],
      "env": {}
    }
  }
}
```

Por razones de seguridad, Claude Code solicita aprobación antes de usar servidores con alcance de proyecto desde archivos `.mcp.json`. Si necesitas restablecer estas opciones de aprobación, usa el comando `claude mcp reset-project-choices`.

### Alcance de usuario

Los servidores con alcance de usuario se almacenan en `~/.claude.json` y proporcionan accesibilidad entre proyectos, haciéndolos disponibles en todos los proyectos en tu máquina mientras permanecen privados para tu cuenta de usuario. Este alcance funciona bien para servidores de utilidad personal, herramientas de desarrollo o servicios que usas frecuentemente en diferentes proyectos.

```bash  theme={null}
# Añadir un servidor de usuario
claude mcp add --transport http hubspot --scope user https://mcp.hubspot.com/anthropic
```

### Elegir el alcance correcto

Selecciona tu alcance basándote en:

* **Alcance local**: Servidores personales, configuraciones experimentales o credenciales sensibles específicas de un proyecto
* **Alcance de proyecto**: Servidores compartidos en equipo, herramientas específicas del proyecto o servicios requeridos para la colaboración
* **Alcance de usuario**: Utilidades personales necesarias en múltiples proyectos, herramientas de desarrollo o servicios frecuentemente utilizados

<Note>
  **¿Dónde se almacenan los servidores MCP?**

  * **Alcance de usuario y local**: `~/.claude.json` (en el campo `mcpServers` o bajo rutas de proyecto)
  * **Alcance de proyecto**: `.mcp.json` en la raíz de tu proyecto (verificado en el control de versiones)
  * **Gestionado**: `managed-mcp.json` en directorios del sistema (consulta [Configuración MCP gestionada](#managed-mcp-configuration))
</Note>

### Jerarquía de alcance y precedencia

Las configuraciones del servidor MCP siguen una clara jerarquía de precedencia. Cuando existen servidores con el mismo nombre en múltiples alcances, el sistema resuelve conflictos priorizando primero los servidores con alcance local, seguidos por los servidores con alcance de proyecto y finalmente los servidores con alcance de usuario. Este diseño asegura que las configuraciones personales puedan anular las compartidas cuando sea necesario.

### Expansión de variables de entorno en `.mcp.json`

Claude Code soporta la expansión de variables de entorno en archivos `.mcp.json`, permitiendo que los equipos compartan configuraciones mientras mantienen flexibilidad para rutas específicas de máquina y valores sensibles como claves API.

**Sintaxis soportada:**

* `${VAR}` - Se expande al valor de la variable de entorno `VAR`
* `${VAR:-default}` - Se expande a `VAR` si está establecida, de lo contrario usa `default`

**Ubicaciones de expansión:**
Las variables de entorno se pueden expandir en:

* `command` - La ruta del ejecutable del servidor
* `args` - Argumentos de línea de comandos
* `env` - Variables de entorno pasadas al servidor
* `url` - Para tipos de servidor HTTP
* `headers` - Para autenticación de servidor HTTP

**Ejemplo con expansión de variables:**

```json  theme={null}
{
  "mcpServers": {
    "api-server": {
      "type": "http",
      "url": "${API_BASE_URL:-https://api.example.com}/mcp",
      "headers": {
        "Authorization": "Bearer ${API_KEY}"
      }
    }
  }
}
```

Si una variable de entorno requerida no está establecida y no tiene un valor predeterminado, Claude Code fallará al analizar la configuración.

## Ejemplos prácticos

{/* ### Ejemplo: Automatizar pruebas de navegador con Playwright

  ```bash
  # 1. Añadir el servidor MCP de Playwright
  claude mcp add --transport stdio playwright -- npx -y @playwright/mcp@latest

  # 2. Escribir y ejecutar pruebas de navegador
  > "Prueba si el flujo de inicio de sesión funciona con test@example.com"
  > "Toma una captura de pantalla de la página de pago en móvil"
  > "Verifica que la función de búsqueda devuelve resultados"
  ``` */}

### Ejemplo: Monitorear errores con Sentry

```bash  theme={null}
# 1. Añadir el servidor MCP de Sentry
claude mcp add --transport http sentry https://mcp.sentry.dev/mcp

# 2. Usar /mcp para autenticarte con tu cuenta de Sentry
> /mcp

# 3. Depurar problemas de producción
> "¿Cuáles son los errores más comunes en las últimas 24 horas?"
> "Muéstrame el seguimiento de pila para el ID de error abc123"
> "¿Qué despliegue introdujo estos nuevos errores?"
```

### Ejemplo: Conectar a GitHub para revisiones de código

```bash  theme={null}
# 1. Añadir el servidor MCP de GitHub
claude mcp add --transport http github https://api.githubcopilot.com/mcp/

# 2. En Claude Code, autenticarte si es necesario
> /mcp
# Selecciona "Authenticate" para GitHub

# 3. Ahora puedes pedirle a Claude que trabaje con GitHub
> "Revisa el PR #456 y sugiere mejoras"
> "Crea un nuevo problema para el error que acabamos de encontrar"
> "Muéstrame todos los PRs abiertos asignados a mí"
```

### Ejemplo: Consultar tu base de datos PostgreSQL

```bash  theme={null}
# 1. Añadir el servidor de base de datos con tu cadena de conexión
claude mcp add --transport stdio db -- npx -y @bytebase/dbhub \
  --dsn "postgresql://readonly:pass@prod.db.com:5432/analytics"

# 2. Consulta tu base de datos naturalmente
> "¿Cuál es nuestro ingreso total este mes?"
> "Muéstrame el esquema de la tabla de pedidos"
> "Encuentra clientes que no han realizado una compra en 90 días"
```

## Autenticarse con servidores MCP remotos

Muchos servidores MCP basados en la nube requieren autenticación. Claude Code soporta OAuth 2.0 para conexiones seguras.

<Steps>
  <Step title="Añade el servidor que requiere autenticación">
    Por ejemplo:

    ```bash  theme={null}
    claude mcp add --transport http sentry https://mcp.sentry.dev/mcp
    ```
  </Step>

  <Step title="Usa el comando /mcp dentro de Claude Code">
    En Claude Code, usa el comando:

    ```
    > /mcp
    ```

    Luego sigue los pasos en tu navegador para iniciar sesión.
  </Step>
</Steps>

<Tip>
  Consejos:

  * Los tokens de autenticación se almacenan de forma segura y se actualizan automáticamente
  * Usa "Clear authentication" en el menú `/mcp` para revocar el acceso
  * Si tu navegador no se abre automáticamente, copia la URL proporcionada
  * La autenticación OAuth funciona con servidores HTTP
</Tip>

## Añadir servidores MCP desde configuración JSON

Si tienes una configuración JSON para un servidor MCP, puedes añadirla directamente:

<Steps>
  <Step title="Añadir un servidor MCP desde JSON">
    ```bash  theme={null}
    # Sintaxis básica
    claude mcp add-json <nombre> '<json>'

    # Ejemplo: Añadir un servidor HTTP con configuración JSON
    claude mcp add-json weather-api '{"type":"http","url":"https://api.weather.com/mcp","headers":{"Authorization":"Bearer token"}}'

    # Ejemplo: Añadir un servidor stdio con configuración JSON
    claude mcp add-json local-weather '{"type":"stdio","command":"/path/to/weather-cli","args":["--api-key","abc123"],"env":{"CACHE_DIR":"/tmp"}}'
    ```
  </Step>

  <Step title="Verificar que el servidor fue añadido">
    ```bash  theme={null}
    claude mcp get weather-api
    ```
  </Step>
</Steps>

<Tip>
  Consejos:

  * Asegúrate de que el JSON esté correctamente escapado en tu shell
  * El JSON debe conformarse al esquema de configuración del servidor MCP
  * Puedes usar `--scope user` para añadir el servidor a tu configuración de usuario en lugar de la específica del proyecto
</Tip>

## Importar servidores MCP desde Claude Desktop

Si ya has configurado servidores MCP en Claude Desktop, puedes importarlos:

<Steps>
  <Step title="Importar servidores desde Claude Desktop">
    ```bash  theme={null}
    # Sintaxis básica 
    claude mcp add-from-claude-desktop 
    ```
  </Step>

  <Step title="Selecciona qué servidores importar">
    Después de ejecutar el comando, verás un diálogo interactivo que te permite seleccionar qué servidores deseas importar.
  </Step>

  <Step title="Verificar que los servidores fueron importados">
    ```bash  theme={null}
    claude mcp list 
    ```
  </Step>
</Steps>

<Tip>
  Consejos:

  * Esta característica solo funciona en macOS y Windows Subsystem for Linux (WSL)
  * Lee el archivo de configuración de Claude Desktop desde su ubicación estándar en esas plataformas
  * Usa la bandera `--scope user` para añadir servidores a tu configuración de usuario
  * Los servidores importados tendrán los mismos nombres que en Claude Desktop
  * Si ya existen servidores con los mismos nombres, obtendrán un sufijo numérico (por ejemplo, `server_1`)
</Tip>

## Usar Claude Code como servidor MCP

Puedes usar Claude Code mismo como servidor MCP que otras aplicaciones pueden conectar:

```bash  theme={null}
# Iniciar Claude como servidor MCP stdio
claude mcp serve
```

Puedes usar esto en Claude Desktop añadiendo esta configuración a claude\_desktop\_config.json:

```json  theme={null}
{
  "mcpServers": {
    "claude-code": {
      "type": "stdio",
      "command": "claude",
      "args": ["mcp", "serve"],
      "env": {}
    }
  }
}
```

<Warning>
  **Configurar la ruta del ejecutable**: El campo `command` debe hacer referencia al ejecutable de Claude Code. Si el comando `claude` no está en el PATH de tu sistema, necesitarás especificar la ruta completa al ejecutable.

  Para encontrar la ruta completa:

  ```bash  theme={null}
  which claude
  ```

  Luego usa la ruta completa en tu configuración:

  ```json  theme={null}
  {
    "mcpServers": {
      "claude-code": {
        "type": "stdio",
        "command": "/full/path/to/claude",
        "args": ["mcp", "serve"],
        "env": {}
      }
    }
  }
  ```

  Sin la ruta correcta del ejecutable, encontrarás errores como `spawn claude ENOENT`.
</Warning>

<Tip>
  Consejos:

  * El servidor proporciona acceso a herramientas de Claude como View, Edit, LS, etc.
  * En Claude Desktop, intenta pedirle a Claude que lea archivos en un directorio, haga ediciones y más.
  * Ten en cuenta que este servidor MCP solo está exponiendo las herramientas de Claude Code a tu cliente MCP, por lo que tu propio cliente es responsable de implementar la confirmación del usuario para llamadas de herramientas individuales.
</Tip>

## Límites de salida de MCP y advertencias

Cuando las herramientas MCP producen salidas grandes, Claude Code ayuda a gestionar el uso de tokens para evitar abrumar el contexto de tu conversación:

* **Umbral de advertencia de salida**: Claude Code muestra una advertencia cuando la salida de cualquier herramienta MCP excede 10,000 tokens
* **Límite configurable**: Puedes ajustar los tokens de salida MCP máximos permitidos usando la variable de entorno `MAX_MCP_OUTPUT_TOKENS`
* **Límite predeterminado**: El máximo predeterminado es 25,000 tokens

Para aumentar el límite para herramientas que producen salidas grandes:

```bash  theme={null}
# Establecer un límite más alto para salidas de herramientas MCP
export MAX_MCP_OUTPUT_TOKENS=50000
claude
```

Esto es particularmente útil cuando se trabaja con servidores MCP que:

* Consultan grandes conjuntos de datos o bases de datos
* Generan reportes detallados o documentación
* Procesan extensos archivos de registro o información de depuración

<Warning>
  Si frecuentemente encuentras advertencias de salida con servidores MCP específicos, considera aumentar el límite o configurar el servidor para paginar o filtrar sus respuestas.
</Warning>

## Usar recursos MCP

Los servidores MCP pueden exponer recursos que puedes referenciar usando menciones @, similar a cómo referencias archivos.

### Referenciar recursos MCP

<Steps>
  <Step title="Listar recursos disponibles">
    Escribe `@` en tu indicación para ver recursos disponibles de todos los servidores MCP conectados. Los recursos aparecen junto a archivos en el menú de autocompletado.
  </Step>

  <Step title="Referenciar un recurso específico">
    Usa el formato `@server:protocol://resource/path` para referenciar un recurso:

    ```
    > ¿Puedes analizar @github:issue://123 y sugerir una solución?
    ```

    ```
    > Por favor revisa la documentación de API en @docs:file://api/authentication
    ```
  </Step>

  <Step title="Múltiples referencias de recursos">
    Puedes referenciar múltiples recursos en una sola indicación:

    ```
    > Compara @postgres:schema://users con @docs:file://database/user-model
    ```
  </Step>
</Steps>

<Tip>
  Consejos:

  * Los recursos se obtienen automáticamente e incluyen como adjuntos cuando se referencian
  * Las rutas de recursos son buscables difusamente en el autocompletado de menciones @
  * Claude Code automáticamente proporciona herramientas para listar y leer recursos MCP cuando los servidores los soportan
  * Los recursos pueden contener cualquier tipo de contenido que el servidor MCP proporcione (texto, JSON, datos estructurados, etc.)
</Tip>

## Usar indicaciones MCP como comandos de barra

Los servidores MCP pueden exponer indicaciones que se vuelven disponibles como comandos de barra en Claude Code.

### Ejecutar indicaciones MCP

<Steps>
  <Step title="Descubrir indicaciones disponibles">
    Escribe `/` para ver todos los comandos disponibles, incluyendo los de servidores MCP. Las indicaciones MCP aparecen con el formato `/mcp__servername__promptname`.
  </Step>

  <Step title="Ejecutar una indicación sin argumentos">
    ```
    > /mcp__github__list_prs
    ```
  </Step>

  <Step title="Ejecutar una indicación con argumentos">
    Muchas indicaciones aceptan argumentos. Pásalos separados por espacios después del comando:

    ```
    > /mcp__github__pr_review 456
    ```

    ```
    > /mcp__jira__create_issue "Error en flujo de inicio de sesión" high
    ```
  </Step>
</Steps>

<Tip>
  Consejos:

  * Las indicaciones MCP se descubren dinámicamente desde servidores conectados
  * Los argumentos se analizan basándose en los parámetros definidos de la indicación
  * Los resultados de la indicación se inyectan directamente en la conversación
  * Los nombres de servidor e indicación se normalizan (los espacios se convierten en guiones bajos)
</Tip>

## Configuración MCP gestionada

Para organizaciones que necesitan control centralizado sobre servidores MCP, Claude Code soporta dos opciones de configuración:

1. **Control exclusivo con `managed-mcp.json`**: Implementa un conjunto fijo de servidores MCP que los usuarios no pueden modificar o extender
2. **Control basado en políticas con listas blancas/negras**: Permite que los usuarios añadan sus propios servidores, pero restringe cuáles están permitidos

Estas opciones permiten a los administradores de TI:

* **Controlar a qué servidores MCP pueden acceder los empleados**: Implementa un conjunto estandarizado de servidores MCP aprobados en toda la organización
* **Prevenir servidores MCP no autorizados**: Restringe a los usuarios de añadir servidores MCP no aprobados
* **Deshabilitar MCP completamente**: Elimina la funcionalidad MCP completamente si es necesario

### Opción 1: Control exclusivo con managed-mcp.json

Cuando implementas un archivo `managed-mcp.json`, toma **control exclusivo** sobre todos los servidores MCP. Los usuarios no pueden añadir, modificar o usar ningún servidor MCP que no esté definido en este archivo. Este es el enfoque más simple para organizaciones que quieren control completo.

Los administradores del sistema implementan el archivo de configuración en un directorio de todo el sistema:

* macOS: `/Library/Application Support/ClaudeCode/managed-mcp.json`
* Linux y WSL: `/etc/claude-code/managed-mcp.json`
* Windows: `C:\Program Files\ClaudeCode\managed-mcp.json`

<Note>
  Estas son rutas de todo el sistema (no directorios de inicio de usuario como `~/Library/...`) que requieren privilegios de administrador. Están diseñadas para ser implementadas por administradores de TI.
</Note>

El archivo `managed-mcp.json` usa el mismo formato que un archivo `.mcp.json` estándar:

```json  theme={null}
{
  "mcpServers": {
    "github": {
      "type": "http",
      "url": "https://api.githubcopilot.com/mcp/"
    },
    "sentry": {
      "type": "http",
      "url": "https://mcp.sentry.dev/mcp"
    },
    "company-internal": {
      "type": "stdio",
      "command": "/usr/local/bin/company-mcp-server",
      "args": ["--config", "/etc/company/mcp-config.json"],
      "env": {
        "COMPANY_API_URL": "https://internal.company.com"
      }
    }
  }
}
```

### Opción 2: Control basado en políticas con listas blancas y negras

En lugar de tomar control exclusivo, los administradores pueden permitir que los usuarios configuren sus propios servidores MCP mientras aplican restricciones sobre qué servidores están permitidos. Este enfoque usa `allowedMcpServers` y `deniedMcpServers` en el [archivo de configuración gestionada](/es/settings#settings-files).

<Note>
  **Elegir entre opciones**: Usa la Opción 1 (`managed-mcp.json`) cuando quieras implementar un conjunto fijo de servidores sin personalización del usuario. Usa la Opción 2 (listas blancas/negras) cuando quieras permitir que los usuarios añadan sus propios servidores dentro de restricciones de política.
</Note>

#### Opciones de restricción

Cada entrada en la lista blanca o negra puede restringir servidores de tres formas:

1. **Por nombre de servidor** (`serverName`): Coincide con el nombre configurado del servidor
2. **Por comando** (`serverCommand`): Coincide con el comando exacto y argumentos usados para iniciar servidores stdio
3. **Por patrón de URL** (`serverUrl`): Coincide con URLs de servidor remoto con soporte de comodín

**Importante**: Cada entrada debe tener exactamente uno de `serverName`, `serverCommand` o `serverUrl`.

#### Configuración de ejemplo

```json  theme={null}
{
  "allowedMcpServers": [
    // Permitir por nombre de servidor
    { "serverName": "github" },
    { "serverName": "sentry" },

    // Permitir por comando exacto (para servidores stdio)
    { "serverCommand": ["npx", "-y", "@modelcontextprotocol/server-filesystem"] },
    { "serverCommand": ["python", "/usr/local/bin/approved-server.py"] },

    // Permitir por patrón de URL (para servidores remotos)
    { "serverUrl": "https://mcp.company.com/*" },
    { "serverUrl": "https://*.internal.corp/*" }
  ],
  "deniedMcpServers": [
    // Bloquear por nombre de servidor
    { "serverName": "dangerous-server" },

    // Bloquear por comando exacto (para servidores stdio)
    { "serverCommand": ["npx", "-y", "unapproved-package"] },

    // Bloquear por patrón de URL (para servidores remotos)
    { "serverUrl": "https://*.untrusted.com/*" }
  ]
}
```

#### Cómo funcionan las restricciones basadas en comandos

**Coincidencia exacta**:

* Los arrays de comandos deben coincidir **exactamente** - tanto el comando como todos los argumentos en el orden correcto
* Ejemplo: `["npx", "-y", "server"]` NO coincidirá con `["npx", "server"]` o `["npx", "-y", "server", "--flag"]`

**Comportamiento del servidor stdio**:

* Cuando la lista blanca contiene **cualquier** entrada `serverCommand`, los servidores stdio **deben** coincidir con uno de esos comandos
* Los servidores stdio no pueden pasar solo por nombre cuando hay restricciones de comando presentes
* Esto asegura que los administradores puedan aplicar qué comandos están permitidos ejecutarse

**Comportamiento del servidor no-stdio**:

* Los servidores remotos (HTTP, SSE, WebSocket) usan coincidencia basada en URL cuando existen entradas `serverUrl` en la lista blanca
* Si no existen entradas de URL, los servidores remotos recurren a coincidencia basada en nombre
* Las restricciones de comando no se aplican a servidores remotos

#### Cómo funcionan las restricciones basadas en URL

Los patrones de URL soportan comodines usando `*` para coincidir con cualquier secuencia de caracteres. Esto es útil para permitir dominios completos o subdominios.

**Ejemplos de comodín**:

* `https://mcp.company.com/*` - Permitir todas las rutas en un dominio específico
* `https://*.example.com/*` - Permitir cualquier subdominio de example.com
* `http://localhost:*/*` - Permitir cualquier puerto en localhost

**Comportamiento del servidor remoto**:

* Cuando la lista blanca contiene **cualquier** entrada `serverUrl`, los servidores remotos **deben** coincidir con uno de esos patrones de URL
* Los servidores remotos no pueden pasar solo por nombre cuando hay restricciones de URL presentes
* Esto asegura que los administradores puedan aplicar qué puntos finales remotos están permitidos

<Accordion title="Ejemplo: Lista blanca solo de URL">
  ```json  theme={null}
  {
    "allowedMcpServers": [
      { "serverUrl": "https://mcp.company.com/*" },
      { "serverUrl": "https://*.internal.corp/*" }
    ]
  }
  ```

  **Resultado**:

  * Servidor HTTP en `https://mcp.company.com/api`: ✅ Permitido (coincide con patrón de URL)
  * Servidor HTTP en `https://api.internal.corp/mcp`: ✅ Permitido (coincide con subdominio comodín)
  * Servidor HTTP en `https://external.com/mcp`: ❌ Bloqueado (no coincide con ningún patrón de URL)
  * Servidor stdio con cualquier comando: ❌ Bloqueado (sin entradas de nombre o comando para coincidir)
</Accordion>

<Accordion title="Ejemplo: Lista blanca solo de comando">
  ```json  theme={null}
  {
    "allowedMcpServers": [
      { "serverCommand": ["npx", "-y", "approved-package"] }
    ]
  }
  ```

  **Resultado**:

  * Servidor stdio con `["npx", "-y", "approved-package"]`: ✅ Permitido (coincide con comando)
  * Servidor stdio con `["node", "server.js"]`: ❌ Bloqueado (no coincide con comando)
  * Servidor HTTP nombrado "my-api": ❌ Bloqueado (sin entradas de nombre para coincidir)
</Accordion>

<Accordion title="Ejemplo: Lista blanca mixta de nombre y comando">
  ```json  theme={null}
  {
    "allowedMcpServers": [
      { "serverName": "github" },
      { "serverCommand": ["npx", "-y", "approved-package"] }
    ]
  }
  ```

  **Resultado**:

  * Servidor stdio nombrado "local-tool" con `["npx", "-y", "approved-package"]`: ✅ Permitido (coincide con comando)
  * Servidor stdio nombrado "local-tool" con `["node", "server.js"]`: ❌ Bloqueado (existen entradas de comando pero no coincide)
  * Servidor stdio nombrado "github" con `["node", "server.js"]`: ❌ Bloqueado (los servidores stdio deben coincidir con comandos cuando existen entradas de comando)
  * Servidor HTTP nombrado "github": ✅ Permitido (coincide con nombre)
  * Servidor HTTP nombrado "other-api": ❌ Bloqueado (el nombre no coincide)
</Accordion>

<Accordion title="Ejemplo: Lista blanca solo de nombre">
  ```json  theme={null}
  {
    "allowedMcpServers": [
      { "serverName": "github" },
      { "serverName": "internal-tool" }
    ]
  }
  ```

  **Resultado**:

  * Servidor stdio nombrado "github" con cualquier comando: ✅ Permitido (sin restricciones de comando)
  * Servidor stdio nombrado "internal-tool" con cualquier comando: ✅ Permitido (sin restricciones de comando)
  * Servidor HTTP nombrado "github": ✅ Permitido (coincide con nombre)
  * Cualquier servidor nombrado "other": ❌ Bloqueado (el nombre no coincide)
</Accordion>

#### Comportamiento de la lista blanca (`allowedMcpServers`)

* `undefined` (predeterminado): Sin restricciones - los usuarios pueden configurar cualquier servidor MCP
* Array vacío `[]`: Bloqueo completo - los usuarios no pueden configurar ningún servidor MCP
* Lista de entradas: Los usuarios solo pueden configurar servidores que coincidan por nombre, comando o patrón de URL

#### Comportamiento de la lista negra (`deniedMcpServers`)

* `undefined` (predeterminado): Ningún servidor está bloqueado
* Array vacío `[]`: Ningún servidor está bloqueado
* Lista de entradas: Los servidores especificados están explícitamente bloqueados en todos los alcances

#### Notas importantes

* **La Opción 1 y la Opción 2 se pueden combinar**: Si existe `managed-mcp.json`, tiene control exclusivo y los usuarios no pueden añadir servidores. Las listas blancas/negras aún se aplican a los servidores gestionados mismos.
* **La lista negra tiene precedencia absoluta**: Si un servidor coincide con una entrada de lista negra (por nombre, comando o URL), será bloqueado incluso si está en la lista blanca
* **Las restricciones basadas en nombre, comando y URL funcionan juntas**: un servidor pasa si coincide con **cualquiera** de una entrada de nombre, una entrada de comando o un patrón de URL (a menos que esté bloqueado por lista negra)

<Note>
  **Cuando se usa `managed-mcp.json`**: Los usuarios no pueden añadir servidores MCP a través de `claude mcp add` o archivos de configuración. Las configuraciones `allowedMcpServers` y `deniedMcpServers` aún se aplican para filtrar qué servidores gestionados se cargan realmente.
</Note>
