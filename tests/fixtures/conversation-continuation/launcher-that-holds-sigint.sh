#!/bin/bash
# Stands in for an agent wrapper installed ahead of the real CLI on PATH: it traps INT, runs the CLI it is given as its
# foreground child, and exits with the CLI's code. bash runs a trap only after its foreground child has exited, so a
# SIGINT sent to this script alone never reaches the CLI.
_exit_trap() { _status=$?; trap - EXIT HUP INT TERM; exit "$_status"; }
trap _exit_trap EXIT HUP INT TERM
"$@"
_cli_status=$?
trap - EXIT HUP INT TERM
exit "$_cli_status"
