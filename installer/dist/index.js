#!/usr/bin/env node
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __commonJS = (cb, mod) => function __require() {
  return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));

// node_modules/sisteransi/src/index.js
var require_src = __commonJS({
  "node_modules/sisteransi/src/index.js"(exports, module) {
    "use strict";
    var ESC2 = "\x1B";
    var CSI2 = `${ESC2}[`;
    var beep = "\x07";
    var cursor3 = {
      to(x, y) {
        if (!y) return `${CSI2}${x + 1}G`;
        return `${CSI2}${y + 1};${x + 1}H`;
      },
      move(x, y) {
        let ret = "";
        if (x < 0) ret += `${CSI2}${-x}D`;
        else if (x > 0) ret += `${CSI2}${x}C`;
        if (y < 0) ret += `${CSI2}${-y}A`;
        else if (y > 0) ret += `${CSI2}${y}B`;
        return ret;
      },
      up: (count = 1) => `${CSI2}${count}A`,
      down: (count = 1) => `${CSI2}${count}B`,
      forward: (count = 1) => `${CSI2}${count}C`,
      backward: (count = 1) => `${CSI2}${count}D`,
      nextLine: (count = 1) => `${CSI2}E`.repeat(count),
      prevLine: (count = 1) => `${CSI2}F`.repeat(count),
      left: `${CSI2}G`,
      hide: `${CSI2}?25l`,
      show: `${CSI2}?25h`,
      save: `${ESC2}7`,
      restore: `${ESC2}8`
    };
    var scroll = {
      up: (count = 1) => `${CSI2}S`.repeat(count),
      down: (count = 1) => `${CSI2}T`.repeat(count)
    };
    var erase3 = {
      screen: `${CSI2}2J`,
      up: (count = 1) => `${CSI2}1J`.repeat(count),
      down: (count = 1) => `${CSI2}J`.repeat(count),
      line: `${CSI2}2K`,
      lineEnd: `${CSI2}K`,
      lineStart: `${CSI2}1K`,
      lines(count) {
        let clear = "";
        for (let i2 = 0; i2 < count; i2++)
          clear += this.line + (i2 < count - 1 ? cursor3.up() : "");
        if (count)
          clear += cursor3.left;
        return clear;
      }
    };
    module.exports = { cursor: cursor3, scroll, erase: erase3, beep };
  }
});

// node_modules/picocolors/picocolors.js
var require_picocolors = __commonJS({
  "node_modules/picocolors/picocolors.js"(exports, module) {
    var p = process || {};
    var argv = p.argv || [];
    var env = p.env || {};
    var isColorSupported = !(!!env.NO_COLOR || argv.includes("--no-color")) && (!!env.FORCE_COLOR || argv.includes("--color") || p.platform === "win32" || (p.stdout || {}).isTTY && env.TERM !== "dumb" || !!env.CI);
    var formatter = (open, close, replace = open) => (input) => {
      let string = "" + input, index = string.indexOf(close, open.length);
      return ~index ? open + replaceClose(string, close, replace, index) + close : open + string + close;
    };
    var replaceClose = (string, close, replace, index) => {
      let result = "", cursor3 = 0;
      do {
        result += string.substring(cursor3, index) + replace;
        cursor3 = index + close.length;
        index = string.indexOf(close, cursor3);
      } while (~index);
      return result + string.substring(cursor3);
    };
    var createColors = (enabled = isColorSupported) => {
      let f = enabled ? formatter : () => String;
      return {
        isColorSupported: enabled,
        reset: f("\x1B[0m", "\x1B[0m"),
        bold: f("\x1B[1m", "\x1B[22m", "\x1B[22m\x1B[1m"),
        dim: f("\x1B[2m", "\x1B[22m", "\x1B[22m\x1B[2m"),
        italic: f("\x1B[3m", "\x1B[23m"),
        underline: f("\x1B[4m", "\x1B[24m"),
        inverse: f("\x1B[7m", "\x1B[27m"),
        hidden: f("\x1B[8m", "\x1B[28m"),
        strikethrough: f("\x1B[9m", "\x1B[29m"),
        black: f("\x1B[30m", "\x1B[39m"),
        red: f("\x1B[31m", "\x1B[39m"),
        green: f("\x1B[32m", "\x1B[39m"),
        yellow: f("\x1B[33m", "\x1B[39m"),
        blue: f("\x1B[34m", "\x1B[39m"),
        magenta: f("\x1B[35m", "\x1B[39m"),
        cyan: f("\x1B[36m", "\x1B[39m"),
        white: f("\x1B[37m", "\x1B[39m"),
        gray: f("\x1B[90m", "\x1B[39m"),
        bgBlack: f("\x1B[40m", "\x1B[49m"),
        bgRed: f("\x1B[41m", "\x1B[49m"),
        bgGreen: f("\x1B[42m", "\x1B[49m"),
        bgYellow: f("\x1B[43m", "\x1B[49m"),
        bgBlue: f("\x1B[44m", "\x1B[49m"),
        bgMagenta: f("\x1B[45m", "\x1B[49m"),
        bgCyan: f("\x1B[46m", "\x1B[49m"),
        bgWhite: f("\x1B[47m", "\x1B[49m"),
        blackBright: f("\x1B[90m", "\x1B[39m"),
        redBright: f("\x1B[91m", "\x1B[39m"),
        greenBright: f("\x1B[92m", "\x1B[39m"),
        yellowBright: f("\x1B[93m", "\x1B[39m"),
        blueBright: f("\x1B[94m", "\x1B[39m"),
        magentaBright: f("\x1B[95m", "\x1B[39m"),
        cyanBright: f("\x1B[96m", "\x1B[39m"),
        whiteBright: f("\x1B[97m", "\x1B[39m"),
        bgBlackBright: f("\x1B[100m", "\x1B[49m"),
        bgRedBright: f("\x1B[101m", "\x1B[49m"),
        bgGreenBright: f("\x1B[102m", "\x1B[49m"),
        bgYellowBright: f("\x1B[103m", "\x1B[49m"),
        bgBlueBright: f("\x1B[104m", "\x1B[49m"),
        bgMagentaBright: f("\x1B[105m", "\x1B[49m"),
        bgCyanBright: f("\x1B[106m", "\x1B[49m"),
        bgWhiteBright: f("\x1B[107m", "\x1B[49m")
      };
    };
    module.exports = createColors();
    module.exports.createColors = createColors;
  }
});

// node_modules/@clack/core/dist/index.mjs
import { styleText } from "node:util";
import { stdout, stdin } from "node:process";
import * as l from "node:readline";
import l__default from "node:readline";

// node_modules/fast-string-truncated-width/dist/utils.js
var getCodePointsLength = /* @__PURE__ */ (() => {
  const SURROGATE_PAIR_RE = /[\uD800-\uDBFF][\uDC00-\uDFFF]/g;
  return (input) => {
    let surrogatePairsNr = 0;
    SURROGATE_PAIR_RE.lastIndex = 0;
    while (SURROGATE_PAIR_RE.test(input)) {
      surrogatePairsNr += 1;
    }
    return input.length - surrogatePairsNr;
  };
})();
var isFullWidth = (x) => {
  return x === 12288 || x >= 65281 && x <= 65376 || x >= 65504 && x <= 65510;
};
var isWideNotCJKTNotEmoji = (x) => {
  return x === 8987 || x === 9001 || x >= 12272 && x <= 12287 || x >= 12289 && x <= 12350 || x >= 12441 && x <= 12543 || x >= 12549 && x <= 12591 || x >= 12593 && x <= 12686 || x >= 12688 && x <= 12771 || x >= 12783 && x <= 12830 || x >= 12832 && x <= 12871 || x >= 12880 && x <= 19903 || x >= 65040 && x <= 65049 || x >= 65072 && x <= 65106 || x >= 65108 && x <= 65126 || x >= 65128 && x <= 65131 || x >= 127488 && x <= 127490 || x >= 127504 && x <= 127547 || x >= 127552 && x <= 127560 || x >= 131072 && x <= 196605 || x >= 196608 && x <= 262141;
};

// node_modules/fast-string-truncated-width/dist/index.js
var ANSI_RE = /[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]|\u001b\]8;[^;]*;.*?(?:\u0007|\u001b\u005c)/y;
var CONTROL_RE = /[\x00-\x08\x0A-\x1F\x7F-\x9F]{1,1000}/y;
var CJKT_WIDE_RE = /(?:(?![\uFF61-\uFF9F\uFF00-\uFFEF])[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Tangut}]){1,1000}/yu;
var TAB_RE = /\t{1,1000}/y;
var EMOJI_RE = new RegExp("[\\u{1F1E6}-\\u{1F1FF}]{2}|\\u{1F3F4}[\\u{E0061}-\\u{E007A}]{2}[\\u{E0030}-\\u{E0039}\\u{E0061}-\\u{E007A}]{1,3}\\u{E007F}|(?:\\p{Emoji}\\uFE0F\\u20E3?|\\p{Emoji_Modifier_Base}\\p{Emoji_Modifier}?|\\p{Emoji_Presentation})(?:\\u200D(?:\\p{Emoji_Modifier_Base}\\p{Emoji_Modifier}?|\\p{Emoji_Presentation}|\\p{Emoji}\\uFE0F\\u20E3?))*", "yu");
var LATIN_RE = /(?:[\x20-\x7E\xA0-\xFF](?!\uFE0F)){1,1000}/y;
var MODIFIER_RE = new RegExp("\\p{M}+", "gu");
var NO_TRUNCATION = { limit: Infinity, ellipsis: "" };
var getStringTruncatedWidth = (input, truncationOptions = {}, widthOptions = {}) => {
  const LIMIT = truncationOptions.limit ?? Infinity;
  const ELLIPSIS = truncationOptions.ellipsis ?? "";
  const ELLIPSIS_WIDTH = truncationOptions?.ellipsisWidth ?? (ELLIPSIS ? getStringTruncatedWidth(ELLIPSIS, NO_TRUNCATION, widthOptions).width : 0);
  const ANSI_WIDTH = 0;
  const CONTROL_WIDTH = widthOptions.controlWidth ?? 0;
  const TAB_WIDTH = widthOptions.tabWidth ?? 8;
  const EMOJI_WIDTH = widthOptions.emojiWidth ?? 2;
  const FULL_WIDTH_WIDTH = 2;
  const REGULAR_WIDTH = widthOptions.regularWidth ?? 1;
  const WIDE_WIDTH = widthOptions.wideWidth ?? FULL_WIDTH_WIDTH;
  const PARSE_BLOCKS = [
    [LATIN_RE, REGULAR_WIDTH],
    [ANSI_RE, ANSI_WIDTH],
    [CONTROL_RE, CONTROL_WIDTH],
    [TAB_RE, TAB_WIDTH],
    [EMOJI_RE, EMOJI_WIDTH],
    [CJKT_WIDE_RE, WIDE_WIDTH]
  ];
  let indexPrev = 0;
  let index = 0;
  let length = input.length;
  let lengthExtra = 0;
  let truncationEnabled = false;
  let truncationIndex = length;
  let truncationLimit = Math.max(0, LIMIT - ELLIPSIS_WIDTH);
  let unmatchedStart = 0;
  let unmatchedEnd = 0;
  let width = 0;
  let widthExtra = 0;
  outer: while (true) {
    if (unmatchedEnd > unmatchedStart || index >= length && index > indexPrev) {
      const unmatched = input.slice(unmatchedStart, unmatchedEnd) || input.slice(indexPrev, index);
      lengthExtra = 0;
      for (const char of unmatched.replaceAll(MODIFIER_RE, "")) {
        const codePoint = char.codePointAt(0) || 0;
        if (isFullWidth(codePoint)) {
          widthExtra = FULL_WIDTH_WIDTH;
        } else if (isWideNotCJKTNotEmoji(codePoint)) {
          widthExtra = WIDE_WIDTH;
        } else {
          widthExtra = REGULAR_WIDTH;
        }
        if (width + widthExtra > truncationLimit) {
          truncationIndex = Math.min(truncationIndex, Math.max(unmatchedStart, indexPrev) + lengthExtra);
        }
        if (width + widthExtra > LIMIT) {
          truncationEnabled = true;
          break outer;
        }
        lengthExtra += char.length;
        width += widthExtra;
      }
      unmatchedStart = unmatchedEnd = 0;
    }
    if (index >= length) {
      break outer;
    }
    for (let i2 = 0, l2 = PARSE_BLOCKS.length; i2 < l2; i2++) {
      const [BLOCK_RE, BLOCK_WIDTH] = PARSE_BLOCKS[i2];
      BLOCK_RE.lastIndex = index;
      if (BLOCK_RE.test(input)) {
        lengthExtra = BLOCK_RE === CJKT_WIDE_RE ? getCodePointsLength(input.slice(index, BLOCK_RE.lastIndex)) : BLOCK_RE === EMOJI_RE ? 1 : BLOCK_RE.lastIndex - index;
        widthExtra = lengthExtra * BLOCK_WIDTH;
        if (width + widthExtra > truncationLimit) {
          truncationIndex = Math.min(truncationIndex, index + Math.floor((truncationLimit - width) / BLOCK_WIDTH));
        }
        if (width + widthExtra > LIMIT) {
          truncationEnabled = true;
          break outer;
        }
        width += widthExtra;
        unmatchedStart = indexPrev;
        unmatchedEnd = index;
        index = indexPrev = BLOCK_RE.lastIndex;
        continue outer;
      }
    }
    index += 1;
  }
  return {
    width: truncationEnabled ? truncationLimit : width,
    index: truncationEnabled ? truncationIndex : length,
    truncated: truncationEnabled,
    ellipsed: truncationEnabled && LIMIT >= ELLIPSIS_WIDTH
  };
};
var dist_default = getStringTruncatedWidth;

