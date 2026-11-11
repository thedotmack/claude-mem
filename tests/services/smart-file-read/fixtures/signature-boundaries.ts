const café = 1; export function build(
  options: { key: string } = { key: "{" }
): { result: string } { return { result: options.key }; }
export const typed = ({ key }: { key: string }): { result: string } => ({ result: key });
abstract class Api {
  abstract read(options: { key: string }): { result: string };
}
