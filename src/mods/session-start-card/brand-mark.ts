/** The Claude-Mem logo sampled into a 2 × 4 dot matrix per terminal cell. */
const COMPACT_MARK = rasterMark([
  '  ⣀⠤⣼⠛⡇⢸⠟⣓⣤⣀  ',
  ' ⣀⡛⠲⣌⢣⡇⢨⡾⢉⡤⠿⢀ ',
  '⣸⢁⣉⠲⣌⣦⣷⣿⣴⣫⠶⠒⠚⠃',
  '⡴⠋⣉⣙⣒⣿⣿⣿⣿⣒⡚⠛⢦⣹',
  '⢰⠟⢉⣤⠴⢫⢿⠿⡑⢮⣉⠳⣌⡋',
  '⠈⢠⡏⢠⡶⢋⢸ ⡙⣆⠹⣦⡼⠁',
  '  ⠙⠛⢠⠞⠘⡆⠧⣽⠶   ',
]);

const LARGE_MARK = rasterMark([
  '     ⢀⣀⣰⠾⢿⣷⡄⢠⣾⡿⠿⠦       ',
  '   ⢠⣾⡛⠙⠻⣧ ⢻⡇⢸⡟⢀⣤⣶⡾⠿⣷⣄   ',
  '  ⢀⡉⠛⠻⣦⡀⠘⣧⣼⡇⢸⣁⣾⠏⢁⣠⣴⣿⠟   ',
  ' ⣼⡿⠻⢷⣄⠈⠻⣦⠘⣿⡇⢸⣿⢃⣴⡟⠋⣁⣀⣀⣼⣧ ',
  '⢰⡿⢀⣀⣀⠙⠻⣦⣝⣷⣼⣧⣾⣧⡾⣋⣴⠾⠛⠛⠛⠛⠋ ',
  '⢈⣡⣾⠟⠛⠻⠶⣤⣽⣿⣿⣿⣿⣿⣿⣯⣥⣴⡶⠶⣶⣄⠸⣧',
  '⡿⠋⢁⣠⣤⣤⣤⣤⡶⣿⣿⣿⣿⣿⡿⣯⣤⣄⣀⡀ ⢿⣦⣿',
  ' ⣴⡿⠋⠁⢀⣀⣤⡾⢛⣿⢿⡿⣿⠻⣦⣌⠉⠙⢻⣆⠈⠛⠋',
  '⠈⣿ ⢠⣾⠟⠋⠁⣠⣾⠃⢸⡇⠹⣦⡀⠙⢿⣦ ⠙⢿⣷ ',
  ' ⠈ ⣿⡇ ⣠⡾⠛⢁⡀⢸⡇ ⠙⢿⡄ ⢻⣧⣤⣾⠃ ',
  '   ⠹⣷⣴⣿⠁ ⣾⡇⢸⡇⢸⣇⠈⣿⡀⠈⠛⠋⠁  ',
  '     ⠉⠁⠴⠾⠟ ⠘⢷⠈⠻⠷⠿⠟⠋     ',
]);

/** A terminal Raster draws the dots visually and keeps decorative glyphs out of screen-reader text. */
function rasterMark(grid: string[]) {
  const columns = grid[0].length;
  // Claude Code expects 12 little-endian bytes per cell: code point, foreground, background.
  const bytes = new Uint8Array(grid.length * columns * 12);
  const cells = new DataView(bytes.buffer);
  let offset = 0;
  for (const line of grid) {
    for (const glyph of line) {
      cells.setUint32(offset, glyph.charCodeAt(0), true);
      cells.setUint32(offset + 4, 0xd86441, true);
      cells.setUint32(offset + 8, 0x01000000, true); // Host's default background.
      offset += 12;
    }
  }
  return { columns, rows: grid.length, cells: btoa(String.fromCharCode(...bytes)) };
}

/** Leave four rows for the border and prompt when the host reports a height. */
export function sessionStartMark(columns: number, rows = Infinity) {
  if (columns >= 100 && rows >= LARGE_MARK.rows + 4) return LARGE_MARK;
  if (columns >= 64 && rows >= COMPACT_MARK.rows + 4) return COMPACT_MARK;
  return undefined;
}
