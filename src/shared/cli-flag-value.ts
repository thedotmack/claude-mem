/**
 * The value of the first `--name <value>` or `--name=<value>` in args:
 * undefined when the flag is absent, null when it is present without a value
 * (last argument, followed by another `--flag`, or an empty value).
 */
export function cliFlagValue(args: readonly string[], name: string): string | null | undefined {
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === name) {
      const next = args[index + 1];
      return !next || next.startsWith('--') ? null : next;
    }
    if (arg.startsWith(`${name}=`)) {
      return arg.slice(name.length + 1) || null;
    }
  }
  return undefined;
}
