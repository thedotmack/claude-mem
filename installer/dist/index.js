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
    var ESC = "\x1B";
    var CSI = `${ESC}[`;
    var beep = "\x07";
    var cursor = {
      to(x3, y2) {
        if (!y2) return `${CSI}${x3 + 1}G`;
        return `${CSI}${y2 + 1};${x3 + 1}H`;
      },
      move(x3, y2) {
        let ret = "";
        if (x3 < 0) ret += `${CSI}${-x3}D`;
        else if (x3 > 0) ret += `${CSI}${x3}C`;
        if (y2 < 0) ret += `${CSI}${-y2}A`;
        else if (y2 > 0) ret += `${CSI}${y2}B`;
        return ret;
      },
      up: (count = 1) => `${CSI}${count}A`,
      down: (count = 1) => `${CSI}${count}B`,
      forward: (count = 1) => `${CSI}${count}C`,
      backward: (count = 1) => `${CSI}${count}D`,
      nextLine: (count = 1) => `${CSI}E`.repeat(count),
      prevLine: (count = 1) => `${CSI}F`.repeat(count),
      left: `${CSI}G`,
      hide: `${CSI}?25l`,
      show: `${CSI}?25h`,
      save: `${ESC}7`,
      restore: `${ESC}8`
    };
    var scroll = {
      up: (count = 1) => `${CSI}S`.repeat(count),
      down: (count = 1) => `${CSI}T`.repeat(count)
    };
    var erase = {
      screen: `${CSI}2J`,
      up: (count = 1) => `${CSI}1J`.repeat(count),
      down: (count = 1) => `${CSI}J`.repeat(count),
      line: `${CSI}2K`,
      lineEnd: `${CSI}K`,
      lineStart: `${CSI}1K`,
      lines(count) {
        let clear = "";
        for (let i = 0; i < count; i++)
          clear += this.line + (i < count - 1 ? cursor.up() : "");
        if (count)
          clear += cursor.left;
        return clear;
      }
    };
    module.exports = { cursor, scroll, erase, beep };
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
      let result = "", cursor = 0;
      do {
        result += string.substring(cursor, index) + replace;
        cursor = index + close.length;
        index = string.indexOf(close, cursor);
      } while (~index);
      return result + string.substring(cursor);
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
var import_sisteransi = __toESM(require_src(), 1);
import { styleText as D } from "node:util";
import { stdout as R, stdin as q } from "node:process";
import * as k from "node:readline";
import ot from "node:readline";
import { ReadStream as J } from "node:tty";
function x(t2, e, s) {
  if (!s.some((u) => !u.disabled)) return t2;
  const i = t2 + e, r = Math.max(s.length - 1, 0), n = i < 0 ? r : i > r ? 0 : i;
  return s[n].disabled ? x(n, e < 0 ? -1 : 1, s) : n;
}
var at = (t2) => t2 === 161 || t2 === 164 || t2 === 167 || t2 === 168 || t2 === 170 || t2 === 173 || t2 === 174 || t2 >= 176 && t2 <= 180 || t2 >= 182 && t2 <= 186 || t2 >= 188 && t2 <= 191 || t2 === 198 || t2 === 208 || t2 === 215 || t2 === 216 || t2 >= 222 && t2 <= 225 || t2 === 230 || t2 >= 232 && t2 <= 234 || t2 === 236 || t2 === 237 || t2 === 240 || t2 === 242 || t2 === 243 || t2 >= 247 && t2 <= 250 || t2 === 252 || t2 === 254 || t2 === 257 || t2 === 273 || t2 === 275 || t2 === 283 || t2 === 294 || t2 === 295 || t2 === 299 || t2 >= 305 && t2 <= 307 || t2 === 312 || t2 >= 319 && t2 <= 322 || t2 === 324 || t2 >= 328 && t2 <= 331 || t2 === 333 || t2 === 338 || t2 === 339 || t2 === 358 || t2 === 359 || t2 === 363 || t2 === 462 || t2 === 464 || t2 === 466 || t2 === 468 || t2 === 470 || t2 === 472 || t2 === 474 || t2 === 476 || t2 === 593 || t2 === 609 || t2 === 708 || t2 === 711 || t2 >= 713 && t2 <= 715 || t2 === 717 || t2 === 720 || t2 >= 728 && t2 <= 731 || t2 === 733 || t2 === 735 || t2 >= 768 && t2 <= 879 || t2 >= 913 && t2 <= 929 || t2 >= 931 && t2 <= 937 || t2 >= 945 && t2 <= 961 || t2 >= 963 && t2 <= 969 || t2 === 1025 || t2 >= 1040 && t2 <= 1103 || t2 === 1105 || t2 === 8208 || t2 >= 8211 && t2 <= 8214 || t2 === 8216 || t2 === 8217 || t2 === 8220 || t2 === 8221 || t2 >= 8224 && t2 <= 8226 || t2 >= 8228 && t2 <= 8231 || t2 === 8240 || t2 === 8242 || t2 === 8243 || t2 === 8245 || t2 === 8251 || t2 === 8254 || t2 === 8308 || t2 === 8319 || t2 >= 8321 && t2 <= 8324 || t2 === 8364 || t2 === 8451 || t2 === 8453 || t2 === 8457 || t2 === 8467 || t2 === 8470 || t2 === 8481 || t2 === 8482 || t2 === 8486 || t2 === 8491 || t2 === 8531 || t2 === 8532 || t2 >= 8539 && t2 <= 8542 || t2 >= 8544 && t2 <= 8555 || t2 >= 8560 && t2 <= 8569 || t2 === 8585 || t2 >= 8592 && t2 <= 8601 || t2 === 8632 || t2 === 8633 || t2 === 8658 || t2 === 8660 || t2 === 8679 || t2 === 8704 || t2 === 8706 || t2 === 8707 || t2 === 8711 || t2 === 8712 || t2 === 8715 || t2 === 8719 || t2 === 8721 || t2 === 8725 || t2 === 8730 || t2 >= 8733 && t2 <= 8736 || t2 === 8739 || t2 === 8741 || t2 >= 8743 && t2 <= 8748 || t2 === 8750 || t2 >= 8756 && t2 <= 8759 || t2 === 8764 || t2 === 8765 || t2 === 8776 || t2 === 8780 || t2 === 8786 || t2 === 8800 || t2 === 8801 || t2 >= 8804 && t2 <= 8807 || t2 === 8810 || t2 === 8811 || t2 === 8814 || t2 === 8815 || t2 === 8834 || t2 === 8835 || t2 === 8838 || t2 === 8839 || t2 === 8853 || t2 === 8857 || t2 === 8869 || t2 === 8895 || t2 === 8978 || t2 >= 9312 && t2 <= 9449 || t2 >= 9451 && t2 <= 9547 || t2 >= 9552 && t2 <= 9587 || t2 >= 9600 && t2 <= 9615 || t2 >= 9618 && t2 <= 9621 || t2 === 9632 || t2 === 9633 || t2 >= 9635 && t2 <= 9641 || t2 === 9650 || t2 === 9651 || t2 === 9654 || t2 === 9655 || t2 === 9660 || t2 === 9661 || t2 === 9664 || t2 === 9665 || t2 >= 9670 && t2 <= 9672 || t2 === 9675 || t2 >= 9678 && t2 <= 9681 || t2 >= 9698 && t2 <= 9701 || t2 === 9711 || t2 === 9733 || t2 === 9734 || t2 === 9737 || t2 === 9742 || t2 === 9743 || t2 === 9756 || t2 === 9758 || t2 === 9792 || t2 === 9794 || t2 === 9824 || t2 === 9825 || t2 >= 9827 && t2 <= 9829 || t2 >= 9831 && t2 <= 9834 || t2 === 9836 || t2 === 9837 || t2 === 9839 || t2 === 9886 || t2 === 9887 || t2 === 9919 || t2 >= 9926 && t2 <= 9933 || t2 >= 9935 && t2 <= 9939 || t2 >= 9941 && t2 <= 9953 || t2 === 9955 || t2 === 9960 || t2 === 9961 || t2 >= 9963 && t2 <= 9969 || t2 === 9972 || t2 >= 9974 && t2 <= 9977 || t2 === 9979 || t2 === 9980 || t2 === 9982 || t2 === 9983 || t2 === 10045 || t2 >= 10102 && t2 <= 10111 || t2 >= 11094 && t2 <= 11097 || t2 >= 12872 && t2 <= 12879 || t2 >= 57344 && t2 <= 63743 || t2 >= 65024 && t2 <= 65039 || t2 === 65533 || t2 >= 127232 && t2 <= 127242 || t2 >= 127248 && t2 <= 127277 || t2 >= 127280 && t2 <= 127337 || t2 >= 127344 && t2 <= 127373 || t2 === 127375 || t2 === 127376 || t2 >= 127387 && t2 <= 127404 || t2 >= 917760 && t2 <= 917999 || t2 >= 983040 && t2 <= 1048573 || t2 >= 1048576 && t2 <= 1114109;
var lt = (t2) => t2 === 12288 || t2 >= 65281 && t2 <= 65376 || t2 >= 65504 && t2 <= 65510;
var ht = (t2) => t2 >= 4352 && t2 <= 4447 || t2 === 8986 || t2 === 8987 || t2 === 9001 || t2 === 9002 || t2 >= 9193 && t2 <= 9196 || t2 === 9200 || t2 === 9203 || t2 === 9725 || t2 === 9726 || t2 === 9748 || t2 === 9749 || t2 >= 9800 && t2 <= 9811 || t2 === 9855 || t2 === 9875 || t2 === 9889 || t2 === 9898 || t2 === 9899 || t2 === 9917 || t2 === 9918 || t2 === 9924 || t2 === 9925 || t2 === 9934 || t2 === 9940 || t2 === 9962 || t2 === 9970 || t2 === 9971 || t2 === 9973 || t2 === 9978 || t2 === 9981 || t2 === 9989 || t2 === 9994 || t2 === 9995 || t2 === 10024 || t2 === 10060 || t2 === 10062 || t2 >= 10067 && t2 <= 10069 || t2 === 10071 || t2 >= 10133 && t2 <= 10135 || t2 === 10160 || t2 === 10175 || t2 === 11035 || t2 === 11036 || t2 === 11088 || t2 === 11093 || t2 >= 11904 && t2 <= 11929 || t2 >= 11931 && t2 <= 12019 || t2 >= 12032 && t2 <= 12245 || t2 >= 12272 && t2 <= 12287 || t2 >= 12289 && t2 <= 12350 || t2 >= 12353 && t2 <= 12438 || t2 >= 12441 && t2 <= 12543 || t2 >= 12549 && t2 <= 12591 || t2 >= 12593 && t2 <= 12686 || t2 >= 12688 && t2 <= 12771 || t2 >= 12783 && t2 <= 12830 || t2 >= 12832 && t2 <= 12871 || t2 >= 12880 && t2 <= 19903 || t2 >= 19968 && t2 <= 42124 || t2 >= 42128 && t2 <= 42182 || t2 >= 43360 && t2 <= 43388 || t2 >= 44032 && t2 <= 55203 || t2 >= 63744 && t2 <= 64255 || t2 >= 65040 && t2 <= 65049 || t2 >= 65072 && t2 <= 65106 || t2 >= 65108 && t2 <= 65126 || t2 >= 65128 && t2 <= 65131 || t2 >= 94176 && t2 <= 94180 || t2 === 94192 || t2 === 94193 || t2 >= 94208 && t2 <= 100343 || t2 >= 100352 && t2 <= 101589 || t2 >= 101632 && t2 <= 101640 || t2 >= 110576 && t2 <= 110579 || t2 >= 110581 && t2 <= 110587 || t2 === 110589 || t2 === 110590 || t2 >= 110592 && t2 <= 110882 || t2 === 110898 || t2 >= 110928 && t2 <= 110930 || t2 === 110933 || t2 >= 110948 && t2 <= 110951 || t2 >= 110960 && t2 <= 111355 || t2 === 126980 || t2 === 127183 || t2 === 127374 || t2 >= 127377 && t2 <= 127386 || t2 >= 127488 && t2 <= 127490 || t2 >= 127504 && t2 <= 127547 || t2 >= 127552 && t2 <= 127560 || t2 === 127568 || t2 === 127569 || t2 >= 127584 && t2 <= 127589 || t2 >= 127744 && t2 <= 127776 || t2 >= 127789 && t2 <= 127797 || t2 >= 127799 && t2 <= 127868 || t2 >= 127870 && t2 <= 127891 || t2 >= 127904 && t2 <= 127946 || t2 >= 127951 && t2 <= 127955 || t2 >= 127968 && t2 <= 127984 || t2 === 127988 || t2 >= 127992 && t2 <= 128062 || t2 === 128064 || t2 >= 128066 && t2 <= 128252 || t2 >= 128255 && t2 <= 128317 || t2 >= 128331 && t2 <= 128334 || t2 >= 128336 && t2 <= 128359 || t2 === 128378 || t2 === 128405 || t2 === 128406 || t2 === 128420 || t2 >= 128507 && t2 <= 128591 || t2 >= 128640 && t2 <= 128709 || t2 === 128716 || t2 >= 128720 && t2 <= 128722 || t2 >= 128725 && t2 <= 128727 || t2 >= 128732 && t2 <= 128735 || t2 === 128747 || t2 === 128748 || t2 >= 128756 && t2 <= 128764 || t2 >= 128992 && t2 <= 129003 || t2 === 129008 || t2 >= 129292 && t2 <= 129338 || t2 >= 129340 && t2 <= 129349 || t2 >= 129351 && t2 <= 129535 || t2 >= 129648 && t2 <= 129660 || t2 >= 129664 && t2 <= 129672 || t2 >= 129680 && t2 <= 129725 || t2 >= 129727 && t2 <= 129733 || t2 >= 129742 && t2 <= 129755 || t2 >= 129760 && t2 <= 129768 || t2 >= 129776 && t2 <= 129784 || t2 >= 131072 && t2 <= 196605 || t2 >= 196608 && t2 <= 262141;
var O = /[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/y;
var y = /[\x00-\x08\x0A-\x1F\x7F-\x9F]{1,1000}/y;
var L = /\t{1,1000}/y;
var P = new RegExp("[\\u{1F1E6}-\\u{1F1FF}]{2}|\\u{1F3F4}[\\u{E0061}-\\u{E007A}]{2}[\\u{E0030}-\\u{E0039}\\u{E0061}-\\u{E007A}]{1,3}\\u{E007F}|(?:\\p{Emoji}\\uFE0F\\u20E3?|\\p{Emoji_Modifier_Base}\\p{Emoji_Modifier}?|\\p{Emoji_Presentation})(?:\\u200D(?:\\p{Emoji_Modifier_Base}\\p{Emoji_Modifier}?|\\p{Emoji_Presentation}|\\p{Emoji}\\uFE0F\\u20E3?))*", "yu");
var M = /(?:[\x20-\x7E\xA0-\xFF](?!\uFE0F)){1,1000}/y;
var ct = new RegExp("\\p{M}+", "gu");
var ft = { limit: 1 / 0, ellipsis: "" };
var X = (t2, e = {}, s = {}) => {
  const i = e.limit ?? 1 / 0, r = e.ellipsis ?? "", n = e?.ellipsisWidth ?? (r ? X(r, ft, s).width : 0), u = s.ansiWidth ?? 0, a = s.controlWidth ?? 0, l = s.tabWidth ?? 8, E = s.ambiguousWidth ?? 1, g = s.emojiWidth ?? 2, m = s.fullWidthWidth ?? 2, A = s.regularWidth ?? 1, V2 = s.wideWidth ?? 2;
  let h2 = 0, o = 0, p = t2.length, v = 0, F = false, d = p, b = Math.max(0, i - n), C = 0, w = 0, c = 0, f = 0;
  t: for (; ; ) {
    if (w > C || o >= p && o > h2) {
      const ut = t2.slice(C, w) || t2.slice(h2, o);
      v = 0;
      for (const Y of ut.replaceAll(ct, "")) {
        const $ = Y.codePointAt(0) || 0;
        if (lt($) ? f = m : ht($) ? f = V2 : E !== A && at($) ? f = E : f = A, c + f > b && (d = Math.min(d, Math.max(C, h2) + v)), c + f > i) {
          F = true;
          break t;
        }
        v += Y.length, c += f;
      }
      C = w = 0;
    }
    if (o >= p) break;
    if (M.lastIndex = o, M.test(t2)) {
      if (v = M.lastIndex - o, f = v * A, c + f > b && (d = Math.min(d, o + Math.floor((b - c) / A))), c + f > i) {
        F = true;
        break;
      }
      c += f, C = h2, w = o, o = h2 = M.lastIndex;
      continue;
    }
    if (O.lastIndex = o, O.test(t2)) {
      if (c + u > b && (d = Math.min(d, o)), c + u > i) {
        F = true;
        break;
      }
      c += u, C = h2, w = o, o = h2 = O.lastIndex;
      continue;
    }
    if (y.lastIndex = o, y.test(t2)) {
      if (v = y.lastIndex - o, f = v * a, c + f > b && (d = Math.min(d, o + Math.floor((b - c) / a))), c + f > i) {
        F = true;
        break;
      }
      c += f, C = h2, w = o, o = h2 = y.lastIndex;
      continue;
    }
    if (L.lastIndex = o, L.test(t2)) {
      if (v = L.lastIndex - o, f = v * l, c + f > b && (d = Math.min(d, o + Math.floor((b - c) / l))), c + f > i) {
        F = true;
        break;
      }
      c += f, C = h2, w = o, o = h2 = L.lastIndex;
      continue;
    }
    if (P.lastIndex = o, P.test(t2)) {
      if (c + g > b && (d = Math.min(d, o)), c + g > i) {
        F = true;
        break;
      }
      c += g, C = h2, w = o, o = h2 = P.lastIndex;
      continue;
    }
    o += 1;
  }
  return { width: F ? b : c, index: F ? d : p, truncated: F, ellipsed: F && i >= n };
};
var pt = { limit: 1 / 0, ellipsis: "", ellipsisWidth: 0 };
var S = (t2, e = {}) => X(t2, pt, e).width;
var T = "\x1B";
var Z = "\x9B";
var Ft = 39;
var j = "\x07";
var Q = "[";
var dt = "]";
var tt = "m";
var U = `${dt}8;;`;
var et = new RegExp(`(?:\\${Q}(?<code>\\d+)m|\\${U}(?<uri>.*)${j})`, "y");
var mt = (t2) => {
  if (t2 >= 30 && t2 <= 37 || t2 >= 90 && t2 <= 97) return 39;
  if (t2 >= 40 && t2 <= 47 || t2 >= 100 && t2 <= 107) return 49;
  if (t2 === 1 || t2 === 2) return 22;
  if (t2 === 3) return 23;
  if (t2 === 4) return 24;
  if (t2 === 7) return 27;
  if (t2 === 8) return 28;
  if (t2 === 9) return 29;
  if (t2 === 0) return 0;
};
var st = (t2) => `${T}${Q}${t2}${tt}`;
var it = (t2) => `${T}${U}${t2}${j}`;
var gt = (t2) => t2.map((e) => S(e));
var G = (t2, e, s) => {
  const i = e[Symbol.iterator]();
  let r = false, n = false, u = t2.at(-1), a = u === void 0 ? 0 : S(u), l = i.next(), E = i.next(), g = 0;
  for (; !l.done; ) {
    const m = l.value, A = S(m);
    a + A <= s ? t2[t2.length - 1] += m : (t2.push(m), a = 0), (m === T || m === Z) && (r = true, n = e.startsWith(U, g + 1)), r ? n ? m === j && (r = false, n = false) : m === tt && (r = false) : (a += A, a === s && !E.done && (t2.push(""), a = 0)), l = E, E = i.next(), g += m.length;
  }
  u = t2.at(-1), !a && u !== void 0 && u.length > 0 && t2.length > 1 && (t2[t2.length - 2] += t2.pop());
};
var vt = (t2) => {
  const e = t2.split(" ");
  let s = e.length;
  for (; s > 0 && !(S(e[s - 1]) > 0); ) s--;
  return s === e.length ? t2 : e.slice(0, s).join(" ") + e.slice(s).join("");
};
var Et = (t2, e, s = {}) => {
  if (s.trim !== false && t2.trim() === "") return "";
  let i = "", r, n;
  const u = t2.split(" "), a = gt(u);
  let l = [""];
  for (const [h2, o] of u.entries()) {
    s.trim !== false && (l[l.length - 1] = (l.at(-1) ?? "").trimStart());
    let p = S(l.at(-1) ?? "");
    if (h2 !== 0 && (p >= e && (s.wordWrap === false || s.trim === false) && (l.push(""), p = 0), (p > 0 || s.trim === false) && (l[l.length - 1] += " ", p++)), s.hard && a[h2] > e) {
      const v = e - p, F = 1 + Math.floor((a[h2] - v - 1) / e);
      Math.floor((a[h2] - 1) / e) < F && l.push(""), G(l, o, e);
      continue;
    }
    if (p + a[h2] > e && p > 0 && a[h2] > 0) {
      if (s.wordWrap === false && p < e) {
        G(l, o, e);
        continue;
      }
      l.push("");
    }
    if (p + a[h2] > e && s.wordWrap === false) {
      G(l, o, e);
      continue;
    }
    l[l.length - 1] += o;
  }
  s.trim !== false && (l = l.map((h2) => vt(h2)));
  const E = l.join(`
`), g = E[Symbol.iterator]();
  let m = g.next(), A = g.next(), V2 = 0;
  for (; !m.done; ) {
    const h2 = m.value, o = A.value;
    if (i += h2, h2 === T || h2 === Z) {
      et.lastIndex = V2 + 1;
      const F = et.exec(E)?.groups;
      if (F?.code !== void 0) {
        const d = Number.parseFloat(F.code);
        r = d === Ft ? void 0 : d;
      } else F?.uri !== void 0 && (n = F.uri.length === 0 ? void 0 : F.uri);
    }
    const p = r ? mt(r) : void 0;
    o === `
` ? (n && (i += it("")), r && p && (i += st(p))) : h2 === `
` && (r && p && (i += st(r)), n && (i += it(n))), V2 += h2.length, m = A, A = g.next();
  }
  return i;
};
function K(t2, e, s) {
  return String(t2).normalize().replaceAll(`\r
`, `
`).split(`
`).map((i) => Et(i, e, s)).join(`
`);
}
var At = ["up", "down", "left", "right", "space", "enter", "cancel"];
var _ = { actions: new Set(At), aliases: /* @__PURE__ */ new Map([["k", "up"], ["j", "down"], ["h", "left"], ["l", "right"], ["", "cancel"], ["escape", "cancel"]]), messages: { cancel: "Canceled", error: "Something went wrong" }, withGuide: true };
function H(t2, e) {
  if (typeof t2 == "string") return _.aliases.get(t2) === e;
  for (const s of t2) if (s !== void 0 && H(s, e)) return true;
  return false;
}
function _t(t2, e) {
  if (t2 === e) return;
  const s = t2.split(`
`), i = e.split(`
`), r = Math.max(s.length, i.length), n = [];
  for (let u = 0; u < r; u++) s[u] !== i[u] && n.push(u);
  return { lines: n, numLinesBefore: s.length, numLinesAfter: i.length, numLines: r };
}
var bt = globalThis.process.platform.startsWith("win");
var z = Symbol("clack:cancel");
function Ct(t2) {
  return t2 === z;
}
function W(t2, e) {
  const s = t2;
  s.isTTY && s.setRawMode(e);
}
function xt({ input: t2 = q, output: e = R, overwrite: s = true, hideCursor: i = true } = {}) {
  const r = k.createInterface({ input: t2, output: e, prompt: "", tabSize: 1 });
  k.emitKeypressEvents(t2, r), t2 instanceof J && t2.isTTY && t2.setRawMode(true);
  const n = (u, { name: a, sequence: l }) => {
    const E = String(u);
    if (H([E, a, l], "cancel")) {
      i && e.write(import_sisteransi.cursor.show), process.exit(0);
      return;
    }
    if (!s) return;
    const g = a === "return" ? 0 : -1, m = a === "return" ? -1 : 0;
    k.moveCursor(e, g, m, () => {
      k.clearLine(e, 1, () => {
        t2.once("keypress", n);
      });
    });
  };
  return i && e.write(import_sisteransi.cursor.hide), t2.once("keypress", n), () => {
    t2.off("keypress", n), i && e.write(import_sisteransi.cursor.show), t2 instanceof J && t2.isTTY && !bt && t2.setRawMode(false), r.terminal = false, r.close();
  };
}
var rt = (t2) => "columns" in t2 && typeof t2.columns == "number" ? t2.columns : 80;
var nt = (t2) => "rows" in t2 && typeof t2.rows == "number" ? t2.rows : 20;
function Bt(t2, e, s, i = s) {
  const r = rt(t2 ?? R);
  return K(e, r - s.length, { hard: true, trim: false }).split(`
`).map((n, u) => `${u === 0 ? i : s}${n}`).join(`
`);
}
var B = class {
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
  constructor(e, s = true) {
    const { input: i = q, output: r = R, render: n, signal: u, ...a } = e;
    this.opts = a, this.onKeypress = this.onKeypress.bind(this), this.close = this.close.bind(this), this.render = this.render.bind(this), this._render = n.bind(this), this._track = s, this._abortSignal = u, this.input = i, this.output = r;
  }
  unsubscribe() {
    this._subscribers.clear();
  }
  setSubscriber(e, s) {
    const i = this._subscribers.get(e) ?? [];
    i.push(s), this._subscribers.set(e, i);
  }
  on(e, s) {
    this.setSubscriber(e, { cb: s });
  }
  once(e, s) {
    this.setSubscriber(e, { cb: s, once: true });
  }
  emit(e, ...s) {
    const i = this._subscribers.get(e) ?? [], r = [];
    for (const n of i) n.cb(...s), n.once && r.push(() => i.splice(i.indexOf(n), 1));
    for (const n of r) n();
  }
  prompt() {
    return new Promise((e) => {
      if (this._abortSignal) {
        if (this._abortSignal.aborted) return this.state = "cancel", this.close(), e(z);
        this._abortSignal.addEventListener("abort", () => {
          this.state = "cancel", this.close();
        }, { once: true });
      }
      this.rl = ot.createInterface({ input: this.input, tabSize: 2, prompt: "", escapeCodeTimeout: 50, terminal: true }), this.rl.prompt(), this.opts.initialUserInput !== void 0 && this._setUserInput(this.opts.initialUserInput, true), this.input.on("keypress", this.onKeypress), W(this.input, true), this.output.on("resize", this.render), this.render(), this.once("submit", () => {
        this.output.write(import_sisteransi.cursor.show), this.output.off("resize", this.render), W(this.input, false), e(this.value);
      }), this.once("cancel", () => {
        this.output.write(import_sisteransi.cursor.show), this.output.off("resize", this.render), W(this.input, false), e(z);
      });
    });
  }
  _isActionKey(e, s) {
    return e === "	";
  }
  _setValue(e) {
    this.value = e, this.emit("value", this.value);
  }
  _setUserInput(e, s) {
    this.userInput = e ?? "", this.emit("userInput", this.userInput), s && this._track && this.rl && (this.rl.write(this.userInput), this._cursor = this.rl.cursor);
  }
  _clearUserInput() {
    this.rl?.write(null, { ctrl: true, name: "u" }), this._setUserInput("");
  }
  onKeypress(e, s) {
    if (this._track && s.name !== "return" && (s.name && this._isActionKey(e, s) && this.rl?.write(null, { ctrl: true, name: "h" }), this._cursor = this.rl?.cursor ?? 0, this._setUserInput(this.rl?.line)), this.state === "error" && (this.state = "active"), s?.name && (!this._track && _.aliases.has(s.name) && this.emit("cursor", _.aliases.get(s.name)), _.actions.has(s.name) && this.emit("cursor", s.name)), e && (e.toLowerCase() === "y" || e.toLowerCase() === "n") && this.emit("confirm", e.toLowerCase() === "y"), this.emit("key", e?.toLowerCase(), s), s?.name === "return") {
      if (this.opts.validate) {
        const i = this.opts.validate(this.value);
        i && (this.error = i instanceof Error ? i.message : i, this.state = "error", this.rl?.write(this.userInput));
      }
      this.state !== "error" && (this.state = "submit");
    }
    H([e, s?.name, s?.sequence], "cancel") && (this.state = "cancel"), (this.state === "submit" || this.state === "cancel") && this.emit("finalize"), this.render(), (this.state === "submit" || this.state === "cancel") && this.close();
  }
  close() {
    this.input.unpipe(), this.input.removeListener("keypress", this.onKeypress), this.output.write(`
`), W(this.input, false), this.rl?.close(), this.rl = void 0, this.emit(`${this.state}`, this.value), this.unsubscribe();
  }
  restoreCursor() {
    const e = K(this._prevFrame, process.stdout.columns, { hard: true, trim: false }).split(`
`).length - 1;
    this.output.write(import_sisteransi.cursor.move(-999, e * -1));
  }
  render() {
    const e = K(this._render(this) ?? "", process.stdout.columns, { hard: true, trim: false });
    if (e !== this._prevFrame) {
      if (this.state === "initial") this.output.write(import_sisteransi.cursor.hide);
      else {
        const s = _t(this._prevFrame, e), i = nt(this.output);
        if (this.restoreCursor(), s) {
          const r = Math.max(0, s.numLinesAfter - i), n = Math.max(0, s.numLinesBefore - i);
          let u = s.lines.find((a) => a >= r);
          if (u === void 0) {
            this._prevFrame = e;
            return;
          }
          if (s.lines.length === 1) {
            this.output.write(import_sisteransi.cursor.move(0, u - n)), this.output.write(import_sisteransi.erase.lines(1));
            const a = e.split(`
`);
            this.output.write(a[u]), this._prevFrame = e, this.output.write(import_sisteransi.cursor.move(0, a.length - u - 1));
            return;
          } else if (s.lines.length > 1) {
            if (r < n) u = r;
            else {
              const l = u - n;
              l > 0 && this.output.write(import_sisteransi.cursor.move(0, l));
            }
            this.output.write(import_sisteransi.erase.down());
            const a = e.split(`
`).slice(u);
            this.output.write(a.join(`
`)), this._prevFrame = e;
            return;
          }
        }
        this.output.write(import_sisteransi.erase.down());
      }
      this.output.write(e), this.state === "initial" && (this.state = "active"), this._prevFrame = e;
    }
  }
};
var kt = class extends B {
  get cursor() {
    return this.value ? 0 : 1;
  }
  get _value() {
    return this.cursor === 0;
  }
  constructor(e) {
    super(e, false), this.value = !!e.initialValue, this.on("userInput", () => {
      this.value = this._value;
    }), this.on("confirm", (s) => {
      this.output.write(import_sisteransi.cursor.move(0, -1)), this.value = s, this.state = "submit", this.close();
    }), this.on("cursor", () => {
      this.value = !this.value;
    });
  }
};
var Lt = class extends B {
  options;
  cursor = 0;
  get _value() {
    return this.options[this.cursor].value;
  }
  get _enabledOptions() {
    return this.options.filter((e) => e.disabled !== true);
  }
  toggleAll() {
    const e = this._enabledOptions, s = this.value !== void 0 && this.value.length === e.length;
    this.value = s ? [] : e.map((i) => i.value);
  }
  toggleInvert() {
    const e = this.value;
    if (!e) return;
    const s = this._enabledOptions.filter((i) => !e.includes(i.value));
    this.value = s.map((i) => i.value);
  }
  toggleValue() {
    this.value === void 0 && (this.value = []);
    const e = this.value.includes(this._value);
    this.value = e ? this.value.filter((s) => s !== this._value) : [...this.value, this._value];
  }
  constructor(e) {
    super(e, false), this.options = e.options, this.value = [...e.initialValues ?? []];
    const s = Math.max(this.options.findIndex(({ value: i }) => i === e.cursorAt), 0);
    this.cursor = this.options[s].disabled ? x(s, 1, this.options) : s, this.on("key", (i) => {
      i === "a" && this.toggleAll(), i === "i" && this.toggleInvert();
    }), this.on("cursor", (i) => {
      switch (i) {
        case "left":
        case "up":
          this.cursor = x(this.cursor, -1, this.options);
          break;
        case "down":
        case "right":
          this.cursor = x(this.cursor, 1, this.options);
          break;
        case "space":
          this.toggleValue();
          break;
      }
    });
  }
};
var Mt = class extends B {
  _mask = "\u2022";
  get cursor() {
    return this._cursor;
  }
  get masked() {
    return this.userInput.replaceAll(/./g, this._mask);
  }
  get userInputWithCursor() {
    if (this.state === "submit" || this.state === "cancel") return this.masked;
    const e = this.userInput;
    if (this.cursor >= e.length) return `${this.masked}${D(["inverse", "hidden"], "_")}`;
    const s = this.masked, i = s.slice(0, this.cursor), r = s.slice(this.cursor);
    return `${i}${D("inverse", r[0])}${r.slice(1)}`;
  }
  clear() {
    this._clearUserInput();
  }
  constructor({ mask: e, ...s }) {
    super(s), this._mask = e ?? "\u2022", this.on("userInput", (i) => {
      this._setValue(i);
    });
  }
};
var Tt = class extends B {
  options;
  cursor = 0;
  get _selectedValue() {
    return this.options[this.cursor];
  }
  changeValue() {
    this.value = this._selectedValue.value;
  }
  constructor(e) {
    super(e, false), this.options = e.options;
    const s = this.options.findIndex(({ value: r }) => r === e.initialValue), i = s === -1 ? 0 : s;
    this.cursor = this.options[i].disabled ? x(i, 1, this.options) : i, this.changeValue(), this.on("cursor", (r) => {
      switch (r) {
        case "left":
        case "up":
          this.cursor = x(this.cursor, -1, this.options);
          break;
        case "down":
        case "right":
          this.cursor = x(this.cursor, 1, this.options);
          break;
      }
      this.changeValue();
    });
  }
};
var $t = class extends B {
  get userInputWithCursor() {
    if (this.state === "submit") return this.userInput;
    const e = this.userInput;
    if (this.cursor >= e.length) return `${this.userInput}\u2588`;
    const s = e.slice(0, this.cursor), [i, ...r] = e.slice(this.cursor);
    return `${s}${D("inverse", i)}${r.join("")}`;
  }
  get cursor() {
    return this._cursor;
  }
  constructor(e) {
    super({ ...e, initialUserInput: e.initialUserInput ?? e.initialValue }), this.on("userInput", (s) => {
      this._setValue(s);
    }), this.on("finalize", () => {
      this.value || (this.value = e.defaultValue), this.value === void 0 && (this.value = "");
    });
  }
};

// node_modules/@clack/prompts/dist/index.mjs
import { styleText as t, stripVTControlCharacters as ue } from "node:util";
import N2 from "node:process";
var import_sisteransi2 = __toESM(require_src(), 1);
function pt2() {
  return N2.platform !== "win32" ? N2.env.TERM !== "linux" : !!N2.env.CI || !!N2.env.WT_SESSION || !!N2.env.TERMINUS_SUBLIME || N2.env.ConEmuTask === "{cmd::Cmder}" || N2.env.TERM_PROGRAM === "Terminus-Sublime" || N2.env.TERM_PROGRAM === "vscode" || N2.env.TERM === "xterm-256color" || N2.env.TERM === "alacritty" || N2.env.TERMINAL_EMULATOR === "JetBrains-JediTerm";
}
var ee = pt2();
var ce = () => process.env.CI === "true";
var I2 = (e, r) => ee ? e : r;
var Re = I2("\u25C6", "*");
var $e = I2("\u25A0", "x");
var de = I2("\u25B2", "x");
var V = I2("\u25C7", "o");
var he = I2("\u250C", "T");
var h = I2("\u2502", "|");
var x2 = I2("\u2514", "\u2014");
var Oe = I2("\u2510", "T");
var Pe = I2("\u2518", "\u2014");
var z2 = I2("\u25CF", ">");
var H2 = I2("\u25CB", " ");
var te = I2("\u25FB", "[\u2022]");
var U2 = I2("\u25FC", "[+]");
var q2 = I2("\u25FB", "[ ]");
var Ne = I2("\u25AA", "\u2022");
var se = I2("\u2500", "-");
var pe = I2("\u256E", "+");
var We = I2("\u251C", "+");
var me = I2("\u256F", "+");
var ge = I2("\u2570", "+");
var Ge = I2("\u256D", "+");
var fe = I2("\u25CF", "\u2022");
var Fe = I2("\u25C6", "*");
var ye = I2("\u25B2", "!");
var Ee = I2("\u25A0", "x");
var W2 = (e) => {
  switch (e) {
    case "initial":
    case "active":
      return t("cyan", Re);
    case "cancel":
      return t("red", $e);
    case "error":
      return t("yellow", de);
    case "submit":
      return t("green", V);
  }
};
var ve = (e) => {
  switch (e) {
    case "initial":
    case "active":
      return t("cyan", h);
    case "cancel":
      return t("red", h);
    case "error":
      return t("yellow", h);
    case "submit":
      return t("green", h);
  }
};
var mt2 = (e) => e === 161 || e === 164 || e === 167 || e === 168 || e === 170 || e === 173 || e === 174 || e >= 176 && e <= 180 || e >= 182 && e <= 186 || e >= 188 && e <= 191 || e === 198 || e === 208 || e === 215 || e === 216 || e >= 222 && e <= 225 || e === 230 || e >= 232 && e <= 234 || e === 236 || e === 237 || e === 240 || e === 242 || e === 243 || e >= 247 && e <= 250 || e === 252 || e === 254 || e === 257 || e === 273 || e === 275 || e === 283 || e === 294 || e === 295 || e === 299 || e >= 305 && e <= 307 || e === 312 || e >= 319 && e <= 322 || e === 324 || e >= 328 && e <= 331 || e === 333 || e === 338 || e === 339 || e === 358 || e === 359 || e === 363 || e === 462 || e === 464 || e === 466 || e === 468 || e === 470 || e === 472 || e === 474 || e === 476 || e === 593 || e === 609 || e === 708 || e === 711 || e >= 713 && e <= 715 || e === 717 || e === 720 || e >= 728 && e <= 731 || e === 733 || e === 735 || e >= 768 && e <= 879 || e >= 913 && e <= 929 || e >= 931 && e <= 937 || e >= 945 && e <= 961 || e >= 963 && e <= 969 || e === 1025 || e >= 1040 && e <= 1103 || e === 1105 || e === 8208 || e >= 8211 && e <= 8214 || e === 8216 || e === 8217 || e === 8220 || e === 8221 || e >= 8224 && e <= 8226 || e >= 8228 && e <= 8231 || e === 8240 || e === 8242 || e === 8243 || e === 8245 || e === 8251 || e === 8254 || e === 8308 || e === 8319 || e >= 8321 && e <= 8324 || e === 8364 || e === 8451 || e === 8453 || e === 8457 || e === 8467 || e === 8470 || e === 8481 || e === 8482 || e === 8486 || e === 8491 || e === 8531 || e === 8532 || e >= 8539 && e <= 8542 || e >= 8544 && e <= 8555 || e >= 8560 && e <= 8569 || e === 8585 || e >= 8592 && e <= 8601 || e === 8632 || e === 8633 || e === 8658 || e === 8660 || e === 8679 || e === 8704 || e === 8706 || e === 8707 || e === 8711 || e === 8712 || e === 8715 || e === 8719 || e === 8721 || e === 8725 || e === 8730 || e >= 8733 && e <= 8736 || e === 8739 || e === 8741 || e >= 8743 && e <= 8748 || e === 8750 || e >= 8756 && e <= 8759 || e === 8764 || e === 8765 || e === 8776 || e === 8780 || e === 8786 || e === 8800 || e === 8801 || e >= 8804 && e <= 8807 || e === 8810 || e === 8811 || e === 8814 || e === 8815 || e === 8834 || e === 8835 || e === 8838 || e === 8839 || e === 8853 || e === 8857 || e === 8869 || e === 8895 || e === 8978 || e >= 9312 && e <= 9449 || e >= 9451 && e <= 9547 || e >= 9552 && e <= 9587 || e >= 9600 && e <= 9615 || e >= 9618 && e <= 9621 || e === 9632 || e === 9633 || e >= 9635 && e <= 9641 || e === 9650 || e === 9651 || e === 9654 || e === 9655 || e === 9660 || e === 9661 || e === 9664 || e === 9665 || e >= 9670 && e <= 9672 || e === 9675 || e >= 9678 && e <= 9681 || e >= 9698 && e <= 9701 || e === 9711 || e === 9733 || e === 9734 || e === 9737 || e === 9742 || e === 9743 || e === 9756 || e === 9758 || e === 9792 || e === 9794 || e === 9824 || e === 9825 || e >= 9827 && e <= 9829 || e >= 9831 && e <= 9834 || e === 9836 || e === 9837 || e === 9839 || e === 9886 || e === 9887 || e === 9919 || e >= 9926 && e <= 9933 || e >= 9935 && e <= 9939 || e >= 9941 && e <= 9953 || e === 9955 || e === 9960 || e === 9961 || e >= 9963 && e <= 9969 || e === 9972 || e >= 9974 && e <= 9977 || e === 9979 || e === 9980 || e === 9982 || e === 9983 || e === 10045 || e >= 10102 && e <= 10111 || e >= 11094 && e <= 11097 || e >= 12872 && e <= 12879 || e >= 57344 && e <= 63743 || e >= 65024 && e <= 65039 || e === 65533 || e >= 127232 && e <= 127242 || e >= 127248 && e <= 127277 || e >= 127280 && e <= 127337 || e >= 127344 && e <= 127373 || e === 127375 || e === 127376 || e >= 127387 && e <= 127404 || e >= 917760 && e <= 917999 || e >= 983040 && e <= 1048573 || e >= 1048576 && e <= 1114109;
var gt2 = (e) => e === 12288 || e >= 65281 && e <= 65376 || e >= 65504 && e <= 65510;
var ft2 = (e) => e >= 4352 && e <= 4447 || e === 8986 || e === 8987 || e === 9001 || e === 9002 || e >= 9193 && e <= 9196 || e === 9200 || e === 9203 || e === 9725 || e === 9726 || e === 9748 || e === 9749 || e >= 9800 && e <= 9811 || e === 9855 || e === 9875 || e === 9889 || e === 9898 || e === 9899 || e === 9917 || e === 9918 || e === 9924 || e === 9925 || e === 9934 || e === 9940 || e === 9962 || e === 9970 || e === 9971 || e === 9973 || e === 9978 || e === 9981 || e === 9989 || e === 9994 || e === 9995 || e === 10024 || e === 10060 || e === 10062 || e >= 10067 && e <= 10069 || e === 10071 || e >= 10133 && e <= 10135 || e === 10160 || e === 10175 || e === 11035 || e === 11036 || e === 11088 || e === 11093 || e >= 11904 && e <= 11929 || e >= 11931 && e <= 12019 || e >= 12032 && e <= 12245 || e >= 12272 && e <= 12287 || e >= 12289 && e <= 12350 || e >= 12353 && e <= 12438 || e >= 12441 && e <= 12543 || e >= 12549 && e <= 12591 || e >= 12593 && e <= 12686 || e >= 12688 && e <= 12771 || e >= 12783 && e <= 12830 || e >= 12832 && e <= 12871 || e >= 12880 && e <= 19903 || e >= 19968 && e <= 42124 || e >= 42128 && e <= 42182 || e >= 43360 && e <= 43388 || e >= 44032 && e <= 55203 || e >= 63744 && e <= 64255 || e >= 65040 && e <= 65049 || e >= 65072 && e <= 65106 || e >= 65108 && e <= 65126 || e >= 65128 && e <= 65131 || e >= 94176 && e <= 94180 || e === 94192 || e === 94193 || e >= 94208 && e <= 100343 || e >= 100352 && e <= 101589 || e >= 101632 && e <= 101640 || e >= 110576 && e <= 110579 || e >= 110581 && e <= 110587 || e === 110589 || e === 110590 || e >= 110592 && e <= 110882 || e === 110898 || e >= 110928 && e <= 110930 || e === 110933 || e >= 110948 && e <= 110951 || e >= 110960 && e <= 111355 || e === 126980 || e === 127183 || e === 127374 || e >= 127377 && e <= 127386 || e >= 127488 && e <= 127490 || e >= 127504 && e <= 127547 || e >= 127552 && e <= 127560 || e === 127568 || e === 127569 || e >= 127584 && e <= 127589 || e >= 127744 && e <= 127776 || e >= 127789 && e <= 127797 || e >= 127799 && e <= 127868 || e >= 127870 && e <= 127891 || e >= 127904 && e <= 127946 || e >= 127951 && e <= 127955 || e >= 127968 && e <= 127984 || e === 127988 || e >= 127992 && e <= 128062 || e === 128064 || e >= 128066 && e <= 128252 || e >= 128255 && e <= 128317 || e >= 128331 && e <= 128334 || e >= 128336 && e <= 128359 || e === 128378 || e === 128405 || e === 128406 || e === 128420 || e >= 128507 && e <= 128591 || e >= 128640 && e <= 128709 || e === 128716 || e >= 128720 && e <= 128722 || e >= 128725 && e <= 128727 || e >= 128732 && e <= 128735 || e === 128747 || e === 128748 || e >= 128756 && e <= 128764 || e >= 128992 && e <= 129003 || e === 129008 || e >= 129292 && e <= 129338 || e >= 129340 && e <= 129349 || e >= 129351 && e <= 129535 || e >= 129648 && e <= 129660 || e >= 129664 && e <= 129672 || e >= 129680 && e <= 129725 || e >= 129727 && e <= 129733 || e >= 129742 && e <= 129755 || e >= 129760 && e <= 129768 || e >= 129776 && e <= 129784 || e >= 131072 && e <= 196605 || e >= 196608 && e <= 262141;
var we = /[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/y;
var re = /[\x00-\x08\x0A-\x1F\x7F-\x9F]{1,1000}/y;
var ie = /\t{1,1000}/y;
var Ae = new RegExp("[\\u{1F1E6}-\\u{1F1FF}]{2}|\\u{1F3F4}[\\u{E0061}-\\u{E007A}]{2}[\\u{E0030}-\\u{E0039}\\u{E0061}-\\u{E007A}]{1,3}\\u{E007F}|(?:\\p{Emoji}\\uFE0F\\u20E3?|\\p{Emoji_Modifier_Base}\\p{Emoji_Modifier}?|\\p{Emoji_Presentation})(?:\\u200D(?:\\p{Emoji_Modifier_Base}\\p{Emoji_Modifier}?|\\p{Emoji_Presentation}|\\p{Emoji}\\uFE0F\\u20E3?))*", "yu");
var ne = /(?:[\x20-\x7E\xA0-\xFF](?!\uFE0F)){1,1000}/y;
var Ft2 = new RegExp("\\p{M}+", "gu");
var yt2 = { limit: 1 / 0, ellipsis: "" };
var Le = (e, r = {}, s = {}) => {
  const i = r.limit ?? 1 / 0, a = r.ellipsis ?? "", o = r?.ellipsisWidth ?? (a ? Le(a, yt2, s).width : 0), u = s.ansiWidth ?? 0, l = s.controlWidth ?? 0, n = s.tabWidth ?? 8, c = s.ambiguousWidth ?? 1, p = s.emojiWidth ?? 2, f = s.fullWidthWidth ?? 2, g = s.regularWidth ?? 1, E = s.wideWidth ?? 2;
  let $ = 0, m = 0, d = e.length, F = 0, y2 = false, v = d, C = Math.max(0, i - o), A = 0, b = 0, w = 0, S2 = 0;
  e: for (; ; ) {
    if (b > A || m >= d && m > $) {
      const T2 = e.slice(A, b) || e.slice($, m);
      F = 0;
      for (const M2 of T2.replaceAll(Ft2, "")) {
        const O2 = M2.codePointAt(0) || 0;
        if (gt2(O2) ? S2 = f : ft2(O2) ? S2 = E : c !== g && mt2(O2) ? S2 = c : S2 = g, w + S2 > C && (v = Math.min(v, Math.max(A, $) + F)), w + S2 > i) {
          y2 = true;
          break e;
        }
        F += M2.length, w += S2;
      }
      A = b = 0;
    }
    if (m >= d) break;
    if (ne.lastIndex = m, ne.test(e)) {
      if (F = ne.lastIndex - m, S2 = F * g, w + S2 > C && (v = Math.min(v, m + Math.floor((C - w) / g))), w + S2 > i) {
        y2 = true;
        break;
      }
      w += S2, A = $, b = m, m = $ = ne.lastIndex;
      continue;
    }
    if (we.lastIndex = m, we.test(e)) {
      if (w + u > C && (v = Math.min(v, m)), w + u > i) {
        y2 = true;
        break;
      }
      w += u, A = $, b = m, m = $ = we.lastIndex;
      continue;
    }
    if (re.lastIndex = m, re.test(e)) {
      if (F = re.lastIndex - m, S2 = F * l, w + S2 > C && (v = Math.min(v, m + Math.floor((C - w) / l))), w + S2 > i) {
        y2 = true;
        break;
      }
      w += S2, A = $, b = m, m = $ = re.lastIndex;
      continue;
    }
    if (ie.lastIndex = m, ie.test(e)) {
      if (F = ie.lastIndex - m, S2 = F * n, w + S2 > C && (v = Math.min(v, m + Math.floor((C - w) / n))), w + S2 > i) {
        y2 = true;
        break;
      }
      w += S2, A = $, b = m, m = $ = ie.lastIndex;
      continue;
    }
    if (Ae.lastIndex = m, Ae.test(e)) {
      if (w + p > C && (v = Math.min(v, m)), w + p > i) {
        y2 = true;
        break;
      }
      w += p, A = $, b = m, m = $ = Ae.lastIndex;
      continue;
    }
    m += 1;
  }
  return { width: y2 ? C : w, index: y2 ? v : d, truncated: y2, ellipsed: y2 && i >= o };
};
var Et2 = { limit: 1 / 0, ellipsis: "", ellipsisWidth: 0 };
var D2 = (e, r = {}) => Le(e, Et2, r).width;
var ae = "\x1B";
var je = "\x9B";
var vt2 = 39;
var Ce = "\x07";
var ke = "[";
var wt = "]";
var Ve = "m";
var Se = `${wt}8;;`;
var He = new RegExp(`(?:\\${ke}(?<code>\\d+)m|\\${Se}(?<uri>.*)${Ce})`, "y");
var At2 = (e) => {
  if (e >= 30 && e <= 37 || e >= 90 && e <= 97) return 39;
  if (e >= 40 && e <= 47 || e >= 100 && e <= 107) return 49;
  if (e === 1 || e === 2) return 22;
  if (e === 3) return 23;
  if (e === 4) return 24;
  if (e === 7) return 27;
  if (e === 8) return 28;
  if (e === 9) return 29;
  if (e === 0) return 0;
};
var Ue = (e) => `${ae}${ke}${e}${Ve}`;
var Ke = (e) => `${ae}${Se}${e}${Ce}`;
var Ct2 = (e) => e.map((r) => D2(r));
var Ie = (e, r, s) => {
  const i = r[Symbol.iterator]();
  let a = false, o = false, u = e.at(-1), l = u === void 0 ? 0 : D2(u), n = i.next(), c = i.next(), p = 0;
  for (; !n.done; ) {
    const f = n.value, g = D2(f);
    l + g <= s ? e[e.length - 1] += f : (e.push(f), l = 0), (f === ae || f === je) && (a = true, o = r.startsWith(Se, p + 1)), a ? o ? f === Ce && (a = false, o = false) : f === Ve && (a = false) : (l += g, l === s && !c.done && (e.push(""), l = 0)), n = c, c = i.next(), p += f.length;
  }
  u = e.at(-1), !l && u !== void 0 && u.length > 0 && e.length > 1 && (e[e.length - 2] += e.pop());
};
var St = (e) => {
  const r = e.split(" ");
  let s = r.length;
  for (; s > 0 && !(D2(r[s - 1]) > 0); ) s--;
  return s === r.length ? e : r.slice(0, s).join(" ") + r.slice(s).join("");
};
var It2 = (e, r, s = {}) => {
  if (s.trim !== false && e.trim() === "") return "";
  let i = "", a, o;
  const u = e.split(" "), l = Ct2(u);
  let n = [""];
  for (const [$, m] of u.entries()) {
    s.trim !== false && (n[n.length - 1] = (n.at(-1) ?? "").trimStart());
    let d = D2(n.at(-1) ?? "");
    if ($ !== 0 && (d >= r && (s.wordWrap === false || s.trim === false) && (n.push(""), d = 0), (d > 0 || s.trim === false) && (n[n.length - 1] += " ", d++)), s.hard && l[$] > r) {
      const F = r - d, y2 = 1 + Math.floor((l[$] - F - 1) / r);
      Math.floor((l[$] - 1) / r) < y2 && n.push(""), Ie(n, m, r);
      continue;
    }
    if (d + l[$] > r && d > 0 && l[$] > 0) {
      if (s.wordWrap === false && d < r) {
        Ie(n, m, r);
        continue;
      }
      n.push("");
    }
    if (d + l[$] > r && s.wordWrap === false) {
      Ie(n, m, r);
      continue;
    }
    n[n.length - 1] += m;
  }
  s.trim !== false && (n = n.map(($) => St($)));
  const c = n.join(`
`), p = c[Symbol.iterator]();
  let f = p.next(), g = p.next(), E = 0;
  for (; !f.done; ) {
    const $ = f.value, m = g.value;
    if (i += $, $ === ae || $ === je) {
      He.lastIndex = E + 1;
      const y2 = He.exec(c)?.groups;
      if (y2?.code !== void 0) {
        const v = Number.parseFloat(y2.code);
        a = v === vt2 ? void 0 : v;
      } else y2?.uri !== void 0 && (o = y2.uri.length === 0 ? void 0 : y2.uri);
    }
    const d = a ? At2(a) : void 0;
    m === `
` ? (o && (i += Ke("")), a && d && (i += Ue(d))) : $ === `
` && (a && d && (i += Ue(a)), o && (i += Ke(o))), E += $.length, f = g, g = p.next();
  }
  return i;
};
function J2(e, r, s) {
  return String(e).normalize().replaceAll(`\r
`, `
`).split(`
`).map((i) => It2(i, r, s)).join(`
`);
}
var bt2 = (e, r, s, i, a) => {
  let o = r, u = 0;
  for (let l = s; l < i; l++) {
    const n = e[l];
    if (o = o - n.length, u++, o <= a) break;
  }
  return { lineCount: o, removals: u };
};
var X2 = ({ cursor: e, options: r, style: s, output: i = process.stdout, maxItems: a = Number.POSITIVE_INFINITY, columnPadding: o = 0, rowPadding: u = 4 }) => {
  const l = rt(i) - o, n = nt(i), c = t("dim", "..."), p = Math.max(n - u, 0), f = Math.max(Math.min(a, p), 5);
  let g = 0;
  e >= f - 3 && (g = Math.max(Math.min(e - f + 3, r.length - f), 0));
  let E = f < r.length && g > 0, $ = f < r.length && g + f < r.length;
  const m = Math.min(g + f, r.length), d = [];
  let F = 0;
  E && F++, $ && F++;
  const y2 = g + (E ? 1 : 0), v = m - ($ ? 1 : 0);
  for (let A = y2; A < v; A++) {
    const b = J2(s(r[A], A === e), l, { hard: true, trim: false }).split(`
`);
    d.push(b), F += b.length;
  }
  if (F > p) {
    let A = 0, b = 0, w = F;
    const S2 = e - y2, T2 = (M2, O2) => bt2(d, w, M2, O2, p);
    E ? ({ lineCount: w, removals: A } = T2(0, S2), w > p && ({ lineCount: w, removals: b } = T2(S2 + 1, d.length))) : ({ lineCount: w, removals: b } = T2(S2 + 1, d.length), w > p && ({ lineCount: w, removals: A } = T2(0, S2))), A > 0 && (E = true, d.splice(0, A)), b > 0 && ($ = true, d.splice(d.length - b, b));
  }
  const C = [];
  E && C.push(c);
  for (const A of d) for (const b of A) C.push(b);
  return $ && C.push(c), C;
};
var Rt = (e) => {
  const r = e.active ?? "Yes", s = e.inactive ?? "No";
  return new kt({ active: r, inactive: s, signal: e.signal, input: e.input, output: e.output, initialValue: e.initialValue ?? true, render() {
    const i = e.withGuide ?? _.withGuide, a = `${i ? `${t("gray", h)}
` : ""}${W2(this.state)}  ${e.message}
`, o = this.value ? r : s;
    switch (this.state) {
      case "submit": {
        const u = i ? `${t("gray", h)}  ` : "";
        return `${a}${u}${t("dim", o)}`;
      }
      case "cancel": {
        const u = i ? `${t("gray", h)}  ` : "";
        return `${a}${u}${t(["strikethrough", "dim"], o)}${i ? `
${t("gray", h)}` : ""}`;
      }
      default: {
        const u = i ? `${t("cyan", h)}  ` : "", l = i ? t("cyan", x2) : "";
        return `${a}${u}${this.value ? `${t("green", z2)} ${r}` : `${t("dim", H2)} ${t("dim", r)}`}${e.vertical ? i ? `
${t("cyan", h)}  ` : `
` : ` ${t("dim", "/")} `}${this.value ? `${t("dim", H2)} ${t("dim", s)}` : `${t("green", z2)} ${s}`}
${l}
`;
      }
    }
  } }).prompt();
};
var R2 = { message: (e = [], { symbol: r = t("gray", h), secondarySymbol: s = t("gray", h), output: i = process.stdout, spacing: a = 1, withGuide: o } = {}) => {
  const u = [], l = o ?? _.withGuide, n = l ? s : "", c = l ? `${r}  ` : "", p = l ? `${s}  ` : "";
  for (let g = 0; g < a; g++) u.push(n);
  const f = Array.isArray(e) ? e : e.split(`
`);
  if (f.length > 0) {
    const [g, ...E] = f;
    g.length > 0 ? u.push(`${c}${g}`) : u.push(l ? r : "");
    for (const $ of E) $.length > 0 ? u.push(`${p}${$}`) : u.push(l ? s : "");
  }
  i.write(`${u.join(`
`)}
`);
}, info: (e, r) => {
  R2.message(e, { ...r, symbol: t("blue", fe) });
}, success: (e, r) => {
  R2.message(e, { ...r, symbol: t("green", Fe) });
}, step: (e, r) => {
  R2.message(e, { ...r, symbol: t("green", V) });
}, warn: (e, r) => {
  R2.message(e, { ...r, symbol: t("yellow", ye) });
}, warning: (e, r) => {
  R2.warn(e, r);
}, error: (e, r) => {
  R2.message(e, { ...r, symbol: t("red", Ee) });
} };
var Nt = (e = "", r) => {
  const s = r?.output ?? process.stdout, i = r?.withGuide ?? _.withGuide ? `${t("gray", x2)}  ` : "";
  s.write(`${i}${t("red", e)}

`);
};
var Wt2 = (e = "", r) => {
  const s = r?.output ?? process.stdout, i = r?.withGuide ?? _.withGuide ? `${t("gray", he)}  ` : "";
  s.write(`${i}${e}
`);
};
var Gt = (e = "", r) => {
  const s = r?.output ?? process.stdout, i = r?.withGuide ?? _.withGuide ? `${t("gray", h)}
${t("gray", x2)}  ` : "";
  s.write(`${i}${e}

`);
};
var Q2 = (e, r) => e.split(`
`).map((s) => r(s)).join(`
`);
var Lt2 = (e) => {
  const r = (i, a) => {
    const o = i.label ?? String(i.value);
    return a === "disabled" ? `${t("gray", q2)} ${Q2(o, (u) => t(["strikethrough", "gray"], u))}${i.hint ? ` ${t("dim", `(${i.hint ?? "disabled"})`)}` : ""}` : a === "active" ? `${t("cyan", te)} ${o}${i.hint ? ` ${t("dim", `(${i.hint})`)}` : ""}` : a === "selected" ? `${t("green", U2)} ${Q2(o, (u) => t("dim", u))}${i.hint ? ` ${t("dim", `(${i.hint})`)}` : ""}` : a === "cancelled" ? `${Q2(o, (u) => t(["strikethrough", "dim"], u))}` : a === "active-selected" ? `${t("green", U2)} ${o}${i.hint ? ` ${t("dim", `(${i.hint})`)}` : ""}` : a === "submitted" ? `${Q2(o, (u) => t("dim", u))}` : `${t("dim", q2)} ${Q2(o, (u) => t("dim", u))}`;
  }, s = e.required ?? true;
  return new Lt({ options: e.options, signal: e.signal, input: e.input, output: e.output, initialValues: e.initialValues, required: s, cursorAt: e.cursorAt, validate(i) {
    if (s && (i === void 0 || i.length === 0)) return `Please select at least one option.
${t("reset", t("dim", `Press ${t(["gray", "bgWhite", "inverse"], " space ")} to select, ${t("gray", t("bgWhite", t("inverse", " enter ")))} to submit`))}`;
  }, render() {
    const i = Bt(e.output, e.message, `${ve(this.state)}  `, `${W2(this.state)}  `), a = `${t("gray", h)}
${i}
`, o = this.value ?? [], u = (l, n) => {
      if (l.disabled) return r(l, "disabled");
      const c = o.includes(l.value);
      return n && c ? r(l, "active-selected") : c ? r(l, "selected") : r(l, n ? "active" : "inactive");
    };
    switch (this.state) {
      case "submit": {
        const l = this.options.filter(({ value: c }) => o.includes(c)).map((c) => r(c, "submitted")).join(t("dim", ", ")) || t("dim", "none"), n = Bt(e.output, l, `${t("gray", h)}  `);
        return `${a}${n}`;
      }
      case "cancel": {
        const l = this.options.filter(({ value: c }) => o.includes(c)).map((c) => r(c, "cancelled")).join(t("dim", ", "));
        if (l.trim() === "") return `${a}${t("gray", h)}`;
        const n = Bt(e.output, l, `${t("gray", h)}  `);
        return `${a}${n}
${t("gray", h)}`;
      }
      case "error": {
        const l = `${t("yellow", h)}  `, n = this.error.split(`
`).map((f, g) => g === 0 ? `${t("yellow", x2)}  ${t("yellow", f)}` : `   ${f}`).join(`
`), c = a.split(`
`).length, p = n.split(`
`).length + 1;
        return `${a}${l}${X2({ output: e.output, options: this.options, cursor: this.cursor, maxItems: e.maxItems, columnPadding: l.length, rowPadding: c + p, style: u }).join(`
${l}`)}
${n}
`;
      }
      default: {
        const l = `${t("cyan", h)}  `, n = a.split(`
`).length;
        return `${a}${l}${X2({ output: e.output, options: this.options, cursor: this.cursor, maxItems: e.maxItems, columnPadding: l.length, rowPadding: n + 2, style: u }).join(`
${l}`)}
${t("cyan", x2)}
`;
      }
    }
  } }).prompt();
};
var jt = (e) => t("dim", e);
var kt2 = (e, r, s) => {
  const i = { hard: true, trim: false }, a = J2(e, r, i).split(`
`), o = a.reduce((n, c) => Math.max(D2(c), n), 0), u = a.map(s).reduce((n, c) => Math.max(D2(c), n), 0), l = r - (u - o);
  return J2(e, l, i);
};
var Vt2 = (e = "", r = "", s) => {
  const i = s?.output ?? N2.stdout, a = s?.withGuide ?? _.withGuide, o = s?.format ?? jt, u = ["", ...kt2(e, rt(i) - 6, o).split(`
`).map(o), ""], l = D2(r), n = Math.max(u.reduce((g, E) => {
    const $ = D2(E);
    return $ > g ? $ : g;
  }, 0), l) + 2, c = u.map((g) => `${t("gray", h)}  ${g}${" ".repeat(n - D2(g))}${t("gray", h)}`).join(`
`), p = a ? `${t("gray", h)}
` : "", f = a ? We : ge;
  i.write(`${p}${t("green", V)}  ${t("reset", r)} ${t("gray", se.repeat(Math.max(n - l - 1, 1)) + pe)}
${c}
${t("gray", f + se.repeat(n + 2) + me)}
`);
};
var Ht = (e) => new Mt({ validate: e.validate, mask: e.mask ?? Ne, signal: e.signal, input: e.input, output: e.output, render() {
  const r = e.withGuide ?? _.withGuide, s = `${r ? `${t("gray", h)}
` : ""}${W2(this.state)}  ${e.message}
`, i = this.userInputWithCursor, a = this.masked;
  switch (this.state) {
    case "error": {
      const o = r ? `${t("yellow", h)}  ` : "", u = r ? `${t("yellow", x2)}  ` : "", l = a ?? "";
      return e.clearOnError && this.clear(), `${s.trim()}
${o}${l}
${u}${t("yellow", this.error)}
`;
    }
    case "submit": {
      const o = r ? `${t("gray", h)}  ` : "", u = a ? t("dim", a) : "";
      return `${s}${o}${u}`;
    }
    case "cancel": {
      const o = r ? `${t("gray", h)}  ` : "", u = a ? t(["strikethrough", "dim"], a) : "";
      return `${s}${o}${u}${a && r ? `
${t("gray", h)}` : ""}`;
    }
    default: {
      const o = r ? `${t("cyan", h)}  ` : "", u = r ? t("cyan", x2) : "";
      return `${s}${o}${i}
${u}
`;
    }
  }
} }).prompt();
var Kt = (e) => t("magenta", e);
var be = ({ indicator: e = "dots", onCancel: r, output: s = process.stdout, cancelMessage: i, errorMessage: a, frames: o = ee ? ["\u25D2", "\u25D0", "\u25D3", "\u25D1"] : ["\u2022", "o", "O", "0"], delay: u = ee ? 80 : 120, signal: l, ...n } = {}) => {
  const c = ce();
  let p, f, g = false, E = false, $ = "", m, d = performance.now();
  const F = rt(s), y2 = n?.styleFrame ?? Kt, v = (B2) => {
    const P2 = B2 > 1 ? a ?? _.messages.error : i ?? _.messages.cancel;
    E = B2 === 1, g && (k2(P2, B2), E && typeof r == "function" && r());
  }, C = () => v(2), A = () => v(1), b = () => {
    process.on("uncaughtExceptionMonitor", C), process.on("unhandledRejection", C), process.on("SIGINT", A), process.on("SIGTERM", A), process.on("exit", v), l && l.addEventListener("abort", A);
  }, w = () => {
    process.removeListener("uncaughtExceptionMonitor", C), process.removeListener("unhandledRejection", C), process.removeListener("SIGINT", A), process.removeListener("SIGTERM", A), process.removeListener("exit", v), l && l.removeEventListener("abort", A);
  }, S2 = () => {
    if (m === void 0) return;
    c && s.write(`
`);
    const B2 = J2(m, F, { hard: true, trim: false }).split(`
`);
    B2.length > 1 && s.write(import_sisteransi2.cursor.up(B2.length - 1)), s.write(import_sisteransi2.cursor.to(0)), s.write(import_sisteransi2.erase.down());
  }, T2 = (B2) => B2.replace(/\.+$/, ""), M2 = (B2) => {
    const P2 = (performance.now() - B2) / 1e3, G2 = Math.floor(P2 / 60), L2 = Math.floor(P2 % 60);
    return G2 > 0 ? `[${G2}m ${L2}s]` : `[${L2}s]`;
  }, O2 = n.withGuide ?? _.withGuide, le = (B2 = "") => {
    g = true, p = xt({ output: s }), $ = T2(B2), d = performance.now(), O2 && s.write(`${t("gray", h)}
`);
    let P2 = 0, G2 = 0;
    b(), f = setInterval(() => {
      if (c && $ === m) return;
      S2(), m = $;
      const L2 = y2(o[P2]);
      let Z2;
      if (c) Z2 = `${L2}  ${$}...`;
      else if (e === "timer") Z2 = `${L2}  ${$} ${M2(d)}`;
      else {
        const et2 = ".".repeat(Math.floor(G2)).slice(0, 3);
        Z2 = `${L2}  ${$}${et2}`;
      }
      const Ze = J2(Z2, F, { hard: true, trim: false });
      s.write(Ze), P2 = P2 + 1 < o.length ? P2 + 1 : 0, G2 = G2 < 4 ? G2 + 0.125 : 0;
    }, u);
  }, k2 = (B2 = "", P2 = 0, G2 = false) => {
    if (!g) return;
    g = false, clearInterval(f), S2();
    const L2 = P2 === 0 ? t("green", V) : P2 === 1 ? t("red", $e) : t("red", de);
    $ = B2 ?? $, G2 || (e === "timer" ? s.write(`${L2}  ${$} ${M2(d)}
`) : s.write(`${L2}  ${$}
`)), w(), p();
  };
  return { start: le, stop: (B2 = "") => k2(B2, 0), message: (B2 = "") => {
    $ = T2(B2 ?? $);
  }, cancel: (B2 = "") => k2(B2, 1), error: (B2 = "") => k2(B2, 2), clear: () => k2("", 0, true), get isCancelled() {
    return E;
  } };
};
var ze = { light: I2("\u2500", "-"), heavy: I2("\u2501", "="), block: I2("\u2588", "#") };
var oe = (e, r) => e.includes(`
`) ? e.split(`
`).map((s) => r(s)).join(`
`) : r(e);
var Jt = (e) => {
  const r = (s, i) => {
    const a = s.label ?? String(s.value);
    switch (i) {
      case "disabled":
        return `${t("gray", H2)} ${oe(a, (o) => t("gray", o))}${s.hint ? ` ${t("dim", `(${s.hint ?? "disabled"})`)}` : ""}`;
      case "selected":
        return `${oe(a, (o) => t("dim", o))}`;
      case "active":
        return `${t("green", z2)} ${a}${s.hint ? ` ${t("dim", `(${s.hint})`)}` : ""}`;
      case "cancelled":
        return `${oe(a, (o) => t(["strikethrough", "dim"], o))}`;
      default:
        return `${t("dim", H2)} ${oe(a, (o) => t("dim", o))}`;
    }
  };
  return new Tt({ options: e.options, signal: e.signal, input: e.input, output: e.output, initialValue: e.initialValue, render() {
    const s = e.withGuide ?? _.withGuide, i = `${W2(this.state)}  `, a = `${ve(this.state)}  `, o = Bt(e.output, e.message, a, i), u = `${s ? `${t("gray", h)}
` : ""}${o}
`;
    switch (this.state) {
      case "submit": {
        const l = s ? `${t("gray", h)}  ` : "", n = Bt(e.output, r(this.options[this.cursor], "selected"), l);
        return `${u}${n}`;
      }
      case "cancel": {
        const l = s ? `${t("gray", h)}  ` : "", n = Bt(e.output, r(this.options[this.cursor], "cancelled"), l);
        return `${u}${n}${s ? `
${t("gray", h)}` : ""}`;
      }
      default: {
        const l = s ? `${t("cyan", h)}  ` : "", n = s ? t("cyan", x2) : "", c = u.split(`
`).length, p = s ? 2 : 1;
        return `${u}${l}${X2({ output: e.output, cursor: this.cursor, options: this.options, maxItems: e.maxItems, columnPadding: l.length, rowPadding: c + p, style: (f, g) => r(f, f.disabled ? "disabled" : g ? "active" : "inactive") }).join(`
${l}`)}
${n}
`;
      }
    }
  } }).prompt();
};
var Qe = `${t("gray", h)}  `;
var Yt = async (e, r) => {
  for (const s of e) {
    if (s.enabled === false) continue;
    const i = be(r);
    i.start(s.title);
    const a = await s.task(i.message);
    i.stop(a || s.title);
  }
};
var Zt = (e) => new $t({ validate: e.validate, placeholder: e.placeholder, defaultValue: e.defaultValue, initialValue: e.initialValue, output: e.output, signal: e.signal, input: e.input, render() {
  const r = e?.withGuide ?? _.withGuide, s = `${`${r ? `${t("gray", h)}
` : ""}${W2(this.state)}  `}${e.message}
`, i = e.placeholder ? t("inverse", e.placeholder[0]) + t("dim", e.placeholder.slice(1)) : t(["inverse", "hidden"], "_"), a = this.userInput ? this.userInputWithCursor : i, o = this.value ?? "";
  switch (this.state) {
    case "error": {
      const u = this.error ? `  ${t("yellow", this.error)}` : "", l = r ? `${t("yellow", h)}  ` : "", n = r ? t("yellow", x2) : "";
      return `${s.trim()}
${l}${a}
${n}${u}
`;
    }
    case "submit": {
      const u = o ? `  ${t("dim", o)}` : "", l = r ? t("gray", h) : "";
      return `${s}${l}${u}`;
    }
    case "cancel": {
      const u = o ? `  ${t(["strikethrough", "dim"], o)}` : "", l = r ? t("gray", h) : "";
      return `${s}${l}${u}${o.trim() ? `
${l}` : ""}`;
    }
    default: {
      const u = r ? `${t("cyan", h)}  ` : "", l = r ? t("cyan", x2) : "";
      return `${s}${u}${a}
${l}
`;
    }
  }
} }).prompt();

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
    const isWindows = process.platform === "win32";
    const checkCmd = isWindows ? "where" : "which";
    execSync(`${checkCmd} ${command}`, { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}
function runCommand(command, args = []) {
  try {
    const fullCommand = [command, ...args].join(" ");
    const stdout = execSync(fullCommand, { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] });
    return { stdout: stdout.trim(), stderr: "", exitCode: 0 };
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
  Wt2(import_picocolors.default.bgCyan(import_picocolors.default.black(" claude-mem installer ")));
  R2.info(`Version: 1.0.0`);
  R2.info(`Platform: ${process.platform} (${process.arch})`);
  const settingsExist = existsSync(expandHome("~/.claude-mem/settings.json"));
  const pluginExist = existsSync(expandHome("~/.claude/plugins/marketplaces/thedotmack/"));
  const alreadyInstalled = settingsExist && pluginExist;
  if (alreadyInstalled) {
    R2.warn("Existing claude-mem installation detected.");
  }
  const installMode = await Jt({
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
  if (Ct(installMode)) {
    Nt("Installation cancelled.");
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
    const isWindows = detectOS() === "windows";
    const checkCmd = isWindows ? "where" : "which";
    const result = runCommand(checkCmd, [name]);
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
  for (let i = 0; i < Math.max(currentParts.length, minimumParts.length); i++) {
    const a = currentParts[i] || 0;
    const b = minimumParts[i] || 0;
    if (a > b) return true;
    if (a < b) return false;
  }
  return true;
}
function installBun() {
  const os = detectOS();
  if (os === "windows") {
    execSync2('powershell -Command "iex \\"& {$(irm https://bun.com/install.ps1)} -Version 1.3.3\\""', { stdio: "inherit" });
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
  await Yt([
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
    R2.error("git is required but not found.");
    if (os === "macos") {
      R2.info("Install with: xcode-select --install");
    } else if (os === "linux") {
      R2.info("Install with: sudo apt install git (or your distro equivalent)");
    } else {
      R2.info("Download from: https://git-scm.com/downloads");
    }
    Nt("Please install git and try again.");
    process.exit(1);
  }
  if (!status.nodeOk) {
    R2.error(`Node.js >= 18.0.0 is required. Current: ${process.version}`);
    Nt("Please upgrade Node.js and try again.");
    process.exit(1);
  }
  if (!status.bunOk) {
    const shouldInstall = await Rt({
      message: "Bun is required but not found. Install it now?",
      initialValue: true
    });
    if (Ct(shouldInstall)) {
      Nt("Installation cancelled.");
      process.exit(0);
    }
    if (shouldInstall) {
      const s = be();
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
        const os = detectOS();
        const installCmd = os === "windows" ? 'iex "& {$(irm https://bun.com/install.ps1)} -Version 1.3.3"' : "curl -fsSL https://bun.sh/install | bash";
        s.stop(`Bun installation failed. Install manually: ${installCmd}`);
      }
    } else {
      const os = detectOS();
      const installCmd = os === "windows" ? 'iex "& {$(irm https://bun.com/install.ps1)} -Version 1.3.3"' : "curl -fsSL https://bun.sh/install | bash";
      R2.warn(`Bun is required for claude-mem. Install manually: ${installCmd}`);
      Nt("Cannot continue without Bun.");
      process.exit(1);
    }
  }
  if (!status.uvOk) {
    const shouldInstall = await Rt({
      message: "uv (Python package manager) is recommended for Chroma. Install it now?",
      initialValue: true
    });
    if (Ct(shouldInstall)) {
      Nt("Installation cancelled.");
      process.exit(0);
    }
    if (shouldInstall) {
      const s = be();
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
        const os = detectOS();
        const installCmd = os === "windows" ? "irm https://astral.sh/uv/install.ps1 | iex" : "curl -fsSL https://astral.sh/uv/install.sh | sh";
        s.stop(`uv installation failed. Install manually: ${installCmd}`);
      }
    } else {
      R2.warn("Skipping uv \u2014 Chroma vector search will not be available.");
    }
  }
  return status;
}

// src/steps/ide-selection.ts
async function runIdeSelection() {
  const result = await Lt2({
    message: "Which IDEs do you use?",
    options: [
      { value: "claude-code", label: "Claude Code", hint: "recommended" },
      { value: "cursor", label: "Cursor" }
      // Windsurf coming soon - not yet selectable
    ],
    initialValues: ["claude-code"],
    required: true
  });
  if (Ct(result)) {
    Nt("Installation cancelled.");
    process.exit(0);
  }
  const selectedIDEs = result;
  if (selectedIDEs.includes("claude-code")) {
    R2.info("Claude Code: Plugin will be registered via marketplace.");
  }
  if (selectedIDEs.includes("cursor")) {
    R2.info("Cursor: Hooks will be configured for your projects.");
  }
  return selectedIDEs;
}

// src/steps/provider.ts
async function runProviderConfiguration() {
  const provider = await Jt({
    message: "Which AI provider should claude-mem use for memory compression?",
    options: [
      { value: "claude", label: "Claude", hint: "uses your Claude subscription" },
      { value: "gemini", label: "Gemini", hint: "free tier available" },
      { value: "openrouter", label: "OpenRouter", hint: "free models available" }
    ]
  });
  if (Ct(provider)) {
    Nt("Installation cancelled.");
    process.exit(0);
  }
  const config = { provider };
  if (provider === "claude") {
    const authMethod = await Jt({
      message: "How should Claude authenticate?",
      options: [
        { value: "cli", label: "CLI (Max Plan subscription)", hint: "no API key needed" },
        { value: "api", label: "API Key", hint: "uses Anthropic API credits" }
      ]
    });
    if (Ct(authMethod)) {
      Nt("Installation cancelled.");
      process.exit(0);
    }
    config.claudeAuthMethod = authMethod;
    if (authMethod === "api") {
      const apiKey = await Ht({
        message: "Enter your Anthropic API key:",
        validate: (value) => {
          if (!value || value.trim().length === 0) return "API key is required";
          if (!value.startsWith("sk-ant-")) return "Anthropic API keys start with sk-ant-";
        }
      });
      if (Ct(apiKey)) {
        Nt("Installation cancelled.");
        process.exit(0);
      }
      config.apiKey = apiKey;
    }
  }
  if (provider === "gemini") {
    const apiKey = await Ht({
      message: "Enter your Gemini API key:",
      validate: (value) => {
        if (!value || value.trim().length === 0) return "API key is required";
      }
    });
    if (Ct(apiKey)) {
      Nt("Installation cancelled.");
      process.exit(0);
    }
    config.apiKey = apiKey;
    const model = await Jt({
      message: "Which Gemini model?",
      options: [
        { value: "gemini-2.5-flash-lite", label: "Gemini 2.5 Flash Lite", hint: "fastest, highest free RPM" },
        { value: "gemini-2.5-flash", label: "Gemini 2.5 Flash", hint: "balanced" },
        { value: "gemini-3-flash-preview", label: "Gemini 3 Flash Preview", hint: "latest" }
      ]
    });
    if (Ct(model)) {
      Nt("Installation cancelled.");
      process.exit(0);
    }
    config.model = model;
    const rateLimiting = await Rt({
      message: "Enable rate limiting? (recommended for free tier)",
      initialValue: true
    });
    if (Ct(rateLimiting)) {
      Nt("Installation cancelled.");
      process.exit(0);
    }
    config.rateLimitingEnabled = rateLimiting;
  }
  if (provider === "openrouter") {
    const apiKey = await Ht({
      message: "Enter your OpenRouter API key:",
      validate: (value) => {
        if (!value || value.trim().length === 0) return "API key is required";
      }
    });
    if (Ct(apiKey)) {
      Nt("Installation cancelled.");
      process.exit(0);
    }
    config.apiKey = apiKey;
    const model = await Zt({
      message: "Which OpenRouter model?",
      defaultValue: "xiaomi/mimo-v2-flash:free",
      placeholder: "xiaomi/mimo-v2-flash:free"
    });
    if (Ct(model)) {
      Nt("Installation cancelled.");
      process.exit(0);
    }
    config.model = model;
  }
  return config;
}

// src/steps/settings.ts
var import_picocolors3 = __toESM(require_picocolors(), 1);
async function runSettingsConfiguration() {
  const useDefaults = await Rt({
    message: "Use default settings? (recommended for most users)",
    initialValue: true
  });
  if (Ct(useDefaults)) {
    Nt("Installation cancelled.");
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
  const workerPort = await Zt({
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
  if (Ct(workerPort)) {
    Nt("Installation cancelled.");
    process.exit(0);
  }
  const dataDir = await Zt({
    message: "Data directory:",
    defaultValue: "~/.claude-mem",
    placeholder: "~/.claude-mem"
  });
  if (Ct(dataDir)) {
    Nt("Installation cancelled.");
    process.exit(0);
  }
  const contextObservations = await Zt({
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
  if (Ct(contextObservations)) {
    Nt("Installation cancelled.");
    process.exit(0);
  }
  const logLevel = await Jt({
    message: "Log level:",
    options: [
      { value: "DEBUG", label: "DEBUG", hint: "verbose" },
      { value: "INFO", label: "INFO", hint: "default" },
      { value: "WARN", label: "WARN" },
      { value: "ERROR", label: "ERROR", hint: "errors only" }
    ],
    initialValue: "INFO"
  });
  if (Ct(logLevel)) {
    Nt("Installation cancelled.");
    process.exit(0);
  }
  const pythonVersion = await Zt({
    message: "Python version (for Chroma):",
    defaultValue: "3.13",
    placeholder: "3.13"
  });
  if (Ct(pythonVersion)) {
    Nt("Installation cancelled.");
    process.exit(0);
  }
  const chromaEnabled = await Rt({
    message: "Enable Chroma vector search?",
    initialValue: true
  });
  if (Ct(chromaEnabled)) {
    Nt("Installation cancelled.");
    process.exit(0);
  }
  let chromaMode;
  let chromaHost;
  let chromaPort;
  let chromaSsl;
  if (chromaEnabled) {
    const mode = await Jt({
      message: "Chroma mode:",
      options: [
        { value: "local", label: "Local", hint: "starts local Chroma server" },
        { value: "remote", label: "Remote", hint: "connect to existing server" }
      ]
    });
    if (Ct(mode)) {
      Nt("Installation cancelled.");
      process.exit(0);
    }
    chromaMode = mode;
    if (mode === "remote") {
      const host = await Zt({
        message: "Chroma host:",
        defaultValue: "127.0.0.1",
        placeholder: "127.0.0.1"
      });
      if (Ct(host)) {
        Nt("Installation cancelled.");
        process.exit(0);
      }
      chromaHost = host;
      const port = await Zt({
        message: "Chroma port:",
        defaultValue: "8000",
        placeholder: "8000",
        validate: (value = "") => {
          const portNum = parseInt(value, 10);
          if (isNaN(portNum) || portNum < 1 || portNum > 65535) return "Port must be between 1 and 65535";
        }
      });
      if (Ct(port)) {
        Nt("Installation cancelled.");
        process.exit(0);
      }
      chromaPort = port;
      const ssl = await Rt({
        message: "Use SSL for Chroma connection?",
        initialValue: false
      });
      if (Ct(ssl)) {
        Nt("Installation cancelled.");
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
  Vt2(summaryLines.join("\n"), "Settings Summary");
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
  const settings = {
    CLAUDE_MEM_WORKER_PORT: settingsConfig.workerPort,
    CLAUDE_MEM_WORKER_HOST: "127.0.0.1",
    CLAUDE_MEM_DATA_DIR: expandDataDir(settingsConfig.dataDir),
    CLAUDE_MEM_CONTEXT_OBSERVATIONS: settingsConfig.contextObservations,
    CLAUDE_MEM_LOG_LEVEL: settingsConfig.logLevel,
    CLAUDE_MEM_PYTHON_VERSION: settingsConfig.pythonVersion,
    CLAUDE_MEM_PROVIDER: providerConfig.provider
  };
  if (providerConfig.provider === "claude") {
    settings.CLAUDE_MEM_CLAUDE_AUTH_METHOD = providerConfig.claudeAuthMethod ?? "cli";
  }
  if (providerConfig.provider === "gemini") {
    if (providerConfig.apiKey) settings.CLAUDE_MEM_GEMINI_API_KEY = providerConfig.apiKey;
    if (providerConfig.model) settings.CLAUDE_MEM_GEMINI_MODEL = providerConfig.model;
    settings.CLAUDE_MEM_GEMINI_RATE_LIMITING_ENABLED = providerConfig.rateLimitingEnabled !== false ? "true" : "false";
  }
  if (providerConfig.provider === "openrouter") {
    if (providerConfig.apiKey) settings.CLAUDE_MEM_OPENROUTER_API_KEY = providerConfig.apiKey;
    if (providerConfig.model) settings.CLAUDE_MEM_OPENROUTER_MODEL = providerConfig.model;
  }
  if (settingsConfig.chromaEnabled) {
    settings.CLAUDE_MEM_CHROMA_MODE = settingsConfig.chromaMode ?? "local";
    if (settingsConfig.chromaMode === "remote") {
      if (settingsConfig.chromaHost) settings.CLAUDE_MEM_CHROMA_HOST = settingsConfig.chromaHost;
      if (settingsConfig.chromaPort) settings.CLAUDE_MEM_CHROMA_PORT = settingsConfig.chromaPort;
      if (settingsConfig.chromaSsl !== void 0) settings.CLAUDE_MEM_CHROMA_SSL = String(settingsConfig.chromaSsl);
    }
  }
  return settings;
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
import { existsSync as existsSync4, mkdirSync as mkdirSync2, readFileSync as readFileSync2, writeFileSync as writeFileSync2, cpSync, rmSync, readdirSync } from "fs";
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
function copyDirWithExclusions(src, dest, excludes) {
  ensureDir(dest);
  const existing = readdirSync(dest);
  for (const file of existing) {
    const path = join3(dest, file);
    rmSync(path, { recursive: true, force: true });
  }
  function copyRecursive(srcPath, destPath) {
    ensureDir(destPath);
    const items = readdirSync(srcPath, { withFileTypes: true });
    for (const item of items) {
      if (excludes.includes(item.name)) continue;
      const srcItem = join3(srcPath, item.name);
      const destItem = join3(destPath, item.name);
      if (item.isDirectory()) {
        copyRecursive(srcItem, destItem);
      } else {
        cpSync(srcItem, destItem);
      }
    }
  }
  copyRecursive(src, dest);
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
  const settings = readJsonFile(CLAUDE_SETTINGS_PATH);
  if (!settings.enabledPlugins) settings.enabledPlugins = {};
  settings.enabledPlugins["claude-mem@thedotmack"] = true;
  writeJsonFile(CLAUDE_SETTINGS_PATH, settings);
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
  await Yt([
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
        copyDirWithExclusions(tempDir, MARKETPLACE_DIR, [".git", "package-lock.json", "bun.lock"]);
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
    rmSync(tempDir, { recursive: true, force: true });
  } catch {
  }
  if (selectedIDEs.includes("cursor")) {
    R2.info("Cursor hook configuration will be available after first launch.");
    R2.info("Run: claude-mem cursor-setup (coming soon)");
  }
}
async function runUninstall() {
  const confirm = await Rt({
    message: "Are you sure you want to uninstall claude-mem? This action cannot be undone.",
    initialValue: false
  });
  if (Ct(confirm) || !confirm) {
    Nt("Uninstall cancelled.");
    return;
  }
  await Yt([
    {
      title: "Disabling plugin",
      task: async (message) => {
        message("Removing from Claude Code...");
        const settings = readJsonFile(CLAUDE_SETTINGS_PATH);
        if (settings.enabledPlugins) {
          delete settings.enabledPlugins["claude-mem@thedotmack"];
        }
        writeJsonFile(CLAUDE_SETTINGS_PATH, settings);
        return `Plugin disabled ${import_picocolors4.default.green("OK")}`;
      }
    },
    {
      title: "Removing plugin files",
      task: async (message) => {
        message("Cleaning up marketplace directory...");
        if (existsSync4(MARKETPLACE_DIR)) {
          rmSync(MARKETPLACE_DIR, { recursive: true, force: true });
        }
        return `Plugin files removed ${import_picocolors4.default.green("OK")}`;
      }
    },
    {
      title: "Removing plugin cache",
      task: async (message) => {
        message("Cleaning up cache...");
        const pluginCacheDir = join3(PLUGINS_DIR, "cache", "thedotmack", "claude-mem");
        if (existsSync4(pluginCacheDir)) {
          rmSync(pluginCacheDir, { recursive: true, force: true });
        }
        return `Cache cleaned ${import_picocolors4.default.green("OK")}`;
      }
    },
    {
      title: "Removing plugin registration",
      task: async (message) => {
        message("Unregistering from Claude Code...");
        const installedPluginsPath = join3(PLUGINS_DIR, "installed_plugins.json");
        const installedPlugins = readJsonFile(installedPluginsPath);
        if (installedPlugins.plugins) {
          delete installedPlugins.plugins["claude-mem@thedotmack"];
        }
        writeJsonFile(installedPluginsPath, installedPlugins);
        return `Plugin unregistered ${import_picocolors4.default.green("OK")}`;
      }
    }
  ]);
  Gt(import_picocolors4.default.green("\u2713 claude-mem has been uninstalled successfully."));
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
    R2.error("Bun is required to start the worker but was not found.");
    R2.info("Install Bun: curl -fsSL https://bun.sh/install | bash");
    return;
  }
  const workerScript = join4(MARKETPLACE_DIR2, "plugin", "scripts", "worker-service.cjs");
  const expandedDataDir = expandHome(dataDir);
  const logPath = join4(expandedDataDir, "logs");
  const s = be();
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
    R2.warn("Health check timed out. The worker might need more time to initialize.");
    R2.info(`Check status: curl http://127.0.0.1:${workerPort}/api/health`);
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
  Vt2(summaryLines.join("\n"), "Configuration Summary");
  const nextStepsLines = [];
  if (selectedIDEs.includes("claude-code")) {
    nextStepsLines.push("Open Claude Code and start a conversation \u2014 memory is automatic!");
  }
  if (selectedIDEs.includes("cursor")) {
    nextStepsLines.push("Open Cursor \u2014 hooks are active in your projects.");
  }
  nextStepsLines.push(`View your memories: ${import_picocolors6.default.underline(`http://localhost:${settingsConfig.workerPort}`)}`);
  nextStepsLines.push(`Search past work: use ${import_picocolors6.default.bold("/mem-search")} in Claude Code`);
  Vt2(nextStepsLines.join("\n"), "Next Steps");
  Gt(import_picocolors6.default.green("claude-mem installed successfully!"));
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
    process.exit(0);
  }
  await runDependencyChecks();
  const selectedIDEs = await runIdeSelection();
  const providerConfig = await runProviderConfiguration();
  const settingsConfig = await runSettingsConfiguration();
  writeSettings(providerConfig, settingsConfig);
  R2.success("Settings saved.");
  if (installMode !== "configure") {
    await runInstallation(selectedIDEs);
    await runWorkerStartup(settingsConfig.workerPort, settingsConfig.dataDir);
  }
  runCompletion(providerConfig, settingsConfig, selectedIDEs);
}
runInstaller().catch((error) => {
  Nt("Installation failed.");
  console.error(error);
  process.exit(1);
});
