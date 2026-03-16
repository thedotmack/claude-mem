declare module 'tree-kill' {
  export default function treeKill(
    pid: number,
    signal?: string,
    callback?: (error?: Error | null) => void
  ): void;
}
