> ## Documentation Index
> Fetch the complete documentation index at: https://code.claude.com/docs/llms.txt
> Use this file to discover all available pages before exploring further.

# Orquestar equipos de sesiones de Claude Code

> Coordina múltiples instancias de Claude Code trabajando juntas como un equipo, con tareas compartidas, mensajería entre agentes y gestión centralizada.

<Warning>
  Los equipos de agentes son experimentales y están deshabilitados por defecto. Habilítelos agregando `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS` a su [settings.json](/es/settings) o entorno. Los equipos de agentes tienen [limitaciones conocidas](#limitations) alrededor de la reanudación de sesiones, coordinación de tareas y comportamiento de apagado.
</Warning>

Los equipos de agentes le permiten coordinar múltiples instancias de Claude Code trabajando juntas. Una sesión actúa como el líder del equipo, coordinando el trabajo, asignando tareas y sintetizando resultados. Los compañeros de equipo trabajan de forma independiente, cada uno en su propia ventana de contexto, y se comunican directamente entre sí.

A diferencia de los [subagents](/es/sub-agents), que se ejecutan dentro de una única sesión y solo pueden reportar al agente principal, también puede interactuar directamente con compañeros de equipo individuales sin pasar por el líder.

Esta página cubre:

* [Cuándo usar equipos de agentes](#when-to-use-agent-teams), incluyendo los mejores casos de uso y cómo se comparan con los subagents
* [Iniciar un equipo](#start-your-first-agent-team)
* [Controlar compañeros de equipo](#control-your-agent-team), incluyendo modos de visualización, asignación de tareas y delegación
* [Mejores prácticas para trabajo paralelo](#best-practices)

## Cuándo usar equipos de agentes

Los equipos de agentes son más efectivos para tareas donde la exploración paralela agrega valor real. Vea [ejemplos de casos de uso](#use-case-examples) para escenarios completos. Los casos de uso más sólidos son:

* **Investigación y revisión**: múltiples compañeros de equipo pueden investigar diferentes aspectos de un problema simultáneamente, luego compartir y desafiar los hallazgos de cada uno
* **Nuevos módulos o características**: los compañeros de equipo pueden poseer cada una una pieza separada sin pisarse mutuamente
* **Depuración con hipótesis competidoras**: los compañeros de equipo prueban diferentes teorías en paralelo y convergen en la respuesta más rápidamente
* **Coordinación entre capas**: cambios que abarcan frontend, backend y pruebas, cada uno propiedad de un compañero de equipo diferente

Los equipos de agentes agregan sobrecarga de coordinación y usan significativamente más tokens que una única sesión. Funcionan mejor cuando los compañeros de equipo pueden operar de forma independiente. Para tareas secuenciales, ediciones del mismo archivo o trabajo con muchas dependencias, una única sesión o [subagents](/es/sub-agents) son más efectivos.

### Comparar con subagents

Tanto los equipos de agentes como los [subagents](/es/sub-agents) le permiten paralelizar el trabajo, pero operan de manera diferente. Elija según si sus trabajadores necesitan comunicarse entre sí:

|                     | Subagents                                                       | Agent teams                                                         |
| :------------------ | :-------------------------------------------------------------- | :------------------------------------------------------------------ |
| **Contexto**        | Ventana de contexto propia; los resultados regresan al llamador | Ventana de contexto propia; completamente independiente             |
| **Comunicación**    | Reportar resultados solo al agente principal                    | Los compañeros de equipo se envían mensajes directamente            |
| **Coordinación**    | El agente principal gestiona todo el trabajo                    | Lista de tareas compartida con auto-coordinación                    |
| **Mejor para**      | Tareas enfocadas donde solo importa el resultado                | Trabajo complejo que requiere discusión y colaboración              |
| **Costo de tokens** | Menor: resultados resumidos de vuelta al contexto principal     | Mayor: cada compañero de equipo es una instancia separada de Claude |

Use subagents cuando necesite trabajadores rápidos y enfocados que reporten. Use equipos de agentes cuando los compañeros de equipo necesiten compartir hallazgos, desafiarse mutuamente y coordinarse por su cuenta.

## Habilitar equipos de agentes

Los equipos de agentes están deshabilitados por defecto. Habilítelos configurando la variable de entorno `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS` a `1`, ya sea en su entorno de shell o a través de [settings.json](/es/settings):

```json settings.json theme={null}
{
  "env": {
    "CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS": "1"
  }
}
```

## Inicie su primer equipo de agentes

Después de habilitar los equipos de agentes, dígale a Claude que cree un equipo de agentes y describa la tarea y la estructura del equipo que desea en lenguaje natural. Claude crea el equipo, genera compañeros de equipo y coordina el trabajo según su indicación.

Este ejemplo funciona bien porque los tres roles son independientes y pueden explorar el problema sin esperar el uno al otro:

```
Estoy diseñando una herramienta CLI que ayuda a los desarrolladores a rastrear
comentarios TODO en su base de código. Crea un equipo de agentes para explorar
esto desde diferentes ángulos: un compañero de equipo en UX, uno en arquitectura
técnica, uno jugando al abogado del diablo.
```

A partir de ahí, Claude crea un equipo con una [lista de tareas compartida](/es/interactive-mode#task-list), genera compañeros de equipo para cada perspectiva, los hace explorar el problema, sintetiza hallazgos e intenta [limpiar el equipo](#clean-up-the-team) cuando termina.

La terminal del líder enumera todos los compañeros de equipo y en qué están trabajando. Use Shift+Arriba/Abajo para seleccionar un compañero de equipo y enviarle un mensaje directamente.

Si desea que cada compañero de equipo esté en su propio panel dividido, vea [Elegir un modo de visualización](#choose-a-display-mode).

## Controlar su equipo de agentes

Dígale al líder lo que desea en lenguaje natural. Maneja la coordinación del equipo, la asignación de tareas y la delegación según sus instrucciones.

### Elegir un modo de visualización

Los equipos de agentes admiten dos modos de visualización:

* **In-process**: todos los compañeros de equipo se ejecutan dentro de su terminal principal. Use Shift+Arriba/Abajo para seleccionar un compañero de equipo y escriba para enviarle un mensaje directamente. Funciona en cualquier terminal, no se requiere configuración adicional.
* **Split panes**: cada compañero de equipo obtiene su propio panel. Puede ver la salida de todos a la vez y hacer clic en un panel para interactuar directamente. Requiere tmux o iTerm2.

<Note>
  `tmux` tiene limitaciones conocidas en ciertos sistemas operativos y tradicionalmente funciona mejor en macOS. Usar `tmux -CC` en iTerm2 es el punto de entrada sugerido en `tmux`.
</Note>

El valor predeterminado es `"auto"`, que usa paneles divididos si ya está ejecutándose dentro de una sesión de tmux, e in-process en caso contrario. La configuración `"tmux"` habilita el modo de panel dividido y detecta automáticamente si usar tmux o iTerm2 según su terminal. Para anular, configure `teammateMode` en su [settings.json](/es/settings):

```json  theme={null}
{
  "teammateMode": "in-process"
}
```

Para forzar el modo in-process para una única sesión, páselo como una bandera:

```bash  theme={null}
claude --teammate-mode in-process
```

El modo de panel dividido requiere [tmux](https://github.com/tmux/tmux/wiki) o iTerm2 con la [CLI `it2`](https://github.com/mkusaka/it2). Para instalar manualmente:

* **tmux**: instale a través del gestor de paquetes de su sistema. Vea la [wiki de tmux](https://github.com/tmux/tmux/wiki/Installing) para instrucciones específicas de la plataforma.
* **iTerm2**: instale la [CLI `it2`](https://github.com/mkusaka/it2), luego habilite la API de Python en **iTerm2 → Configuración → General → Magic → Habilitar API de Python**.

### Especificar compañeros de equipo y modelos

Claude decide el número de compañeros de equipo a generar según su tarea, o puede especificar exactamente lo que desea:

```
Crea un equipo con 4 compañeros de equipo para refactorizar estos módulos en paralelo.
Usa Sonnet para cada compañero de equipo.
```

### Requerir aprobación de plan para compañeros de equipo

Para tareas complejas o riesgosas, puede requerir que los compañeros de equipo planifiquen antes de implementar. El compañero de equipo trabaja en modo de plan de solo lectura hasta que el líder apruebe su enfoque:

```
Genera un compañero de equipo arquitecto para refactorizar el módulo de autenticación.
Requiere aprobación de plan antes de que realicen cambios.
```

Cuando un compañero de equipo termina de planificar, envía una solicitud de aprobación de plan al líder. El líder revisa el plan y lo aprueba o lo rechaza con comentarios. Si se rechaza, el compañero de equipo permanece en modo de plan, revisa según los comentarios y reenvía. Una vez aprobado, el compañero de equipo sale del modo de plan y comienza la implementación.

El líder toma decisiones de aprobación de forma autónoma. Para influir en el juicio del líder, proporcione criterios en su indicación, como "solo aprueba planes que incluyan cobertura de pruebas" o "rechaza planes que modifiquen el esquema de la base de datos".

### Usar modo delegado

Sin modo delegado, el líder a veces comienza a implementar tareas por sí mismo en lugar de esperar a los compañeros de equipo. El modo delegado previene esto al restringir el líder a herramientas de solo coordinación: generar, enviar mensajes, apagar compañeros de equipo y gestionar tareas.

Esto es útil cuando desea que el líder se enfoque completamente en la orquestación, como desglosar el trabajo, asignar tareas y sintetizar resultados, sin tocar el código directamente.

Para habilitarlo, inicie un equipo primero, luego presione Shift+Tab para cambiar al modo delegado.

### Hablar con compañeros de equipo directamente

Cada compañero de equipo es una sesión completa e independiente de Claude Code. Puede enviar un mensaje a cualquier compañero de equipo directamente para dar instrucciones adicionales, hacer preguntas de seguimiento o redirigir su enfoque.

* **Modo in-process**: use Shift+Arriba/Abajo para seleccionar un compañero de equipo, luego escriba para enviarle un mensaje. Presione Enter para ver la sesión de un compañero de equipo, luego Escape para interrumpir su turno actual. Presione Ctrl+T para alternar la lista de tareas.
* **Modo split-pane**: haga clic en el panel de un compañero de equipo para interactuar directamente con su sesión. Cada compañero de equipo tiene una vista completa de su propio terminal.

### Asignar y reclamar tareas

La lista de tareas compartida coordina el trabajo en todo el equipo. El líder crea tareas y los compañeros de equipo las trabajan. Las tareas tienen tres estados: pendiente, en progreso y completada. Las tareas también pueden depender de otras tareas: una tarea pendiente con dependencias sin resolver no puede ser reclamada hasta que esas dependencias se completen.

El líder puede asignar tareas explícitamente, o los compañeros de equipo pueden auto-reclamar:

* **El líder asigna**: dígale al líder qué tarea dar a qué compañero de equipo
* **Auto-reclamar**: después de terminar una tarea, un compañero de equipo recoge la siguiente tarea sin asignar y sin bloquear por su cuenta

La reclamación de tareas usa bloqueo de archivos para prevenir condiciones de carrera cuando múltiples compañeros de equipo intentan reclamar la misma tarea simultáneamente.

### Apagar compañeros de equipo

Para terminar gracefully la sesión de un compañero de equipo:

```
Pídele al compañero de equipo investigador que se apague
```

El líder envía una solicitud de apagado. El compañero de equipo puede aprobar, saliendo gracefully, o rechazar con una explicación.

### Limpiar el equipo

Cuando haya terminado, pídele al líder que limpie:

```
Limpia el equipo
```

Esto elimina los recursos compartidos del equipo. Cuando el líder ejecuta la limpieza, verifica si hay compañeros de equipo activos y falla si alguno aún se está ejecutando, así que apáguelos primero.

<Warning>
  Siempre use el líder para limpiar. Los compañeros de equipo no deben ejecutar la limpieza porque su contexto de equipo puede no resolverse correctamente, dejando potencialmente recursos en un estado inconsistente.
</Warning>

## Cómo funcionan los equipos de agentes

Esta sección cubre la arquitectura y la mecánica detrás de los equipos de agentes. Si desea comenzar a usarlos, vea [Controlar su equipo de agentes](#control-your-agent-team) arriba.

### Cómo Claude inicia equipos de agentes

Hay dos formas en que los equipos de agentes se inician:

* **Usted solicita un equipo**: dé a Claude una tarea que se beneficie del trabajo paralelo y solicite explícitamente un equipo de agentes. Claude crea uno según sus instrucciones.
* **Claude propone un equipo**: si Claude determina que su tarea se beneficiaría del trabajo paralelo, puede sugerir crear un equipo. Usted confirma antes de que proceda.

En ambos casos, usted mantiene el control. Claude no creará un equipo sin su aprobación.

### Arquitectura

Un equipo de agentes consta de:

| Componente    | Rol                                                                                                      |
| :------------ | :------------------------------------------------------------------------------------------------------- |
| **Team lead** | La sesión principal de Claude Code que crea el equipo, genera compañeros de equipo y coordina el trabajo |
| **Teammates** | Instancias separadas de Claude Code que cada una trabaja en tareas asignadas                             |
| **Task list** | Lista compartida de elementos de trabajo que los compañeros de equipo reclaman y completan               |
| **Mailbox**   | Sistema de mensajería para comunicación entre agentes                                                    |

Vea [Elegir un modo de visualización](#choose-a-display-mode) para opciones de configuración de visualización. Los mensajes de los compañeros de equipo llegan al líder automáticamente.

El sistema gestiona las dependencias de tareas automáticamente. Cuando un compañero de equipo completa una tarea de la que otras tareas dependen, las tareas bloqueadas se desbloquean sin intervención manual.

Los equipos y tareas se almacenan localmente:

* **Team config**: `~/.claude/teams/{team-name}/config.json`
* **Task list**: `~/.claude/tasks/{team-name}/`

La configuración del equipo contiene una matriz `members` con el nombre de cada compañero de equipo, ID de agente y tipo de agente. Los compañeros de equipo pueden leer este archivo para descubrir otros miembros del equipo.

### Permisos

Los compañeros de equipo comienzan con la configuración de permisos del líder. Si el líder se ejecuta con `--dangerously-skip-permissions`, todos los compañeros de equipo también lo hacen. Después de generar, puede cambiar modos de compañeros de equipo individuales, pero no puede establecer modos por compañero de equipo en el momento de la generación.

### Contexto y comunicación

Cada compañero de equipo tiene su propia ventana de contexto. Cuando se genera, un compañero de equipo carga el mismo contexto de proyecto que una sesión regular: CLAUDE.md, servidores MCP y skills. También recibe la indicación de generación del líder. El historial de conversación del líder no se transfiere.

**Cómo los compañeros de equipo comparten información:**

* **Entrega automática de mensajes**: cuando los compañeros de equipo envían mensajes, se entregan automáticamente a los destinatarios. El líder no necesita sondear actualizaciones.
* **Notificaciones de inactividad**: cuando un compañero de equipo termina y se detiene, notifica automáticamente al líder.
* **Lista de tareas compartida**: todos los agentes pueden ver el estado de la tarea y reclamar trabajo disponible.

**Mensajería de compañeros de equipo:**

* **message**: enviar un mensaje a un compañero de equipo específico
* **broadcast**: enviar a todos los compañeros de equipo simultáneamente. Use con moderación, ya que los costos escalan con el tamaño del equipo.

### Uso de tokens

Los equipos de agentes usan significativamente más tokens que una única sesión. Cada compañero de equipo tiene su propia ventana de contexto, y el uso de tokens escala con el número de compañeros de equipo activos. Para investigación, revisión y trabajo de nuevas características, los tokens adicionales generalmente valen la pena. Para tareas rutinarias, una única sesión es más rentable. Vea [costos de tokens de equipos de agentes](/es/costs#agent-team-token-costs) para orientación de uso.

## Ejemplos de casos de uso

Estos ejemplos muestran cómo los equipos de agentes manejan tareas donde la exploración paralela agrega valor.

### Ejecutar una revisión de código paralela

Un revisor único tiende a gravitar hacia un tipo de problema a la vez. Dividir criterios de revisión en dominios independientes significa que la seguridad, el rendimiento y la cobertura de pruebas reciben atención exhaustiva simultáneamente. La indicación asigna a cada compañero de equipo una lente distinta para que no se superpongan:

```
Crea un equipo de agentes para revisar la PR #142. Genera tres revisores:
- Uno enfocado en implicaciones de seguridad
- Uno verificando impacto de rendimiento
- Uno validando cobertura de pruebas
Que cada uno revise e informe hallazgos.
```

Cada revisor trabaja desde la misma PR pero aplica un filtro diferente. El líder sintetiza hallazgos en los tres después de que terminen.

### Investigar con hipótesis competidoras

Cuando la causa raíz es poco clara, un único agente tiende a encontrar una explicación plausible y dejar de buscar. La indicación lucha contra esto haciendo que los compañeros de equipo sean explícitamente adversarios: el trabajo de cada uno no es solo investigar su propia teoría sino desafiar las de los otros.

```
Los usuarios reportan que la aplicación se cierra después de un mensaje en lugar de
mantenerse conectada. Genera 5 compañeros de equipo de agentes para investigar
diferentes hipótesis. Haz que hablen entre sí para intentar refutar las teorías
de cada uno, como un debate científico. Actualiza el documento de hallazgos con
cualquier consenso que emerja.
```

La estructura de debate es el mecanismo clave aquí. La investigación secuencial sufre de anclaje: una vez que se explora una teoría, la investigación posterior está sesgada hacia ella.

Con múltiples investigadores independientes intentando activamente refutar mutuamente, la teoría que sobrevive es mucho más probable que sea la causa raíz real.

## Mejores prácticas

### Dar a los compañeros de equipo suficiente contexto

Los compañeros de equipo cargan contexto de proyecto automáticamente, incluyendo CLAUDE.md, servidores MCP y skills, pero no heredan el historial de conversación del líder. Vea [Contexto y comunicación](#context-and-communication) para detalles. Incluya detalles específicos de la tarea en la indicación de generación:

```
Genera un compañero de equipo revisor de seguridad con la indicación: "Revisa el
módulo de autenticación en src/auth/ para vulnerabilidades de seguridad. Enfócate
en manejo de tokens, gestión de sesiones y validación de entrada. La aplicación
usa tokens JWT almacenados en cookies httpOnly. Reporta cualquier problema con
calificaciones de severidad."
```

### Dimensionar tareas apropiadamente

* **Demasiado pequeño**: la sobrecarga de coordinación excede el beneficio
* **Demasiado grande**: los compañeros de equipo trabajan demasiado tiempo sin check-ins, aumentando el riesgo de esfuerzo desperdiciado
* **Justo bien**: unidades auto-contenidas que producen un entregable claro, como una función, un archivo de prueba o una revisión

<Tip>
  El líder divide el trabajo en tareas y las asigna a los compañeros de equipo automáticamente. Si no está creando suficientes tareas, pídele que divida el trabajo en piezas más pequeñas. Tener 5-6 tareas por compañero de equipo mantiene a todos productivos y permite que el líder reasigne trabajo si alguien se atasca.
</Tip>

### Esperar a que los compañeros de equipo terminen

A veces el líder comienza a implementar tareas por sí mismo en lugar de esperar a los compañeros de equipo. Si nota esto:

```
Espera a que tus compañeros de equipo completen sus tareas antes de proceder
```

### Comenzar con investigación y revisión

Si es nuevo en equipos de agentes, comience con tareas que tengan límites claros y no requieran escribir código: revisar una PR, investigar una biblioteca o investigar un error. Estas tareas muestran el valor de la exploración paralela sin los desafíos de coordinación que vienen con la implementación paralela.

### Evitar conflictos de archivos

Dos compañeros de equipo editando el mismo archivo conduce a sobrescrituras. Divida el trabajo para que cada compañero de equipo posea un conjunto diferente de archivos.

### Monitorear y dirigir

Verifique el progreso de los compañeros de equipo, redirija enfoques que no estén funcionando y sintetice hallazgos a medida que lleguen. Dejar que un equipo se ejecute desatendido durante demasiado tiempo aumenta el riesgo de esfuerzo desperdiciado.

## Solución de problemas

### Los compañeros de equipo no aparecen

Si los compañeros de equipo no aparecen después de pedirle a Claude que cree un equipo:

* En modo in-process, los compañeros de equipo pueden ya estar ejecutándose pero no ser visibles. Presione Shift+Abajo para ciclar a través de compañeros de equipo activos.
* Verifique que la tarea que le dio a Claude fue lo suficientemente compleja para justificar un equipo. Claude decide si generar compañeros de equipo según la tarea.
* Si solicitó explícitamente paneles divididos, asegúrese de que tmux esté instalado y disponible en su PATH:
  ```bash  theme={null}
  which tmux
  ```
* Para iTerm2, verifique que la CLI `it2` esté instalada y la API de Python esté habilitada en las preferencias de iTerm2.

### Demasiadas solicitudes de permiso

Las solicitudes de permiso de compañeros de equipo suben al líder, lo que puede crear fricción. Pre-apruebe operaciones comunes en su [configuración de permisos](/es/permissions) antes de generar compañeros de equipo para reducir interrupciones.

### Los compañeros de equipo se detienen en errores

Los compañeros de equipo pueden detenerse después de encontrar errores en lugar de recuperarse. Verifique su salida usando Shift+Arriba/Abajo en modo in-process o haciendo clic en el panel en modo split, luego:

* Deles instrucciones adicionales directamente
* Genere un compañero de equipo de reemplazo para continuar el trabajo

### El líder se apaga antes de que el trabajo esté hecho

El líder puede decidir que el equipo está terminado antes de que todas las tareas estén realmente completas. Si esto sucede, dígale que continúe. También puede decirle al líder que espere a que los compañeros de equipo terminen antes de proceder si comienza a hacer trabajo en lugar de delegar.

### Sesiones de tmux huérfanas

Si una sesión de tmux persiste después de que el equipo termina, puede no haber sido completamente limpiada. Enumere sesiones y mate la creada por el equipo:

```bash  theme={null}
tmux ls
tmux kill-session -t <session-name>
```

## Limitaciones

Los equipos de agentes son experimentales. Las limitaciones actuales a tener en cuenta:

* **Sin reanudación de sesión con compañeros de equipo in-process**: `/resume` y `/rewind` no restauran compañeros de equipo in-process. Después de reanudar una sesión, el líder puede intentar enviar mensajes a compañeros de equipo que ya no existen. Si esto sucede, dígale al líder que genere nuevos compañeros de equipo.
* **El estado de la tarea puede retrasarse**: los compañeros de equipo a veces no marcan las tareas como completadas, lo que bloquea tareas dependientes. Si una tarea parece atascada, verifique si el trabajo está realmente hecho y actualice el estado de la tarea manualmente o dígale al líder que empuje al compañero de equipo.
* **El apagado puede ser lento**: los compañeros de equipo terminan su solicitud actual o llamada de herramienta antes de apagarse, lo que puede tomar tiempo.
* **Un equipo por sesión**: un líder solo puede gestionar un equipo a la vez. Limpie el equipo actual antes de iniciar uno nuevo.
* **Sin equipos anidados**: los compañeros de equipo no pueden generar sus propios equipos o compañeros de equipo. Solo el líder puede gestionar el equipo.
* **El líder es fijo**: la sesión que crea el equipo es el líder de por vida. No puede promover un compañero de equipo a líder o transferir liderazgo.
* **Permisos establecidos en la generación**: todos los compañeros de equipo comienzan con el modo de permiso del líder. Puede cambiar modos de compañeros de equipo individuales después de generar, pero no puede establecer modos por compañero de equipo en el momento de la generación.
* **Los paneles divididos requieren tmux o iTerm2**: el modo in-process predeterminado funciona en cualquier terminal. El modo de panel dividido no es compatible con la terminal integrada de VS Code, Windows Terminal o Ghostty.

<Tip>
  **`CLAUDE.md` funciona normalmente**: los compañeros de equipo leen archivos `CLAUDE.md` de su directorio de trabajo. Use esto para proporcionar orientación específica del proyecto a todos los compañeros de equipo.
</Tip>

## Próximos pasos

Explore enfoques relacionados para trabajo paralelo y delegación:

* **Delegación ligera**: [subagents](/es/sub-agents) generan agentes auxiliares para investigación o verificación dentro de su sesión, mejor para tareas que no necesitan coordinación entre agentes
* **Sesiones paralelas manuales**: [Git worktrees](/es/common-workflows#run-parallel-claude-code-sessions-with-git-worktrees) le permiten ejecutar múltiples sesiones de Claude Code usted mismo sin coordinación de equipo automatizada
* **Comparar enfoques**: vea la comparación [subagent vs agent team](/es/features-overview#compare-similar-features) para un desglose lado a lado
