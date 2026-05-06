declare module 'shell-quote' {
  export type ParsedToken = string | { op: string } | Record<string, unknown>;
  export function parse(command: string): ParsedToken[];
}
