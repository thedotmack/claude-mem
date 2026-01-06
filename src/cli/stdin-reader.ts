// Stdin reading utility extracted from hook patterns
// See src/hooks/save-hook.ts for the original pattern

export async function readJsonFromStdin(): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let input = '';
    process.stdin.on('data', (chunk) => input += chunk);
    process.stdin.on('end', () => {
      try {
        resolve(input.trim() ? JSON.parse(input) : undefined);
      } catch (e) {
        reject(new Error(`Failed to parse hook input: ${e}`));
      }
    });
  });
}