// node_modules/fast-string-width/dist/index.js
var NO_TRUNCATION2 = {
  limit: Infinity,
  ellipsis: "",
  ellipsisWidth: 0
};
var fastStringWidth = (input, options = {}) => {
  return dist_default(input, NO_TRUNCATION2, options).width;
};
var dist_default2 = fastStringWidth;

// node_modules/fast-wrap-ansi/lib/main.js
var ESC = "\x1B";
var CSI = "\x9B";
var END_CODE = 39;
var ANSI_ESCAPE_BELL = "\x07";
var ANSI_CSI = "[";
var ANSI_OSC = "]";
var ANSI_SGR_TERMINATOR = "m";
var ANSI_ESCAPE_LINK = `${ANSI_OSC}8;;`;
var GROUP_REGEX = new RegExp(`(?:\\${ANSI_CSI}(?<code>\\d+)m|\\${ANSI_ESCAPE_LINK}(?<uri>.*)${ANSI_ESCAPE_BELL})`, "y");
var getClosingCode = (openingCode) => {
  if (openingCode >= 30 && openingCode <= 37)
    return 39;
  if (openingCode >= 90 && openingCode <= 97)
    return 39;
  if (openingCode >= 40 && openingCode <= 47)
    return 49;
  if (openingCode >= 100 && openingCode <= 107)
    return 49;
  if (openingCode === 1 || openingCode === 2)
    return 22;
  if (openingCode === 3)
    return 23;
  if (openingCode === 4)
    return 24;
  if (openingCode === 7)
    return 27;
  if (openingCode === 8)
    return 28;
  if (openingCode === 9)
    return 29;
  if (openingCode === 0)
    return 0;
  return void 0;
};
var wrapAnsiCode = (code) => `${ESC}${ANSI_CSI}${code}${ANSI_SGR_TERMINATOR}`;
var wrapAnsiHyperlink = (url) => `${ESC}${ANSI_ESCAPE_LINK}${url}${ANSI_ESCAPE_BELL}`;
var wrapWord = (rows, word, columns) => {
  const characters = word[Symbol.iterator]();
  let isInsideEscape = false;
  let isInsideLinkEscape = false;
  let lastRow = rows.at(-1);
  let visible = lastRow === void 0 ? 0 : dist_default2(lastRow);
  let currentCharacter = characters.next();
  let nextCharacter = characters.next();
  let rawCharacterIndex = 0;
  while (!currentCharacter.done) {
    const character = currentCharacter.value;
    const characterLength = dist_default2(character);
    if (visible + characterLength <= columns) {
      rows[rows.length - 1] += character;
    } else {
      rows.push(character);
      visible = 0;
    }
    if (character === ESC || character === CSI) {
      isInsideEscape = true;
      isInsideLinkEscape = word.startsWith(ANSI_ESCAPE_LINK, rawCharacterIndex + 1);
    }
    if (isInsideEscape) {
      if (isInsideLinkEscape) {
        if (character === ANSI_ESCAPE_BELL) {
          isInsideEscape = false;
          isInsideLinkEscape = false;
        }
      } else if (character === ANSI_SGR_TERMINATOR) {
        isInsideEscape = false;
      }
    } else {
      visible += characterLength;
      if (visible === columns && !nextCharacter.done) {
        rows.push("");
        visible = 0;
      }
    }
    currentCharacter = nextCharacter;
    nextCharacter = characters.next();
    rawCharacterIndex += character.length;
  }
  lastRow = rows.at(-1);
  if (!visible && lastRow !== void 0 && lastRow.length && rows.length > 1) {
    rows[rows.length - 2] += rows.pop();
  }
};
var stringVisibleTrimSpacesRight = (string) => {
  const words = string.split(" ");
  let last = words.length;
  while (last) {
    if (dist_default2(words[last - 1])) {
      break;
    }
    last--;
  }
  if (last === words.length) {
    return string;
  }
  return words.slice(0, last).join(" ") + words.slice(last).join("");
};
var exec = (string, columns, options = {}) => {
  if (options.trim !== false && string.trim() === "") {
    return "";
  }
  let returnValue = "";
  let escapeCode;
  let escapeUrl;
  const words = string.split(" ");
  let rows = [""];
  let rowLength = 0;
  for (let index = 0; index < words.length; index++) {
    const word = words[index];
    if (options.trim !== false) {
      const row = rows.at(-1) ?? "";
      const trimmed = row.trimStart();
      if (row.length !== trimmed.length) {
        rows[rows.length - 1] = trimmed;
        rowLength = dist_default2(trimmed);
      }
    }
    if (index !== 0) {
      if (rowLength >= columns && (options.wordWrap === false || options.trim === false)) {
        rows.push("");
        rowLength = 0;
      }
      if (rowLength || options.trim === false) {
        rows[rows.length - 1] += " ";
        rowLength++;
      }
    }
    const wordLength = dist_default2(word);
    if (options.hard && wordLength > columns) {
      const remainingColumns = columns - rowLength;
      const breaksStartingThisLine = 1 + Math.floor((wordLength - remainingColumns - 1) / columns);
      const breaksStartingNextLine = Math.floor((wordLength - 1) / columns);
      if (breaksStartingNextLine < breaksStartingThisLine) {
        rows.push("");
      }
      wrapWord(rows, word, columns);
      rowLength = dist_default2(rows.at(-1) ?? "");
      continue;
    }
    if (rowLength + wordLength > columns && rowLength && wordLength) {
      if (options.wordWrap === false && rowLength < columns) {
        wrapWord(rows, word, columns);
        rowLength = dist_default2(rows.at(-1) ?? "");
        continue;
      }
      rows.push("");
      rowLength = 0;
    }
    if (rowLength + wordLength > columns && options.wordWrap === false) {
      wrapWord(rows, word, columns);
      rowLength = dist_default2(rows.at(-1) ?? "");
      continue;
    }
    rows[rows.length - 1] += word;
    rowLength += wordLength;
  }
  if (options.trim !== false) {
    rows = rows.map((row) => stringVisibleTrimSpacesRight(row));
  }
  const preString = rows.join("\n");
  let inSurrogate = false;
  for (let i2 = 0; i2 < preString.length; i2++) {
    const character = preString[i2];
    returnValue += character;
    if (!inSurrogate) {
      inSurrogate = character >= "\uD800" && character <= "\uDBFF";
      if (inSurrogate) {
        continue;
      }
    } else {
      inSurrogate = false;
    }
    if (character === ESC || character === CSI) {
      GROUP_REGEX.lastIndex = i2 + 1;
      const groupsResult = GROUP_REGEX.exec(preString);
      const groups = groupsResult?.groups;
      if (groups?.code !== void 0) {
        const code = Number.parseFloat(groups.code);
        escapeCode = code === END_CODE ? void 0 : code;
      } else if (groups?.uri !== void 0) {
        escapeUrl = groups.uri.length === 0 ? void 0 : groups.uri;
      }
    }
    if (preString[i2 + 1] === "\n") {
      if (escapeUrl) {
        returnValue += wrapAnsiHyperlink("");
      }
      const closingCode = escapeCode ? getClosingCode(escapeCode) : void 0;
      if (escapeCode && closingCode) {
        returnValue += wrapAnsiCode(closingCode);
      }
    } else if (character === "\n") {
      if (escapeCode && getClosingCode(escapeCode)) {
        returnValue += wrapAnsiCode(escapeCode);
      }
      if (escapeUrl) {
        returnValue += wrapAnsiHyperlink(escapeUrl);
      }
    }
  }
  return returnValue;
};
var CRLF_OR_LF = /\r?\n/;
function wrapAnsi(string, columns, options) {
  return String(string).normalize().split(CRLF_OR_LF).map((line) => exec(line, columns, options)).join("\n");
}

