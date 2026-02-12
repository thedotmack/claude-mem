> ## Documentation Index
> Fetch the complete documentation index at: https://code.claude.com/docs/llms.txt
> Use this file to discover all available pages before exploring further.

# Extender Claude Code

> Comprenda cuándo usar CLAUDE.md, Skills, subagents, hooks, MCP y plugins.

Claude Code combina un modelo que razona sobre su código con [herramientas integradas](/es/how-claude-code-works#tools) para operaciones de archivos, búsqueda, ejecución y acceso web. Las herramientas integradas cubren la mayoría de las tareas de codificación. Esta guía cubre la capa de extensión: características que usted agrega para personalizar lo que Claude sabe, conectarlo a servicios externos y automatizar flujos de trabajo.

<Note>
  Para saber cómo funciona el bucle agentico central, consulte [How Claude Code works](/es/how-claude-code-works).
</Note>

**¿Nuevo en Claude Code?** Comience con [CLAUDE.md](/es/memory) para convenciones de proyecto. Agregue otras extensiones según sea necesario.

## Descripción general

Las extensiones se conectan a diferentes partes del bucle agentico:

* **[CLAUDE.md](/es/memory)** agrega contexto persistente que Claude ve en cada sesión
* **[Skills](/es/skills)** agregan conocimiento reutilizable y flujos de trabajo invocables
* **[MCP](/es/mcp)** conecta Claude a servicios y herramientas externas
* **[Subagents](/es/sub-agents)** ejecutan sus propios bucles en contexto aislado, devolviendo resúmenes
* **[Agent teams](/es/agent-teams)** coordinan múltiples sesiones independientes con tareas compartidas y mensajería punto a punto
* **[Hooks](/es/hooks)** se ejecutan completamente fuera del bucle como scripts deterministas
* **[Plugins](/es/plugins)** y **[marketplaces](/es/plugin-marketplaces)** empaquetan y distribuyen estas características

[Skills](/es/skills) son la extensión más flexible. Una skill es un archivo markdown que contiene conocimiento, flujos de trabajo o instrucciones. Puede invocar skills con un comando de barra como `/deploy`, o Claude puede cargarlas automáticamente cuando sea relevante. Las skills pueden ejecutarse en su conversación actual o en un contexto aislado a través de subagents.

## Haga coincidir características con su objetivo

Las características van desde contexto siempre activo que Claude ve en cada sesión, hasta capacidades bajo demanda que usted o Claude pueden invocar, hasta automatización en segundo plano que se ejecuta en eventos específicos. La tabla a continuación muestra qué está disponible y cuándo tiene sentido cada una.

| Característica                     | Qué hace                                                              | Cuándo usarla                                                                                       | Ejemplo                                                                                                                  |
| ---------------------------------- | --------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| **CLAUDE.md**                      | Contexto persistente cargado en cada conversación                     | Convenciones de proyecto, reglas "siempre haz X"                                                    | "Usa pnpm, no npm. Ejecuta pruebas antes de hacer commit."                                                               |
| **Skill**                          | Instrucciones, conocimiento y flujos de trabajo que Claude puede usar | Contenido reutilizable, documentos de referencia, tareas repetibles                                 | `/review` ejecuta su lista de verificación de revisión de código; skill de documentos API con patrones de puntos finales |
| **Subagent**                       | Contexto de ejecución aislado que devuelve resultados resumidos       | Aislamiento de contexto, tareas paralelas, trabajadores especializados                              | Tarea de investigación que lee muchos archivos pero devuelve solo hallazgos clave                                        |
| **[Agent teams](/es/agent-teams)** | Coordinar múltiples sesiones independientes de Claude Code            | Investigación paralela, desarrollo de nuevas características, depuración con hipótesis competidoras | Generar revisores para verificar seguridad, rendimiento y pruebas simultáneamente                                        |
| **MCP**                            | Conectar a servicios externos                                         | Datos o acciones externas                                                                           | Consultar su base de datos, publicar en Slack, controlar un navegador                                                    |
| **Hook**                           | Script determinista que se ejecuta en eventos                         | Automatización predecible, sin LLM involucrado                                                      | Ejecutar ESLint después de cada edición de archivo                                                                       |

**[Plugins](/es/plugins)** son la capa de empaquetamiento. Un plugin agrupa skills, hooks, subagents y servidores MCP en una única unidad instalable. Las skills de plugin tienen espacios de nombres (como `/my-plugin:review`) para que múltiples plugins puedan coexistir. Use plugins cuando desee reutilizar la misma configuración en múltiples repositorios o distribuir a otros a través de un **[marketplace](/es/plugin-marketplaces)**.

### Compare características similares

Algunas características pueden parecer similares. Aquí se explica cómo distinguirlas.

<Tabs>
  <Tab title="Skill vs Subagent">
    Las skills y los subagents resuelven problemas diferentes:

    * **Skills** son contenido reutilizable que puede cargar en cualquier contexto
    * **Subagents** son trabajadores aislados que se ejecutan por separado de su conversación principal

    | Aspecto             | Skill                                                         | Subagent                                                                       |
    | ------------------- | ------------------------------------------------------------- | ------------------------------------------------------------------------------ |
    | **Qué es**          | Instrucciones, conocimiento o flujos de trabajo reutilizables | Trabajador aislado con su propio contexto                                      |
    | **Beneficio clave** | Compartir contenido entre contextos                           | Aislamiento de contexto. El trabajo ocurre por separado, solo devuelve resumen |
    | **Mejor para**      | Material de referencia, flujos de trabajo invocables          | Tareas que leen muchos archivos, trabajo paralelo, trabajadores especializados |

    **Las skills pueden ser de referencia o acción.** Las skills de referencia proporcionan conocimiento que Claude usa en toda su sesión (como su guía de estilo de API). Las skills de acción le dicen a Claude que haga algo específico (como `/deploy` que ejecuta su flujo de trabajo de implementación).

    **Use un subagent** cuando necesite aislamiento de contexto o cuando su ventana de contexto se está llenando. El subagent podría leer docenas de archivos o ejecutar búsquedas extensas, pero su conversación principal solo recibe un resumen. Dado que el trabajo del subagent no consume su contexto principal, esto también es útil cuando no necesita que el trabajo intermedio permanezca visible. Los subagents personalizados pueden tener sus propias instrucciones y pueden precargar skills.

    **Pueden combinarse.** Un subagent puede precargar skills específicas (campo `skills:`). Una skill puede ejecutarse en contexto aislado usando `context: fork`. Consulte [Skills](/es/skills) para obtener detalles.
  </Tab>

  <Tab title="CLAUDE.md vs Skill">
    Ambos almacenan instrucciones, pero se cargan de manera diferente y sirven propósitos diferentes.

    | Aspecto                                  | CLAUDE.md                     | Skill                                                |
    | ---------------------------------------- | ----------------------------- | ---------------------------------------------------- |
    | **Se carga**                             | Cada sesión, automáticamente  | Bajo demanda                                         |
    | **Puede incluir archivos**               | Sí, con importaciones `@path` | Sí, con importaciones `@path`                        |
    | **Puede desencadenar flujos de trabajo** | No                            | Sí, con `/<name>`                                    |
    | **Mejor para**                           | Reglas "siempre haz X"        | Material de referencia, flujos de trabajo invocables |

    **Póngalo en CLAUDE.md** si Claude siempre debe saberlo: convenciones de codificación, comandos de compilación, estructura del proyecto, reglas "nunca hagas X".

    **Póngalo en una skill** si es material de referencia que Claude necesita a veces (documentos de API, guías de estilo) o un flujo de trabajo que desencadena con `/<name>` (implementar, revisar, lanzar).

    **Regla general:** Mantenga CLAUDE.md bajo \~500 líneas. Si está creciendo, mueva contenido de referencia a skills.
  </Tab>

  <Tab title="Subagent vs Agent team">
    Ambos paralelizan el trabajo, pero son arquitectónicamente diferentes:

    * **Subagents** se ejecutan dentro de su sesión e informan resultados a su contexto principal
    * **Agent teams** son sesiones independientes de Claude Code que se comunican entre sí

    | Aspecto             | Subagent                                                     | Agent team                                                |
    | ------------------- | ------------------------------------------------------------ | --------------------------------------------------------- |
    | **Contexto**        | Ventana de contexto propia; resultados devueltos al llamador | Ventana de contexto propia; completamente independiente   |
    | **Comunicación**    | Informa resultados solo al agente principal                  | Los compañeros se envían mensajes directamente            |
    | **Coordinación**    | El agente principal gestiona todo el trabajo                 | Lista de tareas compartida con auto-coordinación          |
    | **Mejor para**      | Tareas enfocadas donde solo importa el resultado             | Trabajo complejo que requiere discusión y colaboración    |
    | **Costo de tokens** | Menor: resultados resumidos al contexto principal            | Mayor: cada compañero es una instancia separada de Claude |

    **Use un subagent** cuando necesite un trabajador rápido y enfocado: investigar una pregunta, verificar una afirmación, revisar un archivo. El subagent hace el trabajo y devuelve un resumen. Su conversación principal se mantiene limpia.

    **Use un agent team** cuando los compañeros necesiten compartir hallazgos, desafiarse mutuamente y coordinarse de forma independiente. Los agent teams son mejores para investigación con hipótesis competidoras, revisión de código paralela y desarrollo de nuevas características donde cada compañero posee una pieza separada.

    **Punto de transición:** Si está ejecutando subagents paralelos pero alcanzando límites de contexto, o si sus subagents necesitan comunicarse entre sí, los agent teams son el siguiente paso natural.

    <Note>
      Los agent teams son experimentales y están deshabilitados por defecto. Consulte [agent teams](/es/agent-teams) para configuración y limitaciones actuales.
    </Note>
  </Tab>

  <Tab title="MCP vs Skill">
    MCP conecta Claude a servicios externos. Las skills amplían lo que Claude sabe, incluyendo cómo usar esos servicios de manera efectiva.

    | Aspecto         | MCP                                                                    | Skill                                                                                                  |
    | --------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
    | **Qué es**      | Protocolo para conectar a servicios externos                           | Conocimiento, flujos de trabajo y material de referencia                                               |
    | **Proporciona** | Acceso a herramientas y datos                                          | Conocimiento, flujos de trabajo, material de referencia                                                |
    | **Ejemplos**    | Integración de Slack, consultas de base de datos, control de navegador | Lista de verificación de revisión de código, flujo de trabajo de implementación, guía de estilo de API |

    Estos resuelven problemas diferentes y funcionan bien juntos:

    **MCP** le da a Claude la capacidad de interactuar con sistemas externos. Sin MCP, Claude no puede consultar su base de datos o publicar en Slack.

    **Skills** le dan a Claude conocimiento sobre cómo usar esas herramientas de manera efectiva, además de flujos de trabajo que puede desencadenar con `/<name>`. Una skill podría incluir el esquema de su base de datos de equipo y patrones de consulta, o un flujo de trabajo `/post-to-slack` con sus reglas de formato de mensaje del equipo.

    Ejemplo: Un servidor MCP conecta Claude a su base de datos. Una skill enseña a Claude su modelo de datos, patrones de consulta comunes y qué tablas usar para diferentes tareas.
  </Tab>
</Tabs>

### Comprenda cómo se superponen las características

Las características se pueden definir en múltiples niveles: en todo el usuario, por proyecto, a través de plugins o mediante políticas administradas. También puede anidar archivos CLAUDE.md en subdirectorios o colocar skills en paquetes específicos de un monorepo. Cuando la misma característica existe en múltiples niveles, así es como se superponen:

* **Los archivos CLAUDE.md** son aditivos: todos los niveles contribuyen contenido al contexto de Claude simultáneamente. Los archivos de su directorio de trabajo y superior se cargan al iniciar; los subdirectorios se cargan mientras trabaja en ellos. Cuando las instrucciones entran en conflicto, Claude usa el juicio para reconciliarlas, con instrucciones más específicas típicamente teniendo precedencia. Consulte [cómo Claude busca memorias](/es/memory#how-claude-looks-up-memories).
* **Las skills y subagents** se anulan por nombre: cuando el mismo nombre existe en múltiples niveles, una definición gana según la prioridad (administrado > usuario > proyecto para skills; administrado > bandera CLI > proyecto > usuario > plugin para subagents). Las skills de plugin tienen [espacios de nombres](/es/plugins#add-skills-to-your-plugin) para evitar conflictos. Consulte [descubrimiento de skills](/es/skills#where-skills-live) y [alcance de subagent](/es/sub-agents#choose-the-subagent-scope).
* **Los servidores MCP** se anulan por nombre: local > proyecto > usuario. Consulte [alcance de MCP](/es/mcp#scope-hierarchy-and-precedence).
* **Los hooks** se fusionan: todos los hooks registrados se disparan para sus eventos coincidentes independientemente de la fuente. Consulte [hooks](/es/hooks).

### Combine características

Cada extensión resuelve un problema diferente: CLAUDE.md maneja contexto siempre activo, las skills manejan conocimiento y flujos de trabajo bajo demanda, MCP maneja conexiones externas, los subagents manejan aislamiento y los hooks manejan automatización. Las configuraciones reales las combinan según su flujo de trabajo.

Por ejemplo, podría usar CLAUDE.md para convenciones de proyecto, una skill para su flujo de trabajo de implementación, MCP para conectar a su base de datos y un hook para ejecutar linting después de cada edición. Cada característica maneja lo que hace mejor.

| Patrón                 | Cómo funciona                                                                                               | Ejemplo                                                                                                   |
| ---------------------- | ----------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| **Skill + MCP**        | MCP proporciona la conexión; una skill enseña a Claude cómo usarla bien                                     | MCP se conecta a su base de datos, una skill documenta su esquema y patrones de consulta                  |
| **Skill + Subagent**   | Una skill genera subagents para trabajo paralelo                                                            | La skill `/review` inicia subagents de seguridad, rendimiento y estilo que trabajan en contexto aislado   |
| **CLAUDE.md + Skills** | CLAUDE.md contiene reglas siempre activas; las skills contienen material de referencia cargado bajo demanda | CLAUDE.md dice "sigue nuestras convenciones de API," una skill contiene la guía de estilo de API completa |
| **Hook + MCP**         | Un hook desencadena acciones externas a través de MCP                                                       | El hook post-edición envía una notificación de Slack cuando Claude modifica archivos críticos             |

## Comprenda los costos de contexto

Cada característica que agrega consume algo del contexto de Claude. Demasiado puede llenar su ventana de contexto, pero también puede agregar ruido que hace que Claude sea menos efectivo; las skills pueden no activarse correctamente, o Claude puede perder de vista sus convenciones. Comprender estos compromisos lo ayuda a construir una configuración efectiva.

### Costo de contexto por característica

Cada característica tiene una estrategia de carga diferente y costo de contexto:

| Característica     | Cuándo se carga                  | Qué se carga                                              | Costo de contexto                                     |
| ------------------ | -------------------------------- | --------------------------------------------------------- | ----------------------------------------------------- |
| **CLAUDE.md**      | Inicio de sesión                 | Contenido completo                                        | Cada solicitud                                        |
| **Skills**         | Inicio de sesión + cuando se usa | Descripciones al inicio, contenido completo cuando se usa | Bajo (descripciones cada solicitud)\*                 |
| **Servidores MCP** | Inicio de sesión                 | Todas las definiciones de herramientas y esquemas         | Cada solicitud                                        |
| **Subagents**      | Cuando se genera                 | Contexto fresco con skills especificadas                  | Aislado de la sesión principal                        |
| **Hooks**          | Al activarse                     | Nada (se ejecuta externamente)                            | Cero, a menos que el hook devuelva contexto adicional |

\*Por defecto, las descripciones de skills se cargan al inicio de sesión para que Claude pueda decidir cuándo usarlas. Establezca `disable-model-invocation: true` en el frontmatter de una skill para ocultarla de Claude completamente hasta que la invoque manualmente. Esto reduce el costo de contexto a cero para las skills que solo desencadena usted mismo.

### Comprenda cómo se cargan las características

Cada característica se carga en diferentes puntos de su sesión. Las pestañas a continuación explican cuándo se carga cada una y qué entra en contexto.

<img src="https://mintcdn.com/claude-code/ELkJZG54dIaeldDC/images/context-loading.svg?fit=max&auto=format&n=ELkJZG54dIaeldDC&q=85&s=bd2e24b8e6a99b31ecfffb63f5b23bf5" alt="Carga de contexto: CLAUDE.md y MCP se cargan al inicio de sesión y permanecen en cada solicitud. Las skills cargan descripciones al inicio, contenido completo al invocar. Los subagents obtienen contexto aislado. Los hooks se ejecutan externamente." data-og-width="720" width="720" data-og-height="410" height="410" data-path="images/context-loading.svg" data-optimize="true" data-opv="3" srcset="https://mintcdn.com/claude-code/ELkJZG54dIaeldDC/images/context-loading.svg?w=280&fit=max&auto=format&n=ELkJZG54dIaeldDC&q=85&s=aebaadd1f484f285dd9cb4e0ea6d49b9 280w, https://mintcdn.com/claude-code/ELkJZG54dIaeldDC/images/context-loading.svg?w=560&fit=max&auto=format&n=ELkJZG54dIaeldDC&q=85&s=030c9b46126d750de315612560082727 560w, https://mintcdn.com/claude-code/ELkJZG54dIaeldDC/images/context-loading.svg?w=840&fit=max&auto=format&n=ELkJZG54dIaeldDC&q=85&s=6c73f8b0389da4f3190843140c810fe9 840w, https://mintcdn.com/claude-code/ELkJZG54dIaeldDC/images/context-loading.svg?w=1100&fit=max&auto=format&n=ELkJZG54dIaeldDC&q=85&s=9844c55d08d2c386672447f2e8518669 1100w, https://mintcdn.com/claude-code/ELkJZG54dIaeldDC/images/context-loading.svg?w=1650&fit=max&auto=format&n=ELkJZG54dIaeldDC&q=85&s=21a9522d0e4bd10ced146aab850ede76 1650w, https://mintcdn.com/claude-code/ELkJZG54dIaeldDC/images/context-loading.svg?w=2500&fit=max&auto=format&n=ELkJZG54dIaeldDC&q=85&s=d318525915aee1a1a6a4215cfaa61fb9 2500w" />

<Tabs>
  <Tab title="CLAUDE.md">
    **Cuándo:** Inicio de sesión

    **Qué se carga:** Contenido completo de todos los archivos CLAUDE.md (niveles administrado, usuario y proyecto).

    **Herencia:** Claude lee archivos CLAUDE.md de su directorio de trabajo hasta la raíz, y descubre los anidados en subdirectorios mientras accede a esos archivos. Consulte [Cómo Claude busca memorias](/es/memory#how-claude-looks-up-memories) para obtener detalles.

    <Tip>Mantenga CLAUDE.md bajo \~500 líneas. Mueva material de referencia a skills, que se cargan bajo demanda.</Tip>
  </Tab>

  <Tab title="Skills">
    Las skills son capacidades adicionales en el kit de herramientas de Claude. Pueden ser material de referencia (como una guía de estilo de API) o flujos de trabajo invocables que desencadena con `/<name>` (como `/deploy`). Algunos son integrados; también puede crear los suyos propios. Claude usa skills cuando es apropiado, o puede invocar una directamente.

    **Cuándo:** Depende de la configuración de la skill. Por defecto, las descripciones se cargan al inicio de sesión y el contenido completo se carga cuando se usa. Para skills solo de usuario (`disable-model-invocation: true`), nada se carga hasta que las invoque.

    **Qué se carga:** Para skills invocables por modelo, Claude ve nombres y descripciones en cada solicitud. Cuando invoca una skill con `/<name>` o Claude la carga automáticamente, el contenido completo se carga en su conversación.

    **Cómo Claude elige skills:** Claude compara su tarea contra descripciones de skills para decidir cuáles son relevantes. Si las descripciones son vagas u se superponen, Claude puede cargar la skill incorrecta o perder una que ayudaría. Para decirle a Claude que use una skill específica, invóquela con `/<name>`. Las skills con `disable-model-invocation: true` son invisibles para Claude hasta que las invoque.

    **Costo de contexto:** Bajo hasta que se use. Las skills solo de usuario tienen costo cero hasta que se invoquen.

    **En subagents:** Las skills funcionan de manera diferente en subagents. En lugar de carga bajo demanda, las skills pasadas a un subagent se precarga completamente en su contexto al iniciar. Los subagents no heredan skills de la sesión principal; debe especificarlas explícitamente.

    <Tip>Use `disable-model-invocation: true` para skills con efectos secundarios. Esto ahorra contexto y asegura que solo usted las desencadene.</Tip>
  </Tab>

  <Tab title="Servidores MCP">
    **Cuándo:** Inicio de sesión.

    **Qué se carga:** Todas las definiciones de herramientas y esquemas JSON de servidores conectados.

    **Costo de contexto:** [Búsqueda de herramientas](/es/mcp#scale-with-mcp-tool-search) (habilitada por defecto) carga herramientas MCP hasta el 10% del contexto y difiere el resto hasta que sea necesario.

    **Nota de confiabilidad:** Las conexiones MCP pueden fallar silenciosamente a mitad de sesión. Si un servidor se desconecta, sus herramientas desaparecen sin advertencia. Claude puede intentar usar una herramienta que ya no existe. Si nota que Claude no puede usar una herramienta MCP a la que anteriormente podía acceder, verifique la conexión con `/mcp`.

    <Tip>Ejecute `/mcp` para ver costos de tokens por servidor. Desconecte servidores que no esté usando activamente.</Tip>
  </Tab>

  <Tab title="Subagents">
    **Cuándo:** Bajo demanda, cuando usted o Claude genera uno para una tarea.

    **Qué se carga:** Contexto fresco y aislado que contiene:

    * El prompt del sistema (compartido con padre para eficiencia de caché)
    * Contenido completo de skills listadas en el campo `skills:` del agente
    * CLAUDE.md y estado de git (heredado del padre)
    * Cualquier contexto que el agente principal pase en el prompt

    **Costo de contexto:** Aislado de la sesión principal. Los subagents no heredan su historial de conversación o skills invocadas.

    <Tip>Use subagents para trabajo que no necesita su contexto de conversación completo. Su aislamiento previene inflar su sesión principal.</Tip>
  </Tab>

  <Tab title="Hooks">
    **Cuándo:** Al activarse. Los hooks se disparan en eventos de ciclo de vida específicos como ejecución de herramientas, límites de sesión, envío de prompt, solicitudes de permiso y compactación. Consulte [Hooks](/es/hooks) para la lista completa.

    **Qué se carga:** Nada por defecto. Los hooks se ejecutan como scripts externos.

    **Costo de contexto:** Cero, a menos que el hook devuelva salida que se agregue como mensajes a su conversación.

    <Tip>Los hooks son ideales para efectos secundarios (linting, logging) que no necesitan afectar el contexto de Claude.</Tip>
  </Tab>
</Tabs>

## Aprenda más

Cada característica tiene su propia guía con instrucciones de configuración, ejemplos y opciones de configuración.

<CardGroup cols={2}>
  <Card title="CLAUDE.md" icon="file-lines" href="/es/memory">
    Almacene contexto de proyecto, convenciones e instrucciones
  </Card>

  <Card title="Skills" icon="brain" href="/es/skills">
    Dé a Claude experiencia de dominio y flujos de trabajo reutilizables
  </Card>

  <Card title="Subagents" icon="users" href="/es/sub-agents">
    Delegue trabajo a contexto aislado
  </Card>

  <Card title="Agent teams" icon="network" href="/es/agent-teams">
    Coordine múltiples sesiones trabajando en paralelo
  </Card>

  <Card title="MCP" icon="plug" href="/es/mcp">
    Conecte Claude a servicios externos
  </Card>

  <Card title="Hooks" icon="bolt" href="/es/hooks-guide">
    Automatice flujos de trabajo con hooks
  </Card>

  <Card title="Plugins" icon="puzzle-piece" href="/es/plugins">
    Empaquete y comparta conjuntos de características
  </Card>

  <Card title="Marketplaces" icon="store" href="/es/plugin-marketplaces">
    Aloje y distribuya colecciones de plugins
  </Card>
</CardGroup>
