/**
 * The file name of the tree-sitter CLI executable inside the tree-sitter-cli
 * package: `tree-sitter.exe` on Windows, a bare `tree-sitter` elsewhere (#3644).
 * Shared by the parser's resolver and the installer's provisioning probe, and
 * kept in its own module so the npx installer can use it without bundling the
 * parser.
 */
export function treeSitterBinaryName(platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32' ? 'tree-sitter.exe' : 'tree-sitter';
}