// node_modules/@clack/core/dist/index.mjs
var import_sisteransi = __toESM(require_src(), 1);
import { ReadStream } from "node:tty";
function findCursor(s, o2, l2) {
  if (!l2.some((r2) => !r2.disabled))
    return s;
  const t2 = s + o2, n2 = Math.max(l2.length - 1, 0), e = t2 < 0 ? n2 : t2 > n2 ? 0 : t2;
  return l2[e].disabled ? findCursor(e, o2 < 0 ? -1 : 1, l2) : e;
}
var a$2 = ["up", "down", "left", "right", "space", "enter", "cancel"];
var t = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December"
];
var settings = {
  actions: new Set(a$2),
  aliases: /* @__PURE__ */ new Map([
    // vim support
    ["k", "up"],
    ["j", "down"],
    ["h", "left"],
    ["l", "right"],
    ["", "cancel"],
    // opinionated defaults!
    ["escape", "cancel"]
  ]),
  messages: {
    cancel: "Canceled",
    error: "Something went wrong"
  },
  withGuide: true,
  date: {
    monthNames: [...t],
    messages: {
      required: "Please enter a valid date",
      invalidMonth: "There are only 12 months in a year",
      invalidDay: (n2, e) => `There are only ${n2} days in ${e}`,
      afterMin: (n2) => `Date must be on or after ${n2.toISOString().slice(0, 10)}`,
      beforeMax: (n2) => `Date must be on or before ${n2.toISOString().slice(0, 10)}`
    }
  }
};
function isActionKey(n2, e) {
  if (typeof n2 == "string")
    return settings.aliases.get(n2) === e;
  for (const s of n2)
    if (s !== void 0 && isActionKey(s, e))
      return true;
  return false;
}
function diffLines(i2, s) {
  if (i2 === s) return;
  const e = i2.split(`
`), t2 = s.split(`
`), r2 = Math.max(e.length, t2.length), f = [];
  for (let n2 = 0; n2 < r2; n2++)
    e[n2] !== t2[n2] && f.push(n2);
  return {
    lines: f,
    numLinesBefore: e.length,
    numLinesAfter: t2.length,
    numLines: r2
  };
}
var R = globalThis.process.platform.startsWith("win");
var CANCEL_SYMBOL = Symbol("clack:cancel");
function isCancel(e) {
  return e === CANCEL_SYMBOL;
}
function setRawMode(e, r2) {
  const o2 = e;
  o2.isTTY && o2.setRawMode(r2);
}
function block({
  input: e = stdin,
  output: r2 = stdout,
  overwrite: o2 = true,
  hideCursor: t2 = true
} = {}) {
  const s = l.createInterface({
    input: e,
    output: r2,
    prompt: "",
    tabSize: 1
  });
  l.emitKeypressEvents(e, s), e instanceof ReadStream && e.isTTY && e.setRawMode(true);
  const n2 = (f, { name: a3, sequence: p }) => {
    const c2 = String(f);
    if (isActionKey([c2, a3, p], "cancel")) {
      t2 && r2.write(import_sisteransi.cursor.show), process.exit(0);
      return;
    }
    if (!o2) return;
    const i2 = a3 === "return" ? 0 : -1, m = a3 === "return" ? -1 : 0;
    l.moveCursor(r2, i2, m, () => {
      l.clearLine(r2, 1, () => {
        e.once("keypress", n2);
      });
    });
  };
  return t2 && r2.write(import_sisteransi.cursor.hide), e.once("keypress", n2), () => {
    e.off("keypress", n2), t2 && r2.write(import_sisteransi.cursor.show), e instanceof ReadStream && e.isTTY && !R && e.setRawMode(false), s.terminal = false, s.close();
  };
}
var getColumns = (e) => "columns" in e && typeof e.columns == "number" ? e.columns : 80;
var getRows = (e) => "rows" in e && typeof e.rows == "number" ? e.rows : 20;
function wrapTextWithPrefix(e, r2, o2, t2 = o2, s = o2, n2) {
  const f = getColumns(e ?? stdout);
  return wrapAnsi(r2, f - o2.length, {
    hard: true,
    trim: false
  }).split(`
`).map((c2, i2, m) => {
    const d2 = n2 ? n2(c2, i2) : c2;
    return i2 === 0 ? `${t2}${d2}` : i2 === m.length - 1 ? `${s}${d2}` : `${o2}${d2}`;
  }).join(`
`);
}
function runValidation(e, n2) {
  if ("~standard" in e) {
    const a3 = e["~standard"].validate(n2);
    if (a3 instanceof Promise)
      throw new TypeError(
        "Schema validation must be synchronous. Update `validate()` and remove any asynchronous logic."
      );
    return a3.issues?.at(0)?.message;
  }
  return e(n2);
}
var V = class {
  input;
  output;
  _abortSignal;
  rl;
  opts;
  _render;
  _track = false;
  _prevFrame = "";
  _subscribers = /* @__PURE__ */ new Map();
  _cursor = 0;
  state = "initial";
  error = "";
  value;
  userInput = "";
  constructor(t2, e = true) {
    const { input: i2 = stdin, output: n2 = stdout, render: s, signal: r2, ...o2 } = t2;
    this.opts = o2, this.onKeypress = this.onKeypress.bind(this), this.close = this.close.bind(this), this.render = this.render.bind(this), this._render = s.bind(this), this._track = e, this._abortSignal = r2, this.input = i2, this.output = n2;
  }
  /**
   * Unsubscribe all listeners
   */
  unsubscribe() {
    this._subscribers.clear();
  }
  /**
   * Set a subscriber with opts
   * @param event - The event name
   */
  setSubscriber(t2, e) {
    const i2 = this._subscribers.get(t2) ?? [];
    i2.push(e), this._subscribers.set(t2, i2);
  }
  /**
   * Subscribe to an event
   * @param event - The event name
   * @param cb - The callback
   */
  on(t2, e) {
    this.setSubscriber(t2, { cb: e });
  }
  /**
   * Subscribe to an event once
   * @param event - The event name
   * @param cb - The callback
   */
  once(t2, e) {
    this.setSubscriber(t2, { cb: e, once: true });
  }
  /**
   * Emit an event with data
   * @param event - The event name
   * @param data - The data to pass to the callback
   */
  emit(t2, ...e) {
    const i2 = this._subscribers.get(t2) ?? [], n2 = [];
    for (const s of i2)
      s.cb(...e), s.once && n2.push(() => i2.splice(i2.indexOf(s), 1));
    for (const s of n2)
      s();
  }
  prompt() {
    return new Promise((t2) => {
      if (this._abortSignal) {
        if (this._abortSignal.aborted)
          return this.state = "cancel", this.close(), t2(CANCEL_SYMBOL);
        this._abortSignal.addEventListener(
          "abort",
          () => {
            this.state = "cancel", this.close();
          },
          { once: true }
        );
      }
      this.rl = l__default.createInterface({
        input: this.input,
        tabSize: 2,
        prompt: "",
        escapeCodeTimeout: 50,
        terminal: true
      }), this.rl.prompt(), this.opts.initialUserInput !== void 0 && this._setUserInput(this.opts.initialUserInput, true), this.input.on("keypress", this.onKeypress), setRawMode(this.input, true), this.output.on("resize", this.render), this.render(), this.once("submit", () => {
        this.output.write(import_sisteransi.cursor.show), this.output.off("resize", this.render), setRawMode(this.input, false), t2(this.value);
      }), this.once("cancel", () => {
        this.output.write(import_sisteransi.cursor.show), this.output.off("resize", this.render), setRawMode(this.input, false), t2(CANCEL_SYMBOL);
      });
    });
  }
  _isActionKey(t2, e) {
    return t2 === "	";
  }
  _shouldSubmit(t2, e) {
    return true;
  }
  _setValue(t2) {
    this.value = t2, this.emit("value", this.value);
  }
  _setUserInput(t2, e) {
    this.userInput = t2 ?? "", this.emit("userInput", this.userInput), e && this._track && this.rl && (this.rl.write(this.userInput), this._cursor = this.rl.cursor);
  }
  _clearUserInput() {
    this.rl?.write(null, { ctrl: true, name: "u" }), this._setUserInput("");
  }
  onKeypress(t2, e) {
    if (this._track && e.name !== "return" && (e.name && this._isActionKey(t2, e) && this.rl?.write(null, { ctrl: true, name: "h" }), this._cursor = this.rl?.cursor ?? 0, this._setUserInput(this.rl?.line)), this.state === "error" && (this.state = "active"), e?.name && (!this._track && settings.aliases.has(e.name) && this.emit("cursor", settings.aliases.get(e.name)), settings.actions.has(e.name) && this.emit("cursor", e.name)), t2 && (t2.toLowerCase() === "y" || t2.toLowerCase() === "n") && this.emit("confirm", t2.toLowerCase() === "y"), this.emit("key", t2, e), e?.name === "return" && this._shouldSubmit(t2, e)) {
      if (this.opts.validate) {
        const i2 = runValidation(this.opts.validate, this.value);
        i2 && (this.error = i2 instanceof Error ? i2.message : i2, this.state = "error", this.rl?.write(this.userInput));
      }
      this.state !== "error" && (this.state = "submit");
    }
    isActionKey([t2, e?.name, e?.sequence], "cancel") && (this.state = "cancel"), (this.state === "submit" || this.state === "cancel") && this.emit("finalize"), this.render(), (this.state === "submit" || this.state === "cancel") && this.close();
  }
  close() {
    this.input.unpipe(), this.input.removeListener("keypress", this.onKeypress), this.output.write(`
`), setRawMode(this.input, false), this.rl?.close(), this.rl = void 0, this.emit(`${this.state}`, this.value), this.unsubscribe();
  }
  restoreCursor() {
    const t2 = wrapAnsi(this._prevFrame, process.stdout.columns, { hard: true, trim: false }).split(`
`).length - 1;
    this.output.write(import_sisteransi.cursor.move(-999, t2 * -1));
  }
  render() {
    const t2 = wrapAnsi(this._render(this) ?? "", process.stdout.columns, {
      hard: true,
      trim: false
    });
    if (t2 !== this._prevFrame) {
      if (this.state === "initial")
        this.output.write(import_sisteransi.cursor.hide);
      else {
        const e = diffLines(this._prevFrame, t2), i2 = getRows(this.output);
        if (this.restoreCursor(), e) {
          const n2 = Math.max(0, e.numLinesAfter - i2), s = Math.max(0, e.numLinesBefore - i2);
          let r2 = e.lines.find((o2) => o2 >= n2);
          if (r2 === void 0) {
            this._prevFrame = t2;
            return;
          }
          if (e.lines.length === 1) {
            this.output.write(import_sisteransi.cursor.move(0, r2 - s)), this.output.write(import_sisteransi.erase.lines(1));
            const o2 = t2.split(`
`);
            this.output.write(o2[r2]), this._prevFrame = t2, this.output.write(import_sisteransi.cursor.move(0, o2.length - r2 - 1));
            return;
          } else if (e.lines.length > 1) {
            if (n2 < s)
              r2 = n2;
            else {
              const h2 = r2 - s;
              h2 > 0 && this.output.write(import_sisteransi.cursor.move(0, h2));
            }
            this.output.write(import_sisteransi.erase.down());
            const f = t2.split(`
`).slice(r2);
            this.output.write(f.join(`
`)), this._prevFrame = t2;
            return;
          }
        }
        this.output.write(import_sisteransi.erase.down());
      }
      this.output.write(t2), this.state === "initial" && (this.state = "active"), this._prevFrame = t2;
    }
  }
};
var r = class extends V {
  get cursor() {
    return this.value ? 0 : 1;
  }
  get _value() {
    return this.cursor === 0;
  }
  constructor(t2) {
    super(t2, false), this.value = !!t2.initialValue, this.on("userInput", () => {
      this.value = this._value;
    }), this.on("confirm", (i2) => {
      this.output.write(import_sisteransi.cursor.move(0, -1)), this.value = i2, this.state = "submit", this.close();
    }), this.on("cursor", () => {
      this.value = !this.value;
    });
  }
};
var a$1 = class a extends V {
  options;
  cursor = 0;
  get _value() {
    return this.options[this.cursor].value;
  }
  get _enabledOptions() {
    return this.options.filter((e) => e.disabled !== true);
  }
  toggleAll() {
    const e = this._enabledOptions, i2 = this.value !== void 0 && this.value.length === e.length;
    this.value = i2 ? [] : e.map((t2) => t2.value);
  }
  toggleInvert() {
    const e = this.value;
    if (!e)
      return;
    const i2 = this._enabledOptions.filter((t2) => !e.includes(t2.value));
    this.value = i2.map((t2) => t2.value);
  }
  toggleValue() {
    this.value === void 0 && (this.value = []);
    const e = this.value.includes(this._value);
    this.value = e ? this.value.filter((i2) => i2 !== this._value) : [...this.value, this._value];
  }
  constructor(e) {
    super(e, false), this.options = e.options, this.value = [...e.initialValues ?? []];
    const i2 = Math.max(
      this.options.findIndex(({ value: t2 }) => t2 === e.cursorAt),
      0
    );
    this.cursor = this.options[i2].disabled ? findCursor(i2, 1, this.options) : i2, this.on("key", (t2, l2) => {
      l2.name === "a" && this.toggleAll(), l2.name === "i" && this.toggleInvert();
    }), this.on("cursor", (t2) => {
      switch (t2) {
        case "left":
        case "up":
          this.cursor = findCursor(this.cursor, -1, this.options);
          break;
        case "down":
        case "right":
          this.cursor = findCursor(this.cursor, 1, this.options);
          break;
        case "space":
          this.toggleValue();
          break;
      }
    });
  }
};
var o = class extends V {
  _mask = "\u2022";
  get cursor() {
    return this._cursor;
  }
  get masked() {
    return this.userInput.replaceAll(/./g, this._mask);
  }
  get userInputWithCursor() {
    if (this.state === "submit" || this.state === "cancel")
      return this.masked;
    const t2 = this.userInput;
    if (this.cursor >= t2.length)
      return `${this.masked}${styleText(["inverse", "hidden"], "_")}`;
    const s = this.masked, r2 = s.slice(0, this.cursor), e = s.slice(this.cursor);
    return `${r2}${styleText("inverse", e[0])}${e.slice(1)}`;
  }
  clear() {
    this._clearUserInput();
  }
  constructor({ mask: t2, ...s }) {
    super(s), this._mask = t2 ?? "\u2022", this.on("userInput", (r2) => {
      this._setValue(r2);
    });
  }
};
var a2 = class extends V {
  options;
  cursor = 0;
  get _selectedValue() {
    return this.options[this.cursor];
  }
  changeValue() {
    this.value = this._selectedValue.value;
  }
  constructor(t2) {
    super(t2, false), this.options = t2.options;
    const i2 = this.options.findIndex(({ value: s }) => s === t2.initialValue), e = i2 === -1 ? 0 : i2;
    this.cursor = this.options[e].disabled ? findCursor(e, 1, this.options) : e, this.changeValue(), this.on("cursor", (s) => {
      switch (s) {
        case "left":
        case "up":
          this.cursor = findCursor(this.cursor, -1, this.options);
          break;
        case "down":
        case "right":
          this.cursor = findCursor(this.cursor, 1, this.options);
          break;
      }
      this.changeValue();
    });
  }
};
var n = class extends V {
  get userInputWithCursor() {
    if (this.state === "submit")
      return this.userInput;
    const t2 = this.userInput;
    if (this.cursor >= t2.length)
      return `${this.userInput}\u2588`;
    const e = t2.slice(0, this.cursor), [s, ...r2] = t2.slice(this.cursor);
    return `${e}${styleText("inverse", s)}${r2.join("")}`;
  }
  get cursor() {
    return this._cursor;
  }
  constructor(t2) {
    super({
      ...t2,
      initialUserInput: t2.initialUserInput ?? t2.initialValue
    }), this.on("userInput", (e) => {
      this._setValue(e);
    }), this.on("finalize", () => {
      this.value || (this.value = t2.defaultValue), this.value === void 0 && (this.value = "");
    });
  }
};

