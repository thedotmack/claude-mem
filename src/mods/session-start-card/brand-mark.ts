/** The Claude-Mem logo sampled into a 2 × 4 dot matrix per terminal cell. */
const COMPACT_MARK = [
  '  ⣀⠤⣼⠛⡇⢸⠟⣓⣤⣀  ',
  ' ⣀⡛⠲⣌⢣⡇⢨⡾⢉⡤⠿⢀ ',
  '⣸⢁⣉⠲⣌⣦⣷⣿⣴⣫⠶⠒⠚⠃',
  '⡴⠋⣉⣙⣒⣿⣿⣿⣿⣒⡚⠛⢦⣹',
  '⢰⠟⢉⣤⠴⢫⢿⠿⡑⢮⣉⠳⣌⡋',
  '⠈⢠⡏⢠⡶⢋⢸ ⡙⣆⠹⣦⡼⠁',
  '  ⠙⠛⢠⠞⠘⡆⠧⣽⠶   ',
] as const;

const LARGE_MARK = [
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
] as const;

/** Leave four rows for the border and prompt when the host reports a height. */
export function sessionStartMark(columns: number, rows = Infinity): readonly string[] | undefined {
  if (columns >= 100 && rows >= LARGE_MARK.length + 4) return LARGE_MARK;
  if (columns >= 64 && rows >= COMPACT_MARK.length + 4) return COMPACT_MARK;
  return undefined;
}
