# Cómo ver la consola de Bun

Para ver la consola de Bun ejecutando el worker en tiempo real:

## Windows

1. **Configurar variable de entorno del sistema**:
   ```powershell
   # Abrir PowerShell como Administrador y ejecutar:
   [System.Environment]::SetEnvironmentVariable('CLAUDE_MEM_SHOW_CONSOLE', '1', 'User')
   ```

2. **O configurar temporalmente en la sesión actual**:
   ```powershell
   $env:CLAUDE_MEM_SHOW_CONSOLE = '1'
   ```

3. **Reiniciar el worker**:
   ```powershell
   bun run worker:restart
   ```

4. **Reiniciar Claude Code** para que tome las nuevas variables de entorno

Ahora cuando el worker se inicie, verás una consola de Bun mostrando los logs en tiempo real.

## Deshabilitar la consola visible

Para volver a ocultar la consola:

```powershell
# Eliminar variable de entorno:
[System.Environment]::SetEnvironmentVariable('CLAUDE_MEM_SHOW_CONSOLE', $null, 'User')

# O establecer a 0:
[System.Environment]::SetEnvironmentVariable('CLAUDE_MEM_SHOW_CONSOLE', '0', 'User')
```

Luego reinicia Claude Code.

## Notas

- La consola solo es visible en Windows
- Si cierras la consola manualmente, el worker se detendrá
- Los logs también se guardan en `~\.claude-mem\logs\` independientemente de la consola