// node_modules/@clack/prompts/dist/index.mjs
import { styleText as styleText2, stripVTControlCharacters } from "node:util";
import process$1 from "node:process";
var import_sisteransi2 = __toESM(require_src(), 1);
function isUnicodeSupported() {
  if (process$1.platform !== "win32") {
    return process$1.env.TERM !== "linux";
  }
  return Boolean(process$1.env.CI) || Boolean(process$1.env.WT_SESSION) || Boolean(process$1.env.TERMINUS_SUBLIME) || process$1.env.ConEmuTask === "{cmd::Cmder}" || process$1.env.TERM_PROGRAM === "Terminus-Sublime" || process$1.env.TERM_PROGRAM === "vscode" || process$1.env.TERM === "xterm-256color" || process$1.env.TERM === "alacritty" || process$1.env.TERMINAL_EMULATOR === "JetBrains-JediTerm";
}
var unicode = isUnicodeSupported();
var isCI = () => process.env.CI === "true";
var unicodeOr = (e, o2) => unicode ? e : o2;
var S_STEP_ACTIVE = unicodeOr("\u25C6", "*");
var S_STEP_CANCEL = unicodeOr("\u25A0", "x");
var S_STEP_ERROR = unicodeOr("\u25B2", "x");
var S_STEP_SUBMIT = unicodeOr("\u25C7", "o");
var S_BAR_START = unicodeOr("\u250C", "T");
var S_BAR = unicodeOr("\u2502", "|");
var S_BAR_END = unicodeOr("\u2514", "\u2014");
var S_BAR_START_RIGHT = unicodeOr("\u2510", "T");
var S_BAR_END_RIGHT = unicodeOr("\u2518", "\u2014");
var S_RADIO_ACTIVE = unicodeOr("\u25CF", ">");
var S_RADIO_INACTIVE = unicodeOr("\u25CB", " ");
var S_CHECKBOX_ACTIVE = unicodeOr("\u25FB", "[\u2022]");
var S_CHECKBOX_SELECTED = unicodeOr("\u25FC", "[+]");
var S_CHECKBOX_INACTIVE = unicodeOr("\u25FB", "[ ]");
var S_PASSWORD_MASK = unicodeOr("\u25AA", "\u2022");
var S_BAR_H = unicodeOr("\u2500", "-");
var S_CORNER_TOP_RIGHT = unicodeOr("\u256E", "+");
var S_CONNECT_LEFT = unicodeOr("\u251C", "+");
var S_CORNER_BOTTOM_RIGHT = unicodeOr("\u256F", "+");
var S_CORNER_BOTTOM_LEFT = unicodeOr("\u2570", "+");
var S_CORNER_TOP_LEFT = unicodeOr("\u256D", "+");
var S_INFO = unicodeOr("\u25CF", "\u2022");
var S_SUCCESS = unicodeOr("\u25C6", "*");
var S_WARN = unicodeOr("\u25B2", "!");
var S_ERROR = unicodeOr("\u25A0", "x");
var symbol = (e) => {
  switch (e) {
    case "initial":
    case "active":
      return styleText2("cyan", S_STEP_ACTIVE);
    case "cancel":
      return styleText2("red", S_STEP_CANCEL);
    case "error":
      return styleText2("yellow", S_STEP_ERROR);
    case "submit":
      return styleText2("green", S_STEP_SUBMIT);
  }
};
var symbolBar = (e) => {
  switch (e) {
    case "initial":
    case "active":
      return styleText2("cyan", S_BAR);
    case "cancel":
      return styleText2("red", S_BAR);
    case "error":
      return styleText2("yellow", S_BAR);
    case "submit":
      return styleText2("green", S_BAR);
  }
};
var E$1 = (l2, o2, g, c2, h2, O = false) => {
  let r2 = o2, w = 0;
  if (O)
    for (let i2 = c2 - 1; i2 >= g && (r2 -= l2[i2].length, w++, !(r2 <= h2)); i2--)
      ;
  else
    for (let i2 = g; i2 < c2 && (r2 -= l2[i2].length, w++, !(r2 <= h2)); i2++)
      ;
  return { lineCount: r2, removals: w };
};
var limitOptions = ({
  cursor: l2,
  options: o2,
  style: g,
  output: c2 = process.stdout,
  maxItems: h2 = Number.POSITIVE_INFINITY,
  columnPadding: O = 0,
  rowPadding: r2 = 4
}) => {
  const i2 = getColumns(c2) - O, I = getRows(c2), C2 = styleText2("dim", "..."), x = Math.max(I - r2, 0), m = Math.max(Math.min(h2, x), 5);
  let p = 0;
  l2 >= m - 3 && (p = Math.max(
    Math.min(l2 - m + 3, o2.length - m),
    0
  ));
  let f = m < o2.length && p > 0, u3 = m < o2.length && p + m < o2.length;
  const W2 = Math.min(
    p + m,
    o2.length
  ), e = [];
  let d2 = 0;
  f && d2++, u3 && d2++;
  const v = p + (f ? 1 : 0), P = W2 - (u3 ? 1 : 0);
  for (let t2 = v; t2 < P; t2++) {
    const n2 = wrapAnsi(g(o2[t2], t2 === l2), i2, {
      hard: true,
      trim: false
    }).split(`
`);
    e.push(n2), d2 += n2.length;
  }
  if (d2 > x) {
    let t2 = 0, n2 = 0, s = d2;
    const M = l2 - v;
    let a3 = x;
    const T = () => E$1(e, s, 0, M, a3), L = () => E$1(
      e,
      s,
      M + 1,
      e.length,
      a3,
      true
    );
    f ? ({ lineCount: s, removals: t2 } = T(), s > a3 && (u3 || (a3 -= 1), { lineCount: s, removals: n2 } = L())) : (u3 || (a3 -= 1), { lineCount: s, removals: n2 } = L(), s > a3 && (a3 -= 1, { lineCount: s, removals: t2 } = T())), t2 > 0 && (f = true, e.splice(0, t2)), n2 > 0 && (u3 = true, e.splice(e.length - n2, n2));
  }
  const b = [];
  f && b.push(C2);
  for (const t2 of e)
    for (const n2 of t2)
      b.push(n2);
  return u3 && b.push(C2), b;
};
var confirm = (i2) => {
  const a3 = i2.active ?? "Yes", s = i2.inactive ?? "No";
  return new r({
    active: a3,
    inactive: s,
    signal: i2.signal,
    input: i2.input,
    output: i2.output,
    initialValue: i2.initialValue ?? true,
    render() {
      const e = i2.withGuide ?? settings.withGuide, u3 = `${symbol(this.state)}  `, l2 = e ? `${styleText2("gray", S_BAR)}  ` : "", f = wrapTextWithPrefix(
        i2.output,
        i2.message,
        l2,
        u3
      ), o2 = `${e ? `${styleText2("gray", S_BAR)}
` : ""}${f}
`, c2 = this.value ? a3 : s;
      switch (this.state) {
        case "submit": {
          const r2 = e ? `${styleText2("gray", S_BAR)}  ` : "";
          return `${o2}${r2}${styleText2("dim", c2)}`;
        }
        case "cancel": {
          const r2 = e ? `${styleText2("gray", S_BAR)}  ` : "";
          return `${o2}${r2}${styleText2(["strikethrough", "dim"], c2)}${e ? `
${styleText2("gray", S_BAR)}` : ""}`;
        }
        default: {
          const r2 = e ? `${styleText2("cyan", S_BAR)}  ` : "", g = e ? styleText2("cyan", S_BAR_END) : "";
          return `${o2}${r2}${this.value ? `${styleText2("green", S_RADIO_ACTIVE)} ${a3}` : `${styleText2("dim", S_RADIO_INACTIVE)} ${styleText2("dim", a3)}`}${i2.vertical ? e ? `
${styleText2("cyan", S_BAR)}  ` : `
` : ` ${styleText2("dim", "/")} `}${this.value ? `${styleText2("dim", S_RADIO_INACTIVE)} ${styleText2("dim", s)}` : `${styleText2("green", S_RADIO_ACTIVE)} ${s}`}
${g}
`;
        }
      }
    }
  }).prompt();
};
var log = {
  message: (s = [], {
    symbol: e = styleText2("gray", S_BAR),
    secondarySymbol: r2 = styleText2("gray", S_BAR),
    output: m = process.stdout,
    spacing: l2 = 1,
    withGuide: c2
  } = {}) => {
    const t2 = [], o2 = c2 ?? settings.withGuide, f = o2 ? r2 : "", O = o2 ? `${e}  ` : "", u3 = o2 ? `${r2}  ` : "";
    for (let i2 = 0; i2 < l2; i2++)
      t2.push(f);
    const g = Array.isArray(s) ? s : s.split(`
`);
    if (g.length > 0) {
      const [i2, ...y] = g;
      i2.length > 0 ? t2.push(`${O}${i2}`) : t2.push(o2 ? e : "");
      for (const p of y)
        p.length > 0 ? t2.push(`${u3}${p}`) : t2.push(o2 ? r2 : "");
    }
    m.write(`${t2.join(`
`)}
`);
  },
  info: (s, e) => {
    log.message(s, { ...e, symbol: styleText2("blue", S_INFO) });
  },
  success: (s, e) => {
    log.message(s, { ...e, symbol: styleText2("green", S_SUCCESS) });
  },
  step: (s, e) => {
    log.message(s, { ...e, symbol: styleText2("green", S_STEP_SUBMIT) });
  },
  warn: (s, e) => {
    log.message(s, { ...e, symbol: styleText2("yellow", S_WARN) });
  },
  /** alias for `log.warn()`. */
  warning: (s, e) => {
    log.warn(s, e);
  },
  error: (s, e) => {
    log.message(s, { ...e, symbol: styleText2("red", S_ERROR) });
  }
};
var cancel = (o2 = "", t2) => {
  const i2 = t2?.output ?? process.stdout, e = t2?.withGuide ?? settings.withGuide ? `${styleText2("gray", S_BAR_END)}  ` : "";
  i2.write(`${e}${styleText2("red", o2)}

`);
};
var intro = (o2 = "", t2) => {
  const i2 = t2?.output ?? process.stdout, e = t2?.withGuide ?? settings.withGuide ? `${styleText2("gray", S_BAR_START)}  ` : "";
  i2.write(`${e}${o2}
`);
};
var outro = (o2 = "", t2) => {
  const i2 = t2?.output ?? process.stdout, e = t2?.withGuide ?? settings.withGuide ? `${styleText2("gray", S_BAR)}
${styleText2("gray", S_BAR_END)}  ` : "";
  i2.write(`${e}${o2}

`);
};
var d = (n2, a3) => n2.split(`
`).map((m) => a3(m)).join(`
`);
var multiselect = (n2) => {
  const a3 = (t2, o2) => {
    const r2 = t2.label ?? String(t2.value);
    return o2 === "disabled" ? `${styleText2("gray", S_CHECKBOX_INACTIVE)} ${d(r2, (l2) => styleText2(["strikethrough", "gray"], l2))}${t2.hint ? ` ${styleText2("dim", `(${t2.hint ?? "disabled"})`)}` : ""}` : o2 === "active" ? `${styleText2("cyan", S_CHECKBOX_ACTIVE)} ${r2}${t2.hint ? ` ${styleText2("dim", `(${t2.hint})`)}` : ""}` : o2 === "selected" ? `${styleText2("green", S_CHECKBOX_SELECTED)} ${d(r2, (l2) => styleText2("dim", l2))}${t2.hint ? ` ${styleText2("dim", `(${t2.hint})`)}` : ""}` : o2 === "cancelled" ? `${d(r2, (l2) => styleText2(["strikethrough", "dim"], l2))}` : o2 === "active-selected" ? `${styleText2("green", S_CHECKBOX_SELECTED)} ${r2}${t2.hint ? ` ${styleText2("dim", `(${t2.hint})`)}` : ""}` : o2 === "submitted" ? `${d(r2, (l2) => styleText2("dim", l2))}` : `${styleText2("dim", S_CHECKBOX_INACTIVE)} ${d(r2, (l2) => styleText2("dim", l2))}`;
  }, m = n2.required ?? true;
  return new a$1({
    options: n2.options,
    signal: n2.signal,
    input: n2.input,
    output: n2.output,
    initialValues: n2.initialValues,
    required: m,
    cursorAt: n2.cursorAt,
    validate(t2) {
      if (m && (t2 === void 0 || t2.length === 0))
        return `Please select at least one option.
${styleText2(
          "reset",
          styleText2(
            "dim",
            `Press ${styleText2(["gray", "bgWhite", "inverse"], " space ")} to select, ${styleText2(
              "gray",
              styleText2("bgWhite", styleText2("inverse", " enter "))
            )} to submit`
          )
        )}`;
    },
    render() {
      const t2 = n2.withGuide ?? settings.withGuide, o2 = wrapTextWithPrefix(
        n2.output,
        n2.message,
        t2 ? `${symbolBar(this.state)}  ` : "",
        `${symbol(this.state)}  `
      ), r2 = `${t2 ? `${styleText2("gray", S_BAR)}
` : ""}${o2}
`, l2 = this.value ?? [], g = (i2, u3) => {
        if (i2.disabled)
          return a3(i2, "disabled");
        const s = l2.includes(i2.value);
        return u3 && s ? a3(i2, "active-selected") : s ? a3(i2, "selected") : a3(i2, u3 ? "active" : "inactive");
      };
      switch (this.state) {
        case "submit": {
          const i2 = this.options.filter(({ value: s }) => l2.includes(s)).map((s) => a3(s, "submitted")).join(styleText2("dim", ", ")) || styleText2("dim", "none"), u3 = wrapTextWithPrefix(
            n2.output,
            i2,
            t2 ? `${styleText2("gray", S_BAR)}  ` : ""
          );
          return `${r2}${u3}`;
        }
        case "cancel": {
          const i2 = this.options.filter(({ value: s }) => l2.includes(s)).map((s) => a3(s, "cancelled")).join(styleText2("dim", ", "));
          if (i2.trim() === "")
            return `${r2}${styleText2("gray", S_BAR)}`;
          const u3 = wrapTextWithPrefix(
            n2.output,
            i2,
            t2 ? `${styleText2("gray", S_BAR)}  ` : ""
          );
          return `${r2}${u3}${t2 ? `
${styleText2("gray", S_BAR)}` : ""}`;
        }
        case "error": {
          const i2 = t2 ? `${styleText2("yellow", S_BAR)}  ` : "", u3 = this.error.split(`
`).map(
            (h2, x) => x === 0 ? `${t2 ? `${styleText2("yellow", S_BAR_END)}  ` : ""}${styleText2("yellow", h2)}` : `   ${h2}`
          ).join(`
`), s = r2.split(`
`).length, v = u3.split(`
`).length + 1;
          return `${r2}${i2}${limitOptions({
            output: n2.output,
            options: this.options,
            cursor: this.cursor,
            maxItems: n2.maxItems,
            columnPadding: i2.length,
            rowPadding: s + v,
            style: g
          }).join(`
${i2}`)}
${u3}
`;
        }
        default: {
          const i2 = t2 ? `${styleText2("cyan", S_BAR)}  ` : "", u3 = r2.split(`
`).length, s = t2 ? 2 : 1;
          return `${r2}${i2}${limitOptions({
            output: n2.output,
            options: this.options,
            cursor: this.cursor,
            maxItems: n2.maxItems,
            columnPadding: i2.length,
            rowPadding: u3 + s,
            style: g
          }).join(`
${i2}`)}
${t2 ? styleText2("cyan", S_BAR_END) : ""}
`;
        }
      }
    }
  }).prompt();
};
var W$1 = (o2) => styleText2("dim", o2);
var C = (o2, e, s) => {
  const a3 = {
    hard: true,
    trim: false
  }, i2 = wrapAnsi(o2, e, a3).split(`
`), c2 = i2.reduce((n2, r2) => Math.max(dist_default2(r2), n2), 0), u3 = i2.map(s).reduce((n2, r2) => Math.max(dist_default2(r2), n2), 0), g = e - (u3 - c2);
  return wrapAnsi(o2, g, a3);
};
var note = (o2 = "", e = "", s) => {
  const a3 = s?.output ?? process$1.stdout, i2 = s?.withGuide ?? settings.withGuide, c2 = s?.format ?? W$1, g = ["", ...C(o2, getColumns(a3) - 6, c2).split(`
`).map(c2), ""], n2 = dist_default2(e), r2 = Math.max(
    g.reduce((m, F) => {
      const O = dist_default2(F);
      return O > m ? O : m;
    }, 0),
    n2
  ) + 2, h2 = g.map(
    (m) => `${styleText2("gray", S_BAR)}  ${m}${" ".repeat(r2 - dist_default2(m))}${styleText2("gray", S_BAR)}`
  ).join(`
`), T = i2 ? `${styleText2("gray", S_BAR)}
` : "", l$1 = i2 ? S_CONNECT_LEFT : S_CORNER_BOTTOM_LEFT;
  a3.write(
    `${T}${styleText2("green", S_STEP_SUBMIT)}  ${styleText2("reset", e)} ${styleText2(
      "gray",
      S_BAR_H.repeat(Math.max(r2 - n2 - 1, 1)) + S_CORNER_TOP_RIGHT
    )}
${h2}
${styleText2("gray", l$1 + S_BAR_H.repeat(r2 + 2) + S_CORNER_BOTTOM_RIGHT)}
`
  );
};
var password = (r2) => new o({
  validate: r2.validate,
  mask: r2.mask ?? S_PASSWORD_MASK,
  signal: r2.signal,
  input: r2.input,
  output: r2.output,
  render() {
    const e = r2.withGuide ?? settings.withGuide, o2 = `${e ? `${styleText2("gray", S_BAR)}
` : ""}${symbol(this.state)}  ${r2.message}
`, c2 = this.userInputWithCursor, i2 = this.masked;
    switch (this.state) {
      case "error": {
        const s = e ? `${styleText2("yellow", S_BAR)}  ` : "", n2 = e ? `${styleText2("yellow", S_BAR_END)}  ` : "", l2 = i2 ?? "";
        return r2.clearOnError && this.clear(), `${o2.trim()}
${s}${l2}
${n2}${styleText2("yellow", this.error)}
`;
      }
      case "submit": {
        const s = e ? `${styleText2("gray", S_BAR)}  ` : "", n2 = i2 ? styleText2("dim", i2) : "";
        return `${o2}${s}${n2}`;
      }
      case "cancel": {
        const s = e ? `${styleText2("gray", S_BAR)}  ` : "", n2 = i2 ? styleText2(["strikethrough", "dim"], i2) : "";
        return `${o2}${s}${n2}${i2 && e ? `
${styleText2("gray", S_BAR)}` : ""}`;
      }
      default: {
        const s = e ? `${styleText2("cyan", S_BAR)}  ` : "", n2 = e ? styleText2("cyan", S_BAR_END) : "";
        return `${o2}${s}${c2}
${n2}
`;
      }
    }
  }
}).prompt();
var W = (l2) => styleText2("magenta", l2);
var spinner = ({
  indicator: l2 = "dots",
  onCancel: h2,
  output: n2 = process.stdout,
  cancelMessage: G,
  errorMessage: O,
  frames: E = unicode ? ["\u25D2", "\u25D0", "\u25D3", "\u25D1"] : ["\u2022", "o", "O", "0"],
  delay: F = unicode ? 80 : 120,
  signal: m,
  ...I
} = {}) => {
  const u3 = isCI();
  let M, T, d2 = false, S = false, s = "", p, w = performance.now();
  const x = getColumns(n2), k = I?.styleFrame ?? W, g = (e) => {
    const r2 = e > 1 ? O ?? settings.messages.error : G ?? settings.messages.cancel;
    S = e === 1, d2 && (a3(r2, e), S && typeof h2 == "function" && h2());
  }, f = () => g(2), i2 = () => g(1), A = () => {
    process.on("uncaughtExceptionMonitor", f), process.on("unhandledRejection", f), process.on("SIGINT", i2), process.on("SIGTERM", i2), process.on("exit", g), m && m.addEventListener("abort", i2);
  }, H = () => {
    process.removeListener("uncaughtExceptionMonitor", f), process.removeListener("unhandledRejection", f), process.removeListener("SIGINT", i2), process.removeListener("SIGTERM", i2), process.removeListener("exit", g), m && m.removeEventListener("abort", i2);
  }, y = () => {
    if (p === void 0) return;
    u3 && n2.write(`
`);
    const r2 = wrapAnsi(p, x, {
      hard: true,
      trim: false
    }).split(`
`);
    r2.length > 1 && n2.write(import_sisteransi2.cursor.up(r2.length - 1)), n2.write(import_sisteransi2.cursor.to(0)), n2.write(import_sisteransi2.erase.down());
  }, C2 = (e) => e.replace(/\.+$/, ""), _ = (e) => {
    const r2 = (performance.now() - e) / 1e3, t2 = Math.floor(r2 / 60), o2 = Math.floor(r2 % 60);
    return t2 > 0 ? `[${t2}m ${o2}s]` : `[${o2}s]`;
  }, N = I.withGuide ?? settings.withGuide, P = (e = "") => {
    d2 = true, M = block({ output: n2 }), s = C2(e), w = performance.now(), N && n2.write(`${styleText2("gray", S_BAR)}
`);
    let r2 = 0, t2 = 0;
    A(), T = setInterval(() => {
      if (u3 && s === p)
        return;
      y(), p = s;
      const o2 = k(E[r2]);
      let v;
      if (u3)
        v = `${o2}  ${s}...`;
      else if (l2 === "timer")
        v = `${o2}  ${s} ${_(w)}`;
      else {
        const B = ".".repeat(Math.floor(t2)).slice(0, 3);
        v = `${o2}  ${s}${B}`;
      }
      const j = wrapAnsi(v, x, {
        hard: true,
        trim: false
      });
      n2.write(j), r2 = r2 + 1 < E.length ? r2 + 1 : 0, t2 = t2 < 4 ? t2 + 0.125 : 0;
    }, F);
  }, a3 = (e = "", r2 = 0, t2 = false) => {
    if (!d2) return;
    d2 = false, clearInterval(T), y();
    const o2 = r2 === 0 ? styleText2("green", S_STEP_SUBMIT) : r2 === 1 ? styleText2("red", S_STEP_CANCEL) : styleText2("red", S_STEP_ERROR);
    s = e ?? s, t2 || (l2 === "timer" ? n2.write(`${o2}  ${s} ${_(w)}
`) : n2.write(`${o2}  ${s}
`)), H(), M();
  };
  return {
    start: P,
    stop: (e = "") => a3(e, 0),
    message: (e = "") => {
      s = C2(e ?? s);
    },
    cancel: (e = "") => a3(e, 1),
    error: (e = "") => a3(e, 2),
    clear: () => a3("", 0, true),
    get isCancelled() {
      return S;
    }
  };
};
var u2 = {
  light: unicodeOr("\u2500", "-"),
  heavy: unicodeOr("\u2501", "="),
  block: unicodeOr("\u2588", "#")
};
var c = (e, a3) => e.includes(`
`) ? e.split(`
`).map((t2) => a3(t2)).join(`
`) : a3(e);
var select = (e) => {
  const a3 = (t2, d2) => {
    const s = t2.label ?? String(t2.value);
    switch (d2) {
      case "disabled":
        return `${styleText2("gray", S_RADIO_INACTIVE)} ${c(s, (n2) => styleText2("gray", n2))}${t2.hint ? ` ${styleText2("dim", `(${t2.hint ?? "disabled"})`)}` : ""}`;
      case "selected":
        return `${c(s, (n2) => styleText2("dim", n2))}`;
      case "active":
        return `${styleText2("green", S_RADIO_ACTIVE)} ${s}${t2.hint ? ` ${styleText2("dim", `(${t2.hint})`)}` : ""}`;
      case "cancelled":
        return `${c(s, (n2) => styleText2(["strikethrough", "dim"], n2))}`;
      default:
        return `${styleText2("dim", S_RADIO_INACTIVE)} ${c(s, (n2) => styleText2("dim", n2))}`;
    }
  };
  return new a2({
    options: e.options,
    signal: e.signal,
    input: e.input,
    output: e.output,
    initialValue: e.initialValue,
    render() {
      const t2 = e.withGuide ?? settings.withGuide, d2 = `${symbol(this.state)}  `, s = `${symbolBar(this.state)}  `, n2 = wrapTextWithPrefix(
        e.output,
        e.message,
        s,
        d2
      ), u3 = `${t2 ? `${styleText2("gray", S_BAR)}
` : ""}${n2}
`;
      switch (this.state) {
        case "submit": {
          const r2 = t2 ? `${styleText2("gray", S_BAR)}  ` : "", l2 = wrapTextWithPrefix(
            e.output,
            a3(this.options[this.cursor], "selected"),
            r2
          );
          return `${u3}${l2}`;
        }
        case "cancel": {
          const r2 = t2 ? `${styleText2("gray", S_BAR)}  ` : "", l2 = wrapTextWithPrefix(
            e.output,
            a3(this.options[this.cursor], "cancelled"),
            r2
          );
          return `${u3}${l2}${t2 ? `
${styleText2("gray", S_BAR)}` : ""}`;
        }
        default: {
          const r2 = t2 ? `${styleText2("cyan", S_BAR)}  ` : "", l2 = t2 ? styleText2("cyan", S_BAR_END) : "", g = u3.split(`
`).length, h2 = t2 ? 2 : 1;
          return `${u3}${r2}${limitOptions({
            output: e.output,
            cursor: this.cursor,
            options: this.options,
            maxItems: e.maxItems,
            columnPadding: r2.length,
            rowPadding: g + h2,
            style: (p, b) => a3(p, p.disabled ? "disabled" : b ? "active" : "inactive")
          }).join(`
${r2}`)}
${l2}
`;
        }
      }
    }
  }).prompt();
};
var i = `${styleText2("gray", S_BAR)}  `;
var tasks = async (o2, e) => {
  for (const t2 of o2) {
    if (t2.enabled === false) continue;
    const s = spinner(e);
    s.start(t2.title);
    const n2 = await t2.task(s.message);
    s.stop(n2 || t2.title);
  }
};
var text = (t2) => new n({
  validate: t2.validate,
  placeholder: t2.placeholder,
  defaultValue: t2.defaultValue,
  initialValue: t2.initialValue,
  output: t2.output,
  signal: t2.signal,
  input: t2.input,
  render() {
    const i2 = t2?.withGuide ?? settings.withGuide, s = `${`${i2 ? `${styleText2("gray", S_BAR)}
` : ""}${symbol(this.state)}  `}${t2.message}
`, c2 = t2.placeholder ? styleText2("inverse", t2.placeholder[0]) + styleText2("dim", t2.placeholder.slice(1)) : styleText2(["inverse", "hidden"], "_"), o2 = this.userInput ? this.userInputWithCursor : c2, a3 = this.value ?? "";
    switch (this.state) {
      case "error": {
        const n2 = this.error ? `  ${styleText2("yellow", this.error)}` : "", r2 = i2 ? `${styleText2("yellow", S_BAR)}  ` : "", d2 = i2 ? styleText2("yellow", S_BAR_END) : "";
        return `${s.trim()}
${r2}${o2}
${d2}${n2}
`;
      }
      case "submit": {
        const n2 = a3 ? `  ${styleText2("dim", a3)}` : "", r2 = i2 ? styleText2("gray", S_BAR) : "";
        return `${s}${r2}${n2}`;
      }
      case "cancel": {
        const n2 = a3 ? `  ${styleText2(["strikethrough", "dim"], a3)}` : "", r2 = i2 ? styleText2("gray", S_BAR) : "";
        return `${s}${r2}${n2}${a3.trim() ? `
${r2}` : ""}`;
      }
      default: {
        const n2 = i2 ? `${styleText2("cyan", S_BAR)}  ` : "", r2 = i2 ? styleText2("cyan", S_BAR_END) : "";
        return `${s}${n2}${o2}
${r2}
`;
      }
    }
  }
}).prompt();

