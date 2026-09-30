:; export PATH="$HOME/.nvm/versions/node/v$(ls "$HOME/.nvm/versions/node" 2>/dev/null | sed 's/^v//' | sort -t. -k1,1n -k2,2n -k3,3n | tail -1)/bin:$HOME/.local/bin:/usr/local/bin:/opt/homebrew/bin:$PATH"; _C="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"; _E="${CLAUDE_PLUGIN_ROOT:-${PLUGIN_ROOT:-}}"; _F=; _P=$({ [ -n "$_E" ] && printf '%s\n' "$_E"; for _V in "$_C/plugins/cache/thedotmack/claude-mem"/[0-9]*/; do [ -d "$_V" ] || continue; [ -e "${_V}.orphaned_at" ] && continue; _B=${_V%/}; _B=${_B##*/}; case "$_B" in (*-*) _G=0;; (*) _G=1;; esac; _N=${_B%%-*}; _M1=${_N%%.*}; case "$_N" in (*.*) _T=${_N#*.};; (*) _T=0;; esac; _M2=${_T%%.*}; case "$_T" in (*.*) _U=${_T#*.};; (*) _U=0;; esac; _M3=${_U%%.*}; _M1=${_M1%%[!0-9]*}; _M2=${_M2%%[!0-9]*}; _M3=${_M3%%[!0-9]*}; printf '%08d%08d%08d%d %s\n' "${_M1:-0}" "${_M2:-0}" "${_M3:-0}" "$_G" "$_V"; done 2>/dev/null | sort -r | sed 's/^[^ ]* //'; printf '%s\n' "$_C/plugins/marketplaces/thedotmack/plugin"; } | while IFS= read -r _R; do _R="${_R%/}"; [ -d "$_R/plugin/scripts" ] && _Q="$_R/plugin" || _Q="$_R"; { if [ "$1" = "version-check" ]; then [ -f "$_Q/scripts/version-check.js" ]; else [ -f "$_Q/scripts/bun-runner.js" ] && [ -f "$_Q/scripts/worker-service.cjs" ]; fi; } && [ -z "$_F" ] && { _F=1; printf '%s\n' "$_Q"; }; done); [ -n "$_P" ] || { echo "claude-mem: plugin scripts not found" >&2; if [ "$1" = "version-check" ]; then exit 1; fi; exit 0; }; command -v cygpath >/dev/null 2>&1 && { _W=$(cygpath -w "$_P" 2>/dev/null); [ -n "$_W" ] && _P="$_W"; }; if [ "$1" = "version-check" ]; then node "$_P/scripts/version-check.js"; exit $?; fi; { node "$_P/scripts/bun-runner.js" "$_P/scripts/worker-service.cjs" "$@"; } || { _S=$?; echo "claude-mem: hook command failed (exit $_S)" >&2; exit 0; }; exit $?
@echo off
setlocal EnableExtensions
where bash >nul 2>&1
if errorlevel 1 goto node
bash "%~f0" %*
exit /b %ERRORLEVEL%
:node
node "%~dp0cmem-build-hook.cjs" %*
set "EC=%ERRORLEVEL%"
if "%~1"=="version-check" exit /b %EC%
if not "%EC%"=="0" exit /b 0
exit /b 0