// src/steps/welcome.ts
var import_picocolors = __toESM(require_picocolors(), 1);
import { existsSync } from "fs";

// src/utils/system.ts
import { execSync } from "child_process";
import { homedir } from "os";
import { join } from "path";
function detectOS() {
  switch (process.platform) {
    case "darwin":
      return "macos";
    case "win32":
      return "windows";
    default:
      return "linux";
  }
}
function commandExists(command) {
  try {
    execSync(`which ${command}`, { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}
function runCommand(command, args = []) {
  try {
    const fullCommand = [command, ...args].join(" ");
    const stdout2 = execSync(fullCommand, { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] });
    return { stdout: stdout2.trim(), stderr: "", exitCode: 0 };
  } catch (error) {
    return {
      stdout: error.stdout?.toString().trim() ?? "",
      stderr: error.stderr?.toString().trim() ?? "",
      exitCode: error.status ?? 1
    };
  }
}
function expandHome(filepath) {
  if (filepath.startsWith("~")) {
    return join(homedir(), filepath.slice(1));
  }
  return filepath;
}

// src/steps/welcome.ts
async function runWelcome() {
  intro(import_picocolors.default.bgCyan(import_picocolors.default.black(" claude-mem installer ")));
  log.info(`Version: 1.0.0`);
  log.info(`Platform: ${process.platform} (${process.arch})`);
  const settingsExist = existsSync(expandHome("~/.claude-mem/settings.json"));
  const pluginExist = existsSync(expandHome("~/.claude/plugins/marketplaces/thedotmack/"));
  const alreadyInstalled = settingsExist && pluginExist;
  if (alreadyInstalled) {
    log.warn("Existing claude-mem installation detected.");
  }
  const installMode = await select({
    message: "What would you like to do?",
    options: alreadyInstalled ? [
      { value: "upgrade", label: "Upgrade", hint: "update to latest version" },
      { value: "configure", label: "Configure", hint: "change settings only" },
      { value: "fresh", label: "Fresh Install", hint: "reinstall from scratch" },
      { value: "uninstall", label: "Uninstall", hint: "remove claude-mem" }
    ] : [
      { value: "fresh", label: "Fresh Install", hint: "recommended" },
      { value: "configure", label: "Configure Only", hint: "set up settings without installing" }
    ]
  });
  if (isCancel(installMode)) {
    cancel("Installation cancelled.");
    process.exit(0);
  }
  return installMode;
}

// src/steps/dependencies.ts
var import_picocolors2 = __toESM(require_picocolors(), 1);

// src/utils/dependencies.ts
import { existsSync as existsSync2 } from "fs";
import { execSync as execSync2 } from "child_process";
function findBinary(name, extraPaths = []) {
  if (commandExists(name)) {
    const result = runCommand("which", [name]);
    const versionResult = runCommand(name, ["--version"]);
    return {
      found: true,
      path: result.stdout,
      version: parseVersion(versionResult.stdout) || parseVersion(versionResult.stderr)
    };
  }
  for (const extraPath of extraPaths) {
    const fullPath = expandHome(extraPath);
    if (existsSync2(fullPath)) {
      const versionResult = runCommand(fullPath, ["--version"]);
      return {
        found: true,
        path: fullPath,
        version: parseVersion(versionResult.stdout) || parseVersion(versionResult.stderr)
      };
    }
  }
  return { found: false, path: null, version: null };
}
function parseVersion(output) {
  if (!output) return null;
  const match = output.match(/(\d+\.\d+(\.\d+)?)/);
  return match ? match[1] : null;
}
function compareVersions(current, minimum) {
  const currentParts = current.split(".").map(Number);
  const minimumParts = minimum.split(".").map(Number);
  for (let i2 = 0; i2 < Math.max(currentParts.length, minimumParts.length); i2++) {
    const a3 = currentParts[i2] || 0;
    const b = minimumParts[i2] || 0;
    if (a3 > b) return true;
    if (a3 < b) return false;
  }
  return true;
}
function installBun() {
  const os = detectOS();
  if (os === "windows") {
    execSync2('powershell -c "irm bun.sh/install.ps1 | iex"', { stdio: "inherit" });
  } else {
    execSync2("curl -fsSL https://bun.sh/install | bash", { stdio: "inherit" });
  }
}
function installUv() {
  const os = detectOS();
  if (os === "windows") {
    execSync2('powershell -c "irm https://astral.sh/uv/install.ps1 | iex"', { stdio: "inherit" });
  } else {
    execSync2("curl -fsSL https://astral.sh/uv/install.sh | sh", { stdio: "inherit" });
  }
}

// src/steps/dependencies.ts
var BUN_EXTRA_PATHS = ["~/.bun/bin/bun", "/usr/local/bin/bun", "/opt/homebrew/bin/bun"];
var UV_EXTRA_PATHS = ["~/.local/bin/uv", "~/.cargo/bin/uv"];
async function runDependencyChecks() {
  const status = {
    nodeOk: false,
    gitOk: false,
    bunOk: false,
    uvOk: false,
    bunPath: null,
    uvPath: null
  };
  await tasks([
    {
      title: "Checking Node.js",
      task: async () => {
        const version = process.version.slice(1);
        if (compareVersions(version, "18.0.0")) {
          status.nodeOk = true;
          return `Node.js ${process.version} ${import_picocolors2.default.green("\u2713")}`;
        }
        return `Node.js ${process.version} \u2014 requires >= 18.0.0 ${import_picocolors2.default.red("\u2717")}`;
      }
    },
    {
      title: "Checking git",
      task: async () => {
        const info = findBinary("git");
        if (info.found) {
          status.gitOk = true;
          return `git ${info.version ?? ""} ${import_picocolors2.default.green("\u2713")}`;
        }
        return `git not found ${import_picocolors2.default.red("\u2717")}`;
      }
    },
    {
      title: "Checking Bun",
      task: async () => {
        const info = findBinary("bun", BUN_EXTRA_PATHS);
        if (info.found && info.version && compareVersions(info.version, "1.1.14")) {
          status.bunOk = true;
          status.bunPath = info.path;
          return `Bun ${info.version} ${import_picocolors2.default.green("\u2713")}`;
        }
        if (info.found && info.version) {
          return `Bun ${info.version} \u2014 requires >= 1.1.14 ${import_picocolors2.default.yellow("\u26A0")}`;
        }
        return `Bun not found ${import_picocolors2.default.yellow("\u26A0")}`;
      }
    },
    {
      title: "Checking uv",
      task: async () => {
        const info = findBinary("uv", UV_EXTRA_PATHS);
        if (info.found) {
          status.uvOk = true;
          status.uvPath = info.path;
          return `uv ${info.version ?? ""} ${import_picocolors2.default.green("\u2713")}`;
        }
        return `uv not found ${import_picocolors2.default.yellow("\u26A0")}`;
      }
    }
  ]);
  if (!status.gitOk) {
    const os = detectOS();
    log.error("git is required but not found.");
    if (os === "macos") {
      log.info("Install with: xcode-select --install");
    } else if (os === "linux") {
      log.info("Install with: sudo apt install git (or your distro equivalent)");
    } else {
      log.info("Download from: https://git-scm.com/downloads");
    }
    cancel("Please install git and try again.");
    process.exit(1);
  }
  if (!status.nodeOk) {
    log.error(`Node.js >= 18.0.0 is required. Current: ${process.version}`);
    cancel("Please upgrade Node.js and try again.");
    process.exit(1);
  }
  if (!status.bunOk) {
    const shouldInstall = await confirm({
      message: "Bun is required but not found. Install it now?",
      initialValue: true
    });
    if (isCancel(shouldInstall)) {
      cancel("Installation cancelled.");
      process.exit(0);
    }
    if (shouldInstall) {
      const s = spinner();
      s.start("Installing Bun...");
      try {
        installBun();
        const recheck = findBinary("bun", BUN_EXTRA_PATHS);
        if (recheck.found) {
          status.bunOk = true;
          status.bunPath = recheck.path;
          s.stop(`Bun installed ${import_picocolors2.default.green("\u2713")}`);
        } else {
          s.stop(`Bun installed but not found in PATH. You may need to restart your shell.`);
        }
      } catch {
        s.stop(`Bun installation failed. Install manually: curl -fsSL https://bun.sh/install | bash`);
      }
    } else {
      log.warn("Bun is required for claude-mem. Install manually: curl -fsSL https://bun.sh/install | bash");
      cancel("Cannot continue without Bun.");
      process.exit(1);
    }
  }
  if (!status.uvOk) {
    const shouldInstall = await confirm({
      message: "uv (Python package manager) is recommended for Chroma. Install it now?",
      initialValue: true
    });
    if (isCancel(shouldInstall)) {
      cancel("Installation cancelled.");
      process.exit(0);
    }
    if (shouldInstall) {
      const s = spinner();
      s.start("Installing uv...");
      try {
        installUv();
        const recheck = findBinary("uv", UV_EXTRA_PATHS);
        if (recheck.found) {
          status.uvOk = true;
          status.uvPath = recheck.path;
          s.stop(`uv installed ${import_picocolors2.default.green("\u2713")}`);
        } else {
          s.stop("uv installed but not found in PATH. You may need to restart your shell.");
        }
      } catch {
        s.stop("uv installation failed. Install manually: curl -fsSL https://astral.sh/uv/install.sh | sh");
      }
    } else {
      log.warn("Skipping uv \u2014 Chroma vector search will not be available.");
    }
  }
  return status;
}

// src/steps/ide-selection.ts
async function runIdeSelection() {
  const result = await multiselect({
    message: "Which IDEs do you use?",
    options: [
      { value: "claude-code", label: "Claude Code", hint: "recommended" },
      { value: "cursor", label: "Cursor" }
      // Windsurf coming soon - not yet selectable
    ],
    initialValues: ["claude-code"],
    required: true
  });
  if (isCancel(result)) {
    cancel("Installation cancelled.");
    process.exit(0);
  }
  const selectedIDEs = result;
  if (selectedIDEs.includes("claude-code")) {
    log.info("Claude Code: Plugin will be registered via marketplace.");
  }
  if (selectedIDEs.includes("cursor")) {
    log.info("Cursor: Hooks will be configured for your projects.");
  }
  return selectedIDEs;
}

// src/steps/provider.ts
async function runProviderConfiguration() {
  const provider = await select({
    message: "Which AI provider should claude-mem use for memory compression?",
    options: [
      { value: "claude", label: "Claude", hint: "uses your Claude subscription" },
      { value: "gemini", label: "Gemini", hint: "free tier available" },
      { value: "openrouter", label: "OpenRouter", hint: "free models available" }
    ]
  });
  if (isCancel(provider)) {
    cancel("Installation cancelled.");
    process.exit(0);
  }
  const config = { provider };
  if (provider === "claude") {
    const authMethod = await select({
      message: "How should Claude authenticate?",
      options: [
        { value: "cli", label: "CLI (Max Plan subscription)", hint: "no API key needed" },
        { value: "api", label: "API Key", hint: "uses Anthropic API credits" }
      ]
    });
    if (isCancel(authMethod)) {
      cancel("Installation cancelled.");
      process.exit(0);
    }
    config.claudeAuthMethod = authMethod;
    if (authMethod === "api") {
      const apiKey = await password({
        message: "Enter your Anthropic API key:",
        validate: (value) => {
          if (!value || value.trim().length === 0) return "API key is required";
          if (!value.startsWith("sk-ant-")) return "Anthropic API keys start with sk-ant-";
        }
      });
      if (isCancel(apiKey)) {
        cancel("Installation cancelled.");
        process.exit(0);
      }
      config.apiKey = apiKey;
    }
  }
  if (provider === "gemini") {
    const apiKey = await password({
      message: "Enter your Gemini API key:",
      validate: (value) => {
        if (!value || value.trim().length === 0) return "API key is required";
      }
    });
    if (isCancel(apiKey)) {
      cancel("Installation cancelled.");
      process.exit(0);
    }
    config.apiKey = apiKey;
    const model = await select({
      message: "Which Gemini model?",
      options: [
        { value: "gemini-2.5-flash-lite", label: "Gemini 2.5 Flash Lite", hint: "fastest, highest free RPM" },
        { value: "gemini-2.5-flash", label: "Gemini 2.5 Flash", hint: "balanced" },
        { value: "gemini-3-flash-preview", label: "Gemini 3 Flash Preview", hint: "latest" }
      ]
    });
    if (isCancel(model)) {
      cancel("Installation cancelled.");
      process.exit(0);
    }
    config.model = model;
    const rateLimiting = await confirm({
      message: "Enable rate limiting? (recommended for free tier)",
      initialValue: true
    });
    if (isCancel(rateLimiting)) {
      cancel("Installation cancelled.");
      process.exit(0);
    }
    config.rateLimitingEnabled = rateLimiting;
  }
  if (provider === "openrouter") {
    const apiKey = await password({
      message: "Enter your OpenRouter API key:",
      validate: (value) => {
        if (!value || value.trim().length === 0) return "API key is required";
      }
    });
    if (isCancel(apiKey)) {
      cancel("Installation cancelled.");
      process.exit(0);
    }
    config.apiKey = apiKey;
    const model = await text({
      message: "Which OpenRouter model?",
      defaultValue: "xiaomi/mimo-v2-flash:free",
      placeholder: "xiaomi/mimo-v2-flash:free"
    });
    if (isCancel(model)) {
      cancel("Installation cancelled.");
      process.exit(0);
    }
    config.model = model;
  }
  return config;
}

// src/steps/settings.ts
var import_picocolors3 = __toESM(require_picocolors(), 1);
async function runSettingsConfiguration() {
  const useDefaults = await confirm({
    message: "Use default settings? (recommended for most users)",
    initialValue: true
  });
  if (isCancel(useDefaults)) {
    cancel("Installation cancelled.");
    process.exit(0);
  }
  if (useDefaults) {
    return {
      workerPort: "37777",
      dataDir: "~/.claude-mem",
      contextObservations: "50",
      logLevel: "INFO",
      pythonVersion: "3.13",
      chromaEnabled: true,
      chromaMode: "local"
    };
  }
  const workerPort = await text({
    message: "Worker service port:",
    defaultValue: "37777",
    placeholder: "37777",
    validate: (value = "") => {
      const port = parseInt(value, 10);
      if (isNaN(port) || port < 1024 || port > 65535) {
        return "Port must be between 1024 and 65535";
      }
    }
  });
  if (isCancel(workerPort)) {
    cancel("Installation cancelled.");
    process.exit(0);
  }
  const dataDir = await text({
    message: "Data directory:",
    defaultValue: "~/.claude-mem",
    placeholder: "~/.claude-mem"
  });
  if (isCancel(dataDir)) {
    cancel("Installation cancelled.");
    process.exit(0);
  }
  const contextObservations = await text({
    message: "Number of context observations per session:",
    defaultValue: "50",
    placeholder: "50",
    validate: (value = "") => {
      const num = parseInt(value, 10);
      if (isNaN(num) || num < 1 || num > 200) {
        return "Must be between 1 and 200";
      }
    }
  });
  if (isCancel(contextObservations)) {
    cancel("Installation cancelled.");
    process.exit(0);
  }
  const logLevel = await select({
    message: "Log level:",
    options: [
      { value: "DEBUG", label: "DEBUG", hint: "verbose" },
      { value: "INFO", label: "INFO", hint: "default" },
      { value: "WARN", label: "WARN" },
      { value: "ERROR", label: "ERROR", hint: "errors only" }
    ],
    initialValue: "INFO"
  });
  if (isCancel(logLevel)) {
    cancel("Installation cancelled.");
    process.exit(0);
  }
  const pythonVersion = await text({
    message: "Python version (for Chroma):",
    defaultValue: "3.13",
    placeholder: "3.13"
  });
  if (isCancel(pythonVersion)) {
    cancel("Installation cancelled.");
    process.exit(0);
  }
  const chromaEnabled = await confirm({
    message: "Enable Chroma vector search?",
    initialValue: true
  });
  if (isCancel(chromaEnabled)) {
    cancel("Installation cancelled.");
    process.exit(0);
  }
  let chromaMode;
  let chromaHost;
  let chromaPort;
  let chromaSsl;
  if (chromaEnabled) {
    const mode = await select({
      message: "Chroma mode:",
      options: [
        { value: "local", label: "Local", hint: "starts local Chroma server" },
        { value: "remote", label: "Remote", hint: "connect to existing server" }
      ]
    });
    if (isCancel(mode)) {
      cancel("Installation cancelled.");
      process.exit(0);
    }
    chromaMode = mode;
    if (mode === "remote") {
      const host = await text({
        message: "Chroma host:",
        defaultValue: "127.0.0.1",
        placeholder: "127.0.0.1"
      });
      if (isCancel(host)) {
        cancel("Installation cancelled.");
        process.exit(0);
      }
      chromaHost = host;
      const port = await text({
        message: "Chroma port:",
        defaultValue: "8000",
        placeholder: "8000",
        validate: (value = "") => {
          const portNum = parseInt(value, 10);
          if (isNaN(portNum) || portNum < 1 || portNum > 65535) return "Port must be between 1 and 65535";
        }
      });
      if (isCancel(port)) {
        cancel("Installation cancelled.");
        process.exit(0);
      }
      chromaPort = port;
      const ssl = await confirm({
        message: "Use SSL for Chroma connection?",
        initialValue: false
      });
      if (isCancel(ssl)) {
        cancel("Installation cancelled.");
        process.exit(0);
      }
      chromaSsl = ssl;
    }
  }
  const config = {
    workerPort,
    dataDir,
    contextObservations,
    logLevel,
    pythonVersion,
    chromaEnabled,
    chromaMode,
    chromaHost,
    chromaPort,
    chromaSsl
  };
  const summaryLines = [
    `Worker port: ${import_picocolors3.default.cyan(workerPort)}`,
    `Data directory: ${import_picocolors3.default.cyan(dataDir)}`,
    `Context observations: ${import_picocolors3.default.cyan(contextObservations)}`,
    `Log level: ${import_picocolors3.default.cyan(logLevel)}`,
    `Python version: ${import_picocolors3.default.cyan(pythonVersion)}`,
    `Chroma: ${chromaEnabled ? import_picocolors3.default.green("enabled") : import_picocolors3.default.dim("disabled")}`
  ];
  if (chromaEnabled && chromaMode) {
    summaryLines.push(`Chroma mode: ${import_picocolors3.default.cyan(chromaMode)}`);
  }
  note(summaryLines.join("\n"), "Settings Summary");
  return config;
}

// src/utils/settings-writer.ts
import { existsSync as existsSync3, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join as join2 } from "path";
import { homedir as homedir2 } from "os";
function expandDataDir(dataDir) {
  if (dataDir.startsWith("~")) {
    return join2(homedir2(), dataDir.slice(1));
  }
  return dataDir;
}
function buildSettingsObject(providerConfig, settingsConfig) {
  const settings2 = {
    CLAUDE_MEM_WORKER_PORT: settingsConfig.workerPort,
    CLAUDE_MEM_WORKER_HOST: "127.0.0.1",
    CLAUDE_MEM_DATA_DIR: expandDataDir(settingsConfig.dataDir),
    CLAUDE_MEM_CONTEXT_OBSERVATIONS: settingsConfig.contextObservations,
    CLAUDE_MEM_LOG_LEVEL: settingsConfig.logLevel,
    CLAUDE_MEM_PYTHON_VERSION: settingsConfig.pythonVersion,
    CLAUDE_MEM_PROVIDER: providerConfig.provider
  };
  if (providerConfig.provider === "claude") {
    settings2.CLAUDE_MEM_CLAUDE_AUTH_METHOD = providerConfig.claudeAuthMethod ?? "cli";
  }
  if (providerConfig.provider === "gemini") {
    if (providerConfig.apiKey) settings2.CLAUDE_MEM_GEMINI_API_KEY = providerConfig.apiKey;
    if (providerConfig.model) settings2.CLAUDE_MEM_GEMINI_MODEL = providerConfig.model;
    settings2.CLAUDE_MEM_GEMINI_RATE_LIMITING_ENABLED = providerConfig.rateLimitingEnabled !== false ? "true" : "false";
  }
  if (providerConfig.provider === "openrouter") {
    if (providerConfig.apiKey) settings2.CLAUDE_MEM_OPENROUTER_API_KEY = providerConfig.apiKey;
    if (providerConfig.model) settings2.CLAUDE_MEM_OPENROUTER_MODEL = providerConfig.model;
  }
  if (settingsConfig.chromaEnabled) {
    settings2.CLAUDE_MEM_CHROMA_MODE = settingsConfig.chromaMode ?? "local";
    if (settingsConfig.chromaMode === "remote") {
      if (settingsConfig.chromaHost) settings2.CLAUDE_MEM_CHROMA_HOST = settingsConfig.chromaHost;
      if (settingsConfig.chromaPort) settings2.CLAUDE_MEM_CHROMA_PORT = settingsConfig.chromaPort;
      if (settingsConfig.chromaSsl !== void 0) settings2.CLAUDE_MEM_CHROMA_SSL = String(settingsConfig.chromaSsl);
    }
  }
  return settings2;
}
function writeSettings(providerConfig, settingsConfig) {
  const dataDir = expandDataDir(settingsConfig.dataDir);
  const settingsPath = join2(dataDir, "settings.json");
  if (!existsSync3(dataDir)) {
    mkdirSync(dataDir, { recursive: true });
  }
  let existingSettings = {};
  if (existsSync3(settingsPath)) {
    const raw = readFileSync(settingsPath, "utf-8");
    existingSettings = JSON.parse(raw);
  }
  const newSettings = buildSettingsObject(providerConfig, settingsConfig);
  const merged = { ...existingSettings, ...newSettings };
  writeFileSync(settingsPath, JSON.stringify(merged, null, 2) + "\n", "utf-8");
}

// src/steps/install.ts
var import_picocolors4 = __toESM(require_picocolors(), 1);
import { execSync as execSync3 } from "child_process";
import { existsSync as existsSync4, mkdirSync as mkdirSync2, readFileSync as readFileSync2, writeFileSync as writeFileSync2, cpSync } from "fs";
import { join as join3 } from "path";
import { homedir as homedir3, tmpdir } from "os";
var MARKETPLACE_DIR = join3(homedir3(), ".claude", "plugins", "marketplaces", "thedotmack");
var PLUGINS_DIR = join3(homedir3(), ".claude", "plugins");
var CLAUDE_SETTINGS_PATH = join3(homedir3(), ".claude", "settings.json");
function ensureDir(directoryPath) {
  if (!existsSync4(directoryPath)) {
    mkdirSync2(directoryPath, { recursive: true });
  }
}
function readJsonFile(filepath) {
  if (!existsSync4(filepath)) return {};
  return JSON.parse(readFileSync2(filepath, "utf-8"));
}
function writeJsonFile(filepath, data) {
  ensureDir(join3(filepath, ".."));
  writeFileSync2(filepath, JSON.stringify(data, null, 2) + "\n", "utf-8");
}
function registerMarketplace() {
  const knownMarketplacesPath = join3(PLUGINS_DIR, "known_marketplaces.json");
  const knownMarketplaces = readJsonFile(knownMarketplacesPath);
  knownMarketplaces["thedotmack"] = {
    source: {
      source: "github",
      repo: "thedotmack/claude-mem"
    },
    installLocation: MARKETPLACE_DIR,
    lastUpdated: (/* @__PURE__ */ new Date()).toISOString(),
    autoUpdate: true
  };
  ensureDir(PLUGINS_DIR);
  writeJsonFile(knownMarketplacesPath, knownMarketplaces);
}
function registerPlugin(version) {
  const installedPluginsPath = join3(PLUGINS_DIR, "installed_plugins.json");
  const installedPlugins = readJsonFile(installedPluginsPath);
  if (!installedPlugins.version) installedPlugins.version = 2;
  if (!installedPlugins.plugins) installedPlugins.plugins = {};
  const pluginCachePath = join3(PLUGINS_DIR, "cache", "thedotmack", "claude-mem", version);
  const now = (/* @__PURE__ */ new Date()).toISOString();
  installedPlugins.plugins["claude-mem@thedotmack"] = [
    {
      scope: "user",
      installPath: pluginCachePath,
      version,
      installedAt: now,
      lastUpdated: now
    }
  ];
  writeJsonFile(installedPluginsPath, installedPlugins);
  ensureDir(pluginCachePath);
  const pluginSourceDir = join3(MARKETPLACE_DIR, "plugin");
  if (existsSync4(pluginSourceDir)) {
    cpSync(pluginSourceDir, pluginCachePath, { recursive: true });
  }
}
function enablePluginInClaudeSettings() {
  const settings2 = readJsonFile(CLAUDE_SETTINGS_PATH);
  if (!settings2.enabledPlugins) settings2.enabledPlugins = {};
  settings2.enabledPlugins["claude-mem@thedotmack"] = true;
  writeJsonFile(CLAUDE_SETTINGS_PATH, settings2);
}
function getPluginVersion() {
  const pluginJsonPath = join3(MARKETPLACE_DIR, "plugin", ".claude-plugin", "plugin.json");
  if (existsSync4(pluginJsonPath)) {
    const pluginJson = JSON.parse(readFileSync2(pluginJsonPath, "utf-8"));
    return pluginJson.version ?? "1.0.0";
  }
  return "1.0.0";
}
async function runInstallation(selectedIDEs) {
  const tempDir = join3(tmpdir(), `claude-mem-install-${Date.now()}`);
  await tasks([
    {
      title: "Cloning claude-mem repository",
      task: async (message) => {
        message("Downloading latest release...");
        execSync3(
          `git clone --depth 1 https://github.com/thedotmack/claude-mem.git "${tempDir}"`,
          { stdio: "pipe" }
        );
        return `Repository cloned ${import_picocolors4.default.green("OK")}`;
      }
    },
    {
      title: "Installing dependencies",
      task: async (message) => {
        message("Running npm install...");
        execSync3("npm install", { cwd: tempDir, stdio: "pipe" });
        return `Dependencies installed ${import_picocolors4.default.green("OK")}`;
      }
    },
    {
      title: "Building plugin",
      task: async (message) => {
        message("Compiling TypeScript and bundling...");
        execSync3("npm run build", { cwd: tempDir, stdio: "pipe" });
        return `Plugin built ${import_picocolors4.default.green("OK")}`;
      }
    },
    {
      title: "Registering plugin",
      task: async (message) => {
        message("Copying files to marketplace directory...");
        ensureDir(MARKETPLACE_DIR);
        execSync3(
          `rsync -a --delete --exclude=.git --exclude=package-lock.json --exclude=bun.lock "${tempDir}/" "${MARKETPLACE_DIR}/"`,
          { stdio: "pipe" }
        );
        message("Registering marketplace...");
        registerMarketplace();
        message("Installing marketplace dependencies...");
        execSync3("npm install", { cwd: MARKETPLACE_DIR, stdio: "pipe" });
        message("Registering plugin in Claude Code...");
        const version = getPluginVersion();
        registerPlugin(version);
        message("Enabling plugin...");
        enablePluginInClaudeSettings();
        return `Plugin registered (v${getPluginVersion()}) ${import_picocolors4.default.green("OK")}`;
      }
    }
  ]);
  try {
    execSync3(`rm -rf "${tempDir}"`, { stdio: "pipe" });
  } catch {
  }
  if (selectedIDEs.includes("cursor")) {
    log.info("Cursor hook configuration will be available after first launch.");
    log.info("Run: claude-mem cursor-setup (coming soon)");
  }
}

// src/steps/worker.ts
var import_picocolors5 = __toESM(require_picocolors(), 1);
import { spawn } from "child_process";
import { join as join4 } from "path";
import { homedir as homedir4 } from "os";
var MARKETPLACE_DIR2 = join4(homedir4(), ".claude", "plugins", "marketplaces", "thedotmack");
var HEALTH_CHECK_INTERVAL_MS = 1e3;
var HEALTH_CHECK_MAX_ATTEMPTS = 30;
async function pollHealthEndpoint(port, maxAttempts = HEALTH_CHECK_MAX_ATTEMPTS) {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (response.ok) return true;
    } catch {
    }
    await new Promise((resolve) => setTimeout(resolve, HEALTH_CHECK_INTERVAL_MS));
  }
  return false;
}
async function runWorkerStartup(workerPort, dataDir) {
  const bunInfo = findBinary("bun", ["~/.bun/bin/bun", "/usr/local/bin/bun", "/opt/homebrew/bin/bun"]);
  if (!bunInfo.found || !bunInfo.path) {
    log.error("Bun is required to start the worker but was not found.");
    log.info("Install Bun: curl -fsSL https://bun.sh/install | bash");
    return;
  }
  const workerScript = join4(MARKETPLACE_DIR2, "plugin", "scripts", "worker-service.cjs");
  const expandedDataDir = expandHome(dataDir);
  const logPath = join4(expandedDataDir, "logs");
  const s = spinner();
  s.start("Starting worker service...");
  const child = spawn(bunInfo.path, [workerScript], {
    cwd: MARKETPLACE_DIR2,
    detached: true,
    stdio: "ignore",
    env: {
      ...process.env,
      CLAUDE_MEM_WORKER_PORT: workerPort,
      CLAUDE_MEM_DATA_DIR: expandedDataDir
    }
  });
  child.unref();
  const workerIsHealthy = await pollHealthEndpoint(workerPort);
  if (workerIsHealthy) {
    s.stop(`Worker running on port ${import_picocolors5.default.cyan(workerPort)} ${import_picocolors5.default.green("OK")}`);
  } else {
    s.stop(`Worker may still be starting. Check logs at: ${logPath}`);
    log.warn("Health check timed out. The worker might need more time to initialize.");
    log.info(`Check status: curl http://127.0.0.1:${workerPort}/api/health`);
  }
}

// src/steps/complete.ts
var import_picocolors6 = __toESM(require_picocolors(), 1);
function getProviderLabel(config) {
  switch (config.provider) {
    case "claude":
      return config.claudeAuthMethod === "api" ? "Claude (API Key)" : "Claude (CLI subscription)";
    case "gemini":
      return `Gemini (${config.model ?? "gemini-2.5-flash-lite"})`;
    case "openrouter":
      return `OpenRouter (${config.model ?? "xiaomi/mimo-v2-flash:free"})`;
  }
}
function getIDELabels(ides) {
  return ides.map((ide) => {
    switch (ide) {
      case "claude-code":
        return "Claude Code";
      case "cursor":
        return "Cursor";
    }
  }).join(", ");
}
function runCompletion(providerConfig, settingsConfig, selectedIDEs) {
  const summaryLines = [
    `Provider:   ${import_picocolors6.default.cyan(getProviderLabel(providerConfig))}`,
    `IDEs:       ${import_picocolors6.default.cyan(getIDELabels(selectedIDEs))}`,
    `Data dir:   ${import_picocolors6.default.cyan(settingsConfig.dataDir)}`,
    `Port:       ${import_picocolors6.default.cyan(settingsConfig.workerPort)}`,
    `Chroma:     ${settingsConfig.chromaEnabled ? import_picocolors6.default.green("enabled") : import_picocolors6.default.dim("disabled")}`
  ];
  note(summaryLines.join("\n"), "Configuration Summary");
  const nextStepsLines = [];
  if (selectedIDEs.includes("claude-code")) {
    nextStepsLines.push("Open Claude Code and start a conversation \u2014 memory is automatic!");
  }
  if (selectedIDEs.includes("cursor")) {
    nextStepsLines.push("Open Cursor \u2014 hooks are active in your projects.");
  }
  nextStepsLines.push(`View your memories: ${import_picocolors6.default.underline(`http://localhost:${settingsConfig.workerPort}`)}`);
  nextStepsLines.push(`Search past work: use ${import_picocolors6.default.bold("/mem-search")} in Claude Code`);
  note(nextStepsLines.join("\n"), "Next Steps");
  outro(import_picocolors6.default.green("claude-mem installed successfully!"));
}

// src/steps/uninstall.ts
var import_picocolors7 = __toESM(require_picocolors(), 1);
import { execSync as execSync4 } from "child_process";
import { existsSync as existsSync5, readFileSync as readFileSync3, writeFileSync as writeFileSync3, rmSync } from "fs";
import { join as join5 } from "path";
import { homedir as homedir5 } from "os";
var MARKETPLACE_DIR3 = join5(homedir5(), ".claude", "plugins", "marketplaces", "thedotmack");
var PLUGINS_DIR2 = join5(homedir5(), ".claude", "plugins");
var PLUGIN_CACHE_DIR = join5(PLUGINS_DIR2, "cache", "thedotmack");
var CLAUDE_SETTINGS_PATH2 = join5(homedir5(), ".claude", "settings.json");
var DATA_DIR = expandHome("~/.claude-mem");
var BUN_EXTRA_PATHS2 = ["~/.bun/bin/bun", "/usr/local/bin/bun", "/opt/homebrew/bin/bun"];
function readJsonFile2(filepath) {
  if (!existsSync5(filepath)) return {};
  return JSON.parse(readFileSync3(filepath, "utf-8"));
}
function writeJsonFile2(filepath, data) {
  writeFileSync3(filepath, JSON.stringify(data, null, 2) + "\n", "utf-8");
}
function stopWorker() {
  const workerScript = join5(MARKETPLACE_DIR3, "plugin", "scripts", "worker-service.cjs");
  if (!existsSync5(workerScript)) return;
  const bunInfo = findBinary("bun", BUN_EXTRA_PATHS2);
  if (!bunInfo.found || !bunInfo.path) return;
  try {
    execSync4(`"${bunInfo.path}" "${workerScript}" stop`, { stdio: "pipe" });
  } catch {
  }
}
function disablePluginInClaudeSettings() {
  if (!existsSync5(CLAUDE_SETTINGS_PATH2)) return;
  const settings2 = readJsonFile2(CLAUDE_SETTINGS_PATH2);
  if (settings2.enabledPlugins && "claude-mem@thedotmack" in settings2.enabledPlugins) {
    delete settings2.enabledPlugins["claude-mem@thedotmack"];
    writeJsonFile2(CLAUDE_SETTINGS_PATH2, settings2);
  }
}
function unregisterPlugin() {
  const installedPluginsPath = join5(PLUGINS_DIR2, "installed_plugins.json");
  if (existsSync5(installedPluginsPath)) {
    const installedPlugins = readJsonFile2(installedPluginsPath);
    if (installedPlugins.plugins && "claude-mem@thedotmack" in installedPlugins.plugins) {
      delete installedPlugins.plugins["claude-mem@thedotmack"];
      writeJsonFile2(installedPluginsPath, installedPlugins);
    }
  }
  const knownMarketplacesPath = join5(PLUGINS_DIR2, "known_marketplaces.json");
  if (existsSync5(knownMarketplacesPath)) {
    const knownMarketplaces = readJsonFile2(knownMarketplacesPath);
    if ("thedotmack" in knownMarketplaces) {
      delete knownMarketplaces["thedotmack"];
      writeJsonFile2(knownMarketplacesPath, knownMarketplaces);
    }
  }
}
function removeDir(dir) {
  if (existsSync5(dir)) {
    rmSync(dir, { recursive: true, force: true });
  }
}
async function runUninstall() {
  const confirmed = await confirm({
    message: "This will remove the claude-mem plugin from Claude Code. Continue?",
    initialValue: false
  });
  if (isCancel(confirmed) || !confirmed) {
    cancel("Uninstall cancelled.");
    process.exit(0);
  }
  let deleteData = false;
  if (existsSync5(DATA_DIR)) {
    const answer = await confirm({
      message: `Also delete all stored memories and settings at ${import_picocolors7.default.dim(DATA_DIR)}? This cannot be undone.`,
      initialValue: false
    });
    if (isCancel(answer)) {
      cancel("Uninstall cancelled.");
      process.exit(0);
    }
    deleteData = answer;
  }
  const s = spinner();
  s.start("Stopping worker service...");
  stopWorker();
  s.stop(`Worker stopped ${import_picocolors7.default.green("OK")}`);
  s.start("Removing plugin from Claude Code...");
  disablePluginInClaudeSettings();
  unregisterPlugin();
  removeDir(MARKETPLACE_DIR3);
  removeDir(PLUGIN_CACHE_DIR);
  s.stop(`Plugin removed ${import_picocolors7.default.green("OK")}`);
  if (deleteData) {
    s.start("Deleting stored memories...");
    removeDir(DATA_DIR);
    s.stop(`Memories deleted ${import_picocolors7.default.green("OK")}`);
  } else {
    log.info(`Stored memories kept at ${import_picocolors7.default.dim(DATA_DIR)}`);
  }
  outro(import_picocolors7.default.green("claude-mem has been uninstalled. Restart Claude Code to finish."));
}

// src/index.ts
async function runInstaller() {
  if (!process.stdin.isTTY) {
    console.error("Error: This installer requires an interactive terminal.");
    console.error("Run directly: npx claude-mem-installer");
    process.exit(1);
  }
  const installMode = await runWelcome();
  if (installMode === "uninstall") {
    await runUninstall();
    return;
  }
  await runDependencyChecks();
  const selectedIDEs = await runIdeSelection();
  const providerConfig = await runProviderConfiguration();
  const settingsConfig = await runSettingsConfiguration();
  writeSettings(providerConfig, settingsConfig);
  log.success("Settings saved.");
  if (installMode !== "configure") {
    await runInstallation(selectedIDEs);
    await runWorkerStartup(settingsConfig.workerPort, settingsConfig.dataDir);
  }
  runCompletion(providerConfig, settingsConfig, selectedIDEs);
}
runInstaller().catch((error) => {
  cancel("Installation failed.");
  console.error(error);
  process.exit(1);
});
