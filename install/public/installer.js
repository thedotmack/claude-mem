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

// node_modules/@clack/core/dist/index.mjs
var import_picocolors = __toESM(require_picocolors(), 1);
var import_sisteransi = __toESM(require_src(), 1);
import { stdout as R, stdin as q } from "node:process";
import * as k from "node:readline";
import ot from "node:readline";
import { ReadStream as J } from "node:tty";
function B(t, e2, s) {
  if (!s.some((u) => !u.disabled)) return t;
  const i = t + e2, r = Math.max(s.length - 1, 0), n = i < 0 ? r : i > r ? 0 : i;
  return s[n].disabled ? B(n, e2 < 0 ? -1 : 1, s) : n;
}
var at = (t) => t === 161 || t === 164 || t === 167 || t === 168 || t === 170 || t === 173 || t === 174 || t >= 176 && t <= 180 || t >= 182 && t <= 186 || t >= 188 && t <= 191 || t === 198 || t === 208 || t === 215 || t === 216 || t >= 222 && t <= 225 || t === 230 || t >= 232 && t <= 234 || t === 236 || t === 237 || t === 240 || t === 242 || t === 243 || t >= 247 && t <= 250 || t === 252 || t === 254 || t === 257 || t === 273 || t === 275 || t === 283 || t === 294 || t === 295 || t === 299 || t >= 305 && t <= 307 || t === 312 || t >= 319 && t <= 322 || t === 324 || t >= 328 && t <= 331 || t === 333 || t === 338 || t === 339 || t === 358 || t === 359 || t === 363 || t === 462 || t === 464 || t === 466 || t === 468 || t === 470 || t === 472 || t === 474 || t === 476 || t === 593 || t === 609 || t === 708 || t === 711 || t >= 713 && t <= 715 || t === 717 || t === 720 || t >= 728 && t <= 731 || t === 733 || t === 735 || t >= 768 && t <= 879 || t >= 913 && t <= 929 || t >= 931 && t <= 937 || t >= 945 && t <= 961 || t >= 963 && t <= 969 || t === 1025 || t >= 1040 && t <= 1103 || t === 1105 || t === 8208 || t >= 8211 && t <= 8214 || t === 8216 || t === 8217 || t === 8220 || t === 8221 || t >= 8224 && t <= 8226 || t >= 8228 && t <= 8231 || t === 8240 || t === 8242 || t === 8243 || t === 8245 || t === 8251 || t === 8254 || t === 8308 || t === 8319 || t >= 8321 && t <= 8324 || t === 8364 || t === 8451 || t === 8453 || t === 8457 || t === 8467 || t === 8470 || t === 8481 || t === 8482 || t === 8486 || t === 8491 || t === 8531 || t === 8532 || t >= 8539 && t <= 8542 || t >= 8544 && t <= 8555 || t >= 8560 && t <= 8569 || t === 8585 || t >= 8592 && t <= 8601 || t === 8632 || t === 8633 || t === 8658 || t === 8660 || t === 8679 || t === 8704 || t === 8706 || t === 8707 || t === 8711 || t === 8712 || t === 8715 || t === 8719 || t === 8721 || t === 8725 || t === 8730 || t >= 8733 && t <= 8736 || t === 8739 || t === 8741 || t >= 8743 && t <= 8748 || t === 8750 || t >= 8756 && t <= 8759 || t === 8764 || t === 8765 || t === 8776 || t === 8780 || t === 8786 || t === 8800 || t === 8801 || t >= 8804 && t <= 8807 || t === 8810 || t === 8811 || t === 8814 || t === 8815 || t === 8834 || t === 8835 || t === 8838 || t === 8839 || t === 8853 || t === 8857 || t === 8869 || t === 8895 || t === 8978 || t >= 9312 && t <= 9449 || t >= 9451 && t <= 9547 || t >= 9552 && t <= 9587 || t >= 9600 && t <= 9615 || t >= 9618 && t <= 9621 || t === 9632 || t === 9633 || t >= 9635 && t <= 9641 || t === 9650 || t === 9651 || t === 9654 || t === 9655 || t === 9660 || t === 9661 || t === 9664 || t === 9665 || t >= 9670 && t <= 9672 || t === 9675 || t >= 9678 && t <= 9681 || t >= 9698 && t <= 9701 || t === 9711 || t === 9733 || t === 9734 || t === 9737 || t === 9742 || t === 9743 || t === 9756 || t === 9758 || t === 9792 || t === 9794 || t === 9824 || t === 9825 || t >= 9827 && t <= 9829 || t >= 9831 && t <= 9834 || t === 9836 || t === 9837 || t === 9839 || t === 9886 || t === 9887 || t === 9919 || t >= 9926 && t <= 9933 || t >= 9935 && t <= 9939 || t >= 9941 && t <= 9953 || t === 9955 || t === 9960 || t === 9961 || t >= 9963 && t <= 9969 || t === 9972 || t >= 9974 && t <= 9977 || t === 9979 || t === 9980 || t === 9982 || t === 9983 || t === 10045 || t >= 10102 && t <= 10111 || t >= 11094 && t <= 11097 || t >= 12872 && t <= 12879 || t >= 57344 && t <= 63743 || t >= 65024 && t <= 65039 || t === 65533 || t >= 127232 && t <= 127242 || t >= 127248 && t <= 127277 || t >= 127280 && t <= 127337 || t >= 127344 && t <= 127373 || t === 127375 || t === 127376 || t >= 127387 && t <= 127404 || t >= 917760 && t <= 917999 || t >= 983040 && t <= 1048573 || t >= 1048576 && t <= 1114109;
var lt = (t) => t === 12288 || t >= 65281 && t <= 65376 || t >= 65504 && t <= 65510;
var ht = (t) => t >= 4352 && t <= 4447 || t === 8986 || t === 8987 || t === 9001 || t === 9002 || t >= 9193 && t <= 9196 || t === 9200 || t === 9203 || t === 9725 || t === 9726 || t === 9748 || t === 9749 || t >= 9800 && t <= 9811 || t === 9855 || t === 9875 || t === 9889 || t === 9898 || t === 9899 || t === 9917 || t === 9918 || t === 9924 || t === 9925 || t === 9934 || t === 9940 || t === 9962 || t === 9970 || t === 9971 || t === 9973 || t === 9978 || t === 9981 || t === 9989 || t === 9994 || t === 9995 || t === 10024 || t === 10060 || t === 10062 || t >= 10067 && t <= 10069 || t === 10071 || t >= 10133 && t <= 10135 || t === 10160 || t === 10175 || t === 11035 || t === 11036 || t === 11088 || t === 11093 || t >= 11904 && t <= 11929 || t >= 11931 && t <= 12019 || t >= 12032 && t <= 12245 || t >= 12272 && t <= 12287 || t >= 12289 && t <= 12350 || t >= 12353 && t <= 12438 || t >= 12441 && t <= 12543 || t >= 12549 && t <= 12591 || t >= 12593 && t <= 12686 || t >= 12688 && t <= 12771 || t >= 12783 && t <= 12830 || t >= 12832 && t <= 12871 || t >= 12880 && t <= 19903 || t >= 19968 && t <= 42124 || t >= 42128 && t <= 42182 || t >= 43360 && t <= 43388 || t >= 44032 && t <= 55203 || t >= 63744 && t <= 64255 || t >= 65040 && t <= 65049 || t >= 65072 && t <= 65106 || t >= 65108 && t <= 65126 || t >= 65128 && t <= 65131 || t >= 94176 && t <= 94180 || t === 94192 || t === 94193 || t >= 94208 && t <= 100343 || t >= 100352 && t <= 101589 || t >= 101632 && t <= 101640 || t >= 110576 && t <= 110579 || t >= 110581 && t <= 110587 || t === 110589 || t === 110590 || t >= 110592 && t <= 110882 || t === 110898 || t >= 110928 && t <= 110930 || t === 110933 || t >= 110948 && t <= 110951 || t >= 110960 && t <= 111355 || t === 126980 || t === 127183 || t === 127374 || t >= 127377 && t <= 127386 || t >= 127488 && t <= 127490 || t >= 127504 && t <= 127547 || t >= 127552 && t <= 127560 || t === 127568 || t === 127569 || t >= 127584 && t <= 127589 || t >= 127744 && t <= 127776 || t >= 127789 && t <= 127797 || t >= 127799 && t <= 127868 || t >= 127870 && t <= 127891 || t >= 127904 && t <= 127946 || t >= 127951 && t <= 127955 || t >= 127968 && t <= 127984 || t === 127988 || t >= 127992 && t <= 128062 || t === 128064 || t >= 128066 && t <= 128252 || t >= 128255 && t <= 128317 || t >= 128331 && t <= 128334 || t >= 128336 && t <= 128359 || t === 128378 || t === 128405 || t === 128406 || t === 128420 || t >= 128507 && t <= 128591 || t >= 128640 && t <= 128709 || t === 128716 || t >= 128720 && t <= 128722 || t >= 128725 && t <= 128727 || t >= 128732 && t <= 128735 || t === 128747 || t === 128748 || t >= 128756 && t <= 128764 || t >= 128992 && t <= 129003 || t === 129008 || t >= 129292 && t <= 129338 || t >= 129340 && t <= 129349 || t >= 129351 && t <= 129535 || t >= 129648 && t <= 129660 || t >= 129664 && t <= 129672 || t >= 129680 && t <= 129725 || t >= 129727 && t <= 129733 || t >= 129742 && t <= 129755 || t >= 129760 && t <= 129768 || t >= 129776 && t <= 129784 || t >= 131072 && t <= 196605 || t >= 196608 && t <= 262141;
var O = /[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/y;
var y = /[\x00-\x08\x0A-\x1F\x7F-\x9F]{1,1000}/y;
var L = /\t{1,1000}/y;
var P = new RegExp("[\\u{1F1E6}-\\u{1F1FF}]{2}|\\u{1F3F4}[\\u{E0061}-\\u{E007A}]{2}[\\u{E0030}-\\u{E0039}\\u{E0061}-\\u{E007A}]{1,3}\\u{E007F}|(?:\\p{Emoji}\\uFE0F\\u20E3?|\\p{Emoji_Modifier_Base}\\p{Emoji_Modifier}?|\\p{Emoji_Presentation})(?:\\u200D(?:\\p{Emoji_Modifier_Base}\\p{Emoji_Modifier}?|\\p{Emoji_Presentation}|\\p{Emoji}\\uFE0F\\u20E3?))*", "yu");
var M = /(?:[\x20-\x7E\xA0-\xFF](?!\uFE0F)){1,1000}/y;
var ct = new RegExp("\\p{M}+", "gu");
var ft = { limit: 1 / 0, ellipsis: "" };
var X = (t, e2 = {}, s = {}) => {
  const i = e2.limit ?? 1 / 0, r = e2.ellipsis ?? "", n = e2?.ellipsisWidth ?? (r ? X(r, ft, s).width : 0), u = s.ansiWidth ?? 0, a = s.controlWidth ?? 0, l = s.tabWidth ?? 8, E = s.ambiguousWidth ?? 1, g = s.emojiWidth ?? 2, m = s.fullWidthWidth ?? 2, A = s.regularWidth ?? 1, V2 = s.wideWidth ?? 2;
  let h = 0, o = 0, p = t.length, v = 0, F = false, d2 = p, b = Math.max(0, i - n), C2 = 0, w = 0, c = 0, f = 0;
  t: for (; ; ) {
    if (w > C2 || o >= p && o > h) {
      const ut = t.slice(C2, w) || t.slice(h, o);
      v = 0;
      for (const Y of ut.replaceAll(ct, "")) {
        const $ = Y.codePointAt(0) || 0;
        if (lt($) ? f = m : ht($) ? f = V2 : E !== A && at($) ? f = E : f = A, c + f > b && (d2 = Math.min(d2, Math.max(C2, h) + v)), c + f > i) {
          F = true;
          break t;
        }
        v += Y.length, c += f;
      }
      C2 = w = 0;
    }
    if (o >= p) break;
    if (M.lastIndex = o, M.test(t)) {
      if (v = M.lastIndex - o, f = v * A, c + f > b && (d2 = Math.min(d2, o + Math.floor((b - c) / A))), c + f > i) {
        F = true;
        break;
      }
      c += f, C2 = h, w = o, o = h = M.lastIndex;
      continue;
    }
    if (O.lastIndex = o, O.test(t)) {
      if (c + u > b && (d2 = Math.min(d2, o)), c + u > i) {
        F = true;
        break;
      }
      c += u, C2 = h, w = o, o = h = O.lastIndex;
      continue;
    }
    if (y.lastIndex = o, y.test(t)) {
      if (v = y.lastIndex - o, f = v * a, c + f > b && (d2 = Math.min(d2, o + Math.floor((b - c) / a))), c + f > i) {
        F = true;
        break;
      }
      c += f, C2 = h, w = o, o = h = y.lastIndex;
      continue;
    }
    if (L.lastIndex = o, L.test(t)) {
      if (v = L.lastIndex - o, f = v * l, c + f > b && (d2 = Math.min(d2, o + Math.floor((b - c) / l))), c + f > i) {
        F = true;
        break;
      }
      c += f, C2 = h, w = o, o = h = L.lastIndex;
      continue;
    }
    if (P.lastIndex = o, P.test(t)) {
      if (c + g > b && (d2 = Math.min(d2, o)), c + g > i) {
        F = true;
        break;
      }
      c += g, C2 = h, w = o, o = h = P.lastIndex;
      continue;
    }
    o += 1;
  }
  return { width: F ? b : c, index: F ? d2 : p, truncated: F, ellipsed: F && i >= n };
};
var pt = { limit: 1 / 0, ellipsis: "", ellipsisWidth: 0 };
var S = (t, e2 = {}) => X(t, pt, e2).width;
var W = "\x1B";
var Z = "\x9B";
var Ft = 39;
var j = "\x07";
var Q = "[";
var dt = "]";
var tt = "m";
var U = `${dt}8;;`;
var et = new RegExp(`(?:\\${Q}(?<code>\\d+)m|\\${U}(?<uri>.*)${j})`, "y");
var mt = (t) => {
  if (t >= 30 && t <= 37 || t >= 90 && t <= 97) return 39;
  if (t >= 40 && t <= 47 || t >= 100 && t <= 107) return 49;
  if (t === 1 || t === 2) return 22;
  if (t === 3) return 23;
  if (t === 4) return 24;
  if (t === 7) return 27;
  if (t === 8) return 28;
  if (t === 9) return 29;
  if (t === 0) return 0;
};
var st = (t) => `${W}${Q}${t}${tt}`;
var it = (t) => `${W}${U}${t}${j}`;
var gt = (t) => t.map((e2) => S(e2));
var G = (t, e2, s) => {
  const i = e2[Symbol.iterator]();
  let r = false, n = false, u = t.at(-1), a = u === void 0 ? 0 : S(u), l = i.next(), E = i.next(), g = 0;
  for (; !l.done; ) {
    const m = l.value, A = S(m);
    a + A <= s ? t[t.length - 1] += m : (t.push(m), a = 0), (m === W || m === Z) && (r = true, n = e2.startsWith(U, g + 1)), r ? n ? m === j && (r = false, n = false) : m === tt && (r = false) : (a += A, a === s && !E.done && (t.push(""), a = 0)), l = E, E = i.next(), g += m.length;
  }
  u = t.at(-1), !a && u !== void 0 && u.length > 0 && t.length > 1 && (t[t.length - 2] += t.pop());
};
var vt = (t) => {
  const e2 = t.split(" ");
  let s = e2.length;
  for (; s > 0 && !(S(e2[s - 1]) > 0); ) s--;
  return s === e2.length ? t : e2.slice(0, s).join(" ") + e2.slice(s).join("");
};
var Et = (t, e2, s = {}) => {
  if (s.trim !== false && t.trim() === "") return "";
  let i = "", r, n;
  const u = t.split(" "), a = gt(u);
  let l = [""];
  for (const [h, o] of u.entries()) {
    s.trim !== false && (l[l.length - 1] = (l.at(-1) ?? "").trimStart());
    let p = S(l.at(-1) ?? "");
    if (h !== 0 && (p >= e2 && (s.wordWrap === false || s.trim === false) && (l.push(""), p = 0), (p > 0 || s.trim === false) && (l[l.length - 1] += " ", p++)), s.hard && a[h] > e2) {
      const v = e2 - p, F = 1 + Math.floor((a[h] - v - 1) / e2);
      Math.floor((a[h] - 1) / e2) < F && l.push(""), G(l, o, e2);
      continue;
    }
    if (p + a[h] > e2 && p > 0 && a[h] > 0) {
      if (s.wordWrap === false && p < e2) {
        G(l, o, e2);
        continue;
      }
      l.push("");
    }
    if (p + a[h] > e2 && s.wordWrap === false) {
      G(l, o, e2);
      continue;
    }
    l[l.length - 1] += o;
  }
  s.trim !== false && (l = l.map((h) => vt(h)));
  const E = l.join(`
`), g = E[Symbol.iterator]();
  let m = g.next(), A = g.next(), V2 = 0;
  for (; !m.done; ) {
    const h = m.value, o = A.value;
    if (i += h, h === W || h === Z) {
      et.lastIndex = V2 + 1;
      const F = et.exec(E)?.groups;
      if (F?.code !== void 0) {
        const d2 = Number.parseFloat(F.code);
        r = d2 === Ft ? void 0 : d2;
      } else F?.uri !== void 0 && (n = F.uri.length === 0 ? void 0 : F.uri);
    }
    const p = r ? mt(r) : void 0;
    o === `
` ? (n && (i += it("")), r && p && (i += st(p))) : h === `
` && (r && p && (i += st(r)), n && (i += it(n))), V2 += h.length, m = A, A = g.next();
  }
  return i;
};
function K(t, e2, s) {
  return String(t).normalize().replaceAll(`\r
`, `
`).split(`
`).map((i) => Et(i, e2, s)).join(`
`);
}
var At = ["up", "down", "left", "right", "space", "enter", "cancel"];
var _ = { actions: new Set(At), aliases: /* @__PURE__ */ new Map([["k", "up"], ["j", "down"], ["h", "left"], ["l", "right"], ["", "cancel"], ["escape", "cancel"]]), messages: { cancel: "Canceled", error: "Something went wrong" }, withGuide: true };
function H(t, e2) {
  if (typeof t == "string") return _.aliases.get(t) === e2;
  for (const s of t) if (s !== void 0 && H(s, e2)) return true;
  return false;
}
function _t(t, e2) {
  if (t === e2) return;
  const s = t.split(`
`), i = e2.split(`
`), r = Math.max(s.length, i.length), n = [];
  for (let u = 0; u < r; u++) s[u] !== i[u] && n.push(u);
  return { lines: n, numLinesBefore: s.length, numLinesAfter: i.length, numLines: r };
}
var bt = globalThis.process.platform.startsWith("win");
var z = Symbol("clack:cancel");
function Ct(t) {
  return t === z;
}
function T(t, e2) {
  const s = t;
  s.isTTY && s.setRawMode(e2);
}
function Bt({ input: t = q, output: e2 = R, overwrite: s = true, hideCursor: i = true } = {}) {
  const r = k.createInterface({ input: t, output: e2, prompt: "", tabSize: 1 });
  k.emitKeypressEvents(t, r), t instanceof J && t.isTTY && t.setRawMode(true);
  const n = (u, { name: a, sequence: l }) => {
    const E = String(u);
    if (H([E, a, l], "cancel")) {
      i && e2.write(import_sisteransi.cursor.show), process.exit(0);
      return;
    }
    if (!s) return;
    const g = a === "return" ? 0 : -1, m = a === "return" ? -1 : 0;
    k.moveCursor(e2, g, m, () => {
      k.clearLine(e2, 1, () => {
        t.once("keypress", n);
      });
    });
  };
  return i && e2.write(import_sisteransi.cursor.hide), t.once("keypress", n), () => {
    t.off("keypress", n), i && e2.write(import_sisteransi.cursor.show), t instanceof J && t.isTTY && !bt && t.setRawMode(false), r.terminal = false, r.close();
  };
}
var rt = (t) => "columns" in t && typeof t.columns == "number" ? t.columns : 80;
var nt = (t) => "rows" in t && typeof t.rows == "number" ? t.rows : 20;
function xt(t, e2, s, i = s) {
  const r = rt(t ?? R);
  return K(e2, r - s.length, { hard: true, trim: false }).split(`
`).map((n, u) => `${u === 0 ? i : s}${n}`).join(`
`);
}
var x = class {
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
  constructor(e2, s = true) {
    const { input: i = q, output: r = R, render: n, signal: u, ...a } = e2;
    this.opts = a, this.onKeypress = this.onKeypress.bind(this), this.close = this.close.bind(this), this.render = this.render.bind(this), this._render = n.bind(this), this._track = s, this._abortSignal = u, this.input = i, this.output = r;
  }
  unsubscribe() {
    this._subscribers.clear();
  }
  setSubscriber(e2, s) {
    const i = this._subscribers.get(e2) ?? [];
    i.push(s), this._subscribers.set(e2, i);
  }
  on(e2, s) {
    this.setSubscriber(e2, { cb: s });
  }
  once(e2, s) {
    this.setSubscriber(e2, { cb: s, once: true });
  }
  emit(e2, ...s) {
    const i = this._subscribers.get(e2) ?? [], r = [];
    for (const n of i) n.cb(...s), n.once && r.push(() => i.splice(i.indexOf(n), 1));
    for (const n of r) n();
  }
  prompt() {
    return new Promise((e2) => {
      if (this._abortSignal) {
        if (this._abortSignal.aborted) return this.state = "cancel", this.close(), e2(z);
        this._abortSignal.addEventListener("abort", () => {
          this.state = "cancel", this.close();
        }, { once: true });
      }
      this.rl = ot.createInterface({ input: this.input, tabSize: 2, prompt: "", escapeCodeTimeout: 50, terminal: true }), this.rl.prompt(), this.opts.initialUserInput !== void 0 && this._setUserInput(this.opts.initialUserInput, true), this.input.on("keypress", this.onKeypress), T(this.input, true), this.output.on("resize", this.render), this.render(), this.once("submit", () => {
        this.output.write(import_sisteransi.cursor.show), this.output.off("resize", this.render), T(this.input, false), e2(this.value);
      }), this.once("cancel", () => {
        this.output.write(import_sisteransi.cursor.show), this.output.off("resize", this.render), T(this.input, false), e2(z);
      });
    });
  }
  _isActionKey(e2, s) {
    return e2 === "	";
  }
  _setValue(e2) {
    this.value = e2, this.emit("value", this.value);
  }
  _setUserInput(e2, s) {
    this.userInput = e2 ?? "", this.emit("userInput", this.userInput), s && this._track && this.rl && (this.rl.write(this.userInput), this._cursor = this.rl.cursor);
  }
  _clearUserInput() {
    this.rl?.write(null, { ctrl: true, name: "u" }), this._setUserInput("");
  }
  onKeypress(e2, s) {
    if (this._track && s.name !== "return" && (s.name && this._isActionKey(e2, s) && this.rl?.write(null, { ctrl: true, name: "h" }), this._cursor = this.rl?.cursor ?? 0, this._setUserInput(this.rl?.line)), this.state === "error" && (this.state = "active"), s?.name && (!this._track && _.aliases.has(s.name) && this.emit("cursor", _.aliases.get(s.name)), _.actions.has(s.name) && this.emit("cursor", s.name)), e2 && (e2.toLowerCase() === "y" || e2.toLowerCase() === "n") && this.emit("confirm", e2.toLowerCase() === "y"), this.emit("key", e2?.toLowerCase(), s), s?.name === "return") {
      if (this.opts.validate) {
        const i = this.opts.validate(this.value);
        i && (this.error = i instanceof Error ? i.message : i, this.state = "error", this.rl?.write(this.userInput));
      }
      this.state !== "error" && (this.state = "submit");
    }
    H([e2, s?.name, s?.sequence], "cancel") && (this.state = "cancel"), (this.state === "submit" || this.state === "cancel") && this.emit("finalize"), this.render(), (this.state === "submit" || this.state === "cancel") && this.close();
  }
  close() {
    this.input.unpipe(), this.input.removeListener("keypress", this.onKeypress), this.output.write(`
`), T(this.input, false), this.rl?.close(), this.rl = void 0, this.emit(`${this.state}`, this.value), this.unsubscribe();
  }
  restoreCursor() {
    const e2 = K(this._prevFrame, process.stdout.columns, { hard: true, trim: false }).split(`
`).length - 1;
    this.output.write(import_sisteransi.cursor.move(-999, e2 * -1));
  }
  render() {
    const e2 = K(this._render(this) ?? "", process.stdout.columns, { hard: true, trim: false });
    if (e2 !== this._prevFrame) {
      if (this.state === "initial") this.output.write(import_sisteransi.cursor.hide);
      else {
        const s = _t(this._prevFrame, e2), i = nt(this.output);
        if (this.restoreCursor(), s) {
          const r = Math.max(0, s.numLinesAfter - i), n = Math.max(0, s.numLinesBefore - i);
          let u = s.lines.find((a) => a >= r);
          if (u === void 0) {
            this._prevFrame = e2;
            return;
          }
          if (s.lines.length === 1) {
            this.output.write(import_sisteransi.cursor.move(0, u - n)), this.output.write(import_sisteransi.erase.lines(1));
            const a = e2.split(`
`);
            this.output.write(a[u]), this._prevFrame = e2, this.output.write(import_sisteransi.cursor.move(0, a.length - u - 1));
            return;
          } else if (s.lines.length > 1) {
            if (r < n) u = r;
            else {
              const l = u - n;
              l > 0 && this.output.write(import_sisteransi.cursor.move(0, l));
            }
            this.output.write(import_sisteransi.erase.down());
            const a = e2.split(`
`).slice(u);
            this.output.write(a.join(`
`)), this._prevFrame = e2;
            return;
          }
        }
        this.output.write(import_sisteransi.erase.down());
      }
      this.output.write(e2), this.state === "initial" && (this.state = "active"), this._prevFrame = e2;
    }
  }
};
var kt = class extends x {
  get cursor() {
    return this.value ? 0 : 1;
  }
  get _value() {
    return this.cursor === 0;
  }
  constructor(e2) {
    super(e2, false), this.value = !!e2.initialValue, this.on("userInput", () => {
      this.value = this._value;
    }), this.on("confirm", (s) => {
      this.output.write(import_sisteransi.cursor.move(0, -1)), this.value = s, this.state = "submit", this.close();
    }), this.on("cursor", () => {
      this.value = !this.value;
    });
  }
};
var Lt = class extends x {
  options;
  cursor = 0;
  get _value() {
    return this.options[this.cursor].value;
  }
  get _enabledOptions() {
    return this.options.filter((e2) => e2.disabled !== true);
  }
  toggleAll() {
    const e2 = this._enabledOptions, s = this.value !== void 0 && this.value.length === e2.length;
    this.value = s ? [] : e2.map((i) => i.value);
  }
  toggleInvert() {
    const e2 = this.value;
    if (!e2) return;
    const s = this._enabledOptions.filter((i) => !e2.includes(i.value));
    this.value = s.map((i) => i.value);
  }
  toggleValue() {
    this.value === void 0 && (this.value = []);
    const e2 = this.value.includes(this._value);
    this.value = e2 ? this.value.filter((s) => s !== this._value) : [...this.value, this._value];
  }
  constructor(e2) {
    super(e2, false), this.options = e2.options, this.value = [...e2.initialValues ?? []];
    const s = Math.max(this.options.findIndex(({ value: i }) => i === e2.cursorAt), 0);
    this.cursor = this.options[s].disabled ? B(s, 1, this.options) : s, this.on("key", (i) => {
      i === "a" && this.toggleAll(), i === "i" && this.toggleInvert();
    }), this.on("cursor", (i) => {
      switch (i) {
        case "left":
        case "up":
          this.cursor = B(this.cursor, -1, this.options);
          break;
        case "down":
        case "right":
          this.cursor = B(this.cursor, 1, this.options);
          break;
        case "space":
          this.toggleValue();
          break;
      }
    });
  }
};
var Mt = class extends x {
  _mask = "\u2022";
  get cursor() {
    return this._cursor;
  }
  get masked() {
    return this.userInput.replaceAll(/./g, this._mask);
  }
  get userInputWithCursor() {
    if (this.state === "submit" || this.state === "cancel") return this.masked;
    const e2 = this.userInput;
    if (this.cursor >= e2.length) return `${this.masked}${import_picocolors.default.inverse(import_picocolors.default.hidden("_"))}`;
    const s = this.masked, i = s.slice(0, this.cursor), r = s.slice(this.cursor);
    return `${i}${import_picocolors.default.inverse(r[0])}${r.slice(1)}`;
  }
  clear() {
    this._clearUserInput();
  }
  constructor({ mask: e2, ...s }) {
    super(s), this._mask = e2 ?? "\u2022", this.on("userInput", (i) => {
      this._setValue(i);
    });
  }
};
var Wt = class extends x {
  options;
  cursor = 0;
  get _selectedValue() {
    return this.options[this.cursor];
  }
  changeValue() {
    this.value = this._selectedValue.value;
  }
  constructor(e2) {
    super(e2, false), this.options = e2.options;
    const s = this.options.findIndex(({ value: r }) => r === e2.initialValue), i = s === -1 ? 0 : s;
    this.cursor = this.options[i].disabled ? B(i, 1, this.options) : i, this.changeValue(), this.on("cursor", (r) => {
      switch (r) {
        case "left":
        case "up":
          this.cursor = B(this.cursor, -1, this.options);
          break;
        case "down":
        case "right":
          this.cursor = B(this.cursor, 1, this.options);
          break;
      }
      this.changeValue();
    });
  }
};
var $t = class extends x {
  get userInputWithCursor() {
    if (this.state === "submit") return this.userInput;
    const e2 = this.userInput;
    if (this.cursor >= e2.length) return `${this.userInput}\u2588`;
    const s = e2.slice(0, this.cursor), [i, ...r] = e2.slice(this.cursor);
    return `${s}${import_picocolors.default.inverse(i)}${r.join("")}`;
  }
  get cursor() {
    return this._cursor;
  }
  constructor(e2) {
    super({ ...e2, initialUserInput: e2.initialUserInput ?? e2.initialValue }), this.on("userInput", (s) => {
      this._setValue(s);
    }), this.on("finalize", () => {
      this.value || (this.value = e2.defaultValue), this.value === void 0 && (this.value = "");
    });
  }
};

// node_modules/@clack/prompts/dist/index.mjs
var import_picocolors2 = __toESM(require_picocolors(), 1);
import N2 from "node:process";
var import_sisteransi2 = __toESM(require_src(), 1);
function me() {
  return N2.platform !== "win32" ? N2.env.TERM !== "linux" : !!N2.env.CI || !!N2.env.WT_SESSION || !!N2.env.TERMINUS_SUBLIME || N2.env.ConEmuTask === "{cmd::Cmder}" || N2.env.TERM_PROGRAM === "Terminus-Sublime" || N2.env.TERM_PROGRAM === "vscode" || N2.env.TERM === "xterm-256color" || N2.env.TERM === "alacritty" || N2.env.TERMINAL_EMULATOR === "JetBrains-JediTerm";
}
var et2 = me();
var ct2 = () => process.env.CI === "true";
var C = (t, r) => et2 ? t : r;
var Rt = C("\u25C6", "*");
var dt2 = C("\u25A0", "x");
var $t2 = C("\u25B2", "x");
var V = C("\u25C7", "o");
var ht2 = C("\u250C", "T");
var d = C("\u2502", "|");
var x2 = C("\u2514", "\u2014");
var Ot = C("\u2510", "T");
var Pt = C("\u2518", "\u2014");
var Q2 = C("\u25CF", ">");
var H2 = C("\u25CB", " ");
var st2 = C("\u25FB", "[\u2022]");
var U2 = C("\u25FC", "[+]");
var q2 = C("\u25FB", "[ ]");
var Nt = C("\u25AA", "\u2022");
var rt2 = C("\u2500", "-");
var mt2 = C("\u256E", "+");
var Wt2 = C("\u251C", "+");
var pt2 = C("\u256F", "+");
var gt2 = C("\u2570", "+");
var Lt2 = C("\u256D", "+");
var ft2 = C("\u25CF", "\u2022");
var Ft2 = C("\u25C6", "*");
var yt2 = C("\u25B2", "!");
var Et2 = C("\u25A0", "x");
var W2 = (t) => {
  switch (t) {
    case "initial":
    case "active":
      return import_picocolors2.default.cyan(Rt);
    case "cancel":
      return import_picocolors2.default.red(dt2);
    case "error":
      return import_picocolors2.default.yellow($t2);
    case "submit":
      return import_picocolors2.default.green(V);
  }
};
var vt2 = (t) => {
  switch (t) {
    case "initial":
    case "active":
      return import_picocolors2.default.cyan(d);
    case "cancel":
      return import_picocolors2.default.red(d);
    case "error":
      return import_picocolors2.default.yellow(d);
    case "submit":
      return import_picocolors2.default.green(d);
  }
};
var pe = (t) => t === 161 || t === 164 || t === 167 || t === 168 || t === 170 || t === 173 || t === 174 || t >= 176 && t <= 180 || t >= 182 && t <= 186 || t >= 188 && t <= 191 || t === 198 || t === 208 || t === 215 || t === 216 || t >= 222 && t <= 225 || t === 230 || t >= 232 && t <= 234 || t === 236 || t === 237 || t === 240 || t === 242 || t === 243 || t >= 247 && t <= 250 || t === 252 || t === 254 || t === 257 || t === 273 || t === 275 || t === 283 || t === 294 || t === 295 || t === 299 || t >= 305 && t <= 307 || t === 312 || t >= 319 && t <= 322 || t === 324 || t >= 328 && t <= 331 || t === 333 || t === 338 || t === 339 || t === 358 || t === 359 || t === 363 || t === 462 || t === 464 || t === 466 || t === 468 || t === 470 || t === 472 || t === 474 || t === 476 || t === 593 || t === 609 || t === 708 || t === 711 || t >= 713 && t <= 715 || t === 717 || t === 720 || t >= 728 && t <= 731 || t === 733 || t === 735 || t >= 768 && t <= 879 || t >= 913 && t <= 929 || t >= 931 && t <= 937 || t >= 945 && t <= 961 || t >= 963 && t <= 969 || t === 1025 || t >= 1040 && t <= 1103 || t === 1105 || t === 8208 || t >= 8211 && t <= 8214 || t === 8216 || t === 8217 || t === 8220 || t === 8221 || t >= 8224 && t <= 8226 || t >= 8228 && t <= 8231 || t === 8240 || t === 8242 || t === 8243 || t === 8245 || t === 8251 || t === 8254 || t === 8308 || t === 8319 || t >= 8321 && t <= 8324 || t === 8364 || t === 8451 || t === 8453 || t === 8457 || t === 8467 || t === 8470 || t === 8481 || t === 8482 || t === 8486 || t === 8491 || t === 8531 || t === 8532 || t >= 8539 && t <= 8542 || t >= 8544 && t <= 8555 || t >= 8560 && t <= 8569 || t === 8585 || t >= 8592 && t <= 8601 || t === 8632 || t === 8633 || t === 8658 || t === 8660 || t === 8679 || t === 8704 || t === 8706 || t === 8707 || t === 8711 || t === 8712 || t === 8715 || t === 8719 || t === 8721 || t === 8725 || t === 8730 || t >= 8733 && t <= 8736 || t === 8739 || t === 8741 || t >= 8743 && t <= 8748 || t === 8750 || t >= 8756 && t <= 8759 || t === 8764 || t === 8765 || t === 8776 || t === 8780 || t === 8786 || t === 8800 || t === 8801 || t >= 8804 && t <= 8807 || t === 8810 || t === 8811 || t === 8814 || t === 8815 || t === 8834 || t === 8835 || t === 8838 || t === 8839 || t === 8853 || t === 8857 || t === 8869 || t === 8895 || t === 8978 || t >= 9312 && t <= 9449 || t >= 9451 && t <= 9547 || t >= 9552 && t <= 9587 || t >= 9600 && t <= 9615 || t >= 9618 && t <= 9621 || t === 9632 || t === 9633 || t >= 9635 && t <= 9641 || t === 9650 || t === 9651 || t === 9654 || t === 9655 || t === 9660 || t === 9661 || t === 9664 || t === 9665 || t >= 9670 && t <= 9672 || t === 9675 || t >= 9678 && t <= 9681 || t >= 9698 && t <= 9701 || t === 9711 || t === 9733 || t === 9734 || t === 9737 || t === 9742 || t === 9743 || t === 9756 || t === 9758 || t === 9792 || t === 9794 || t === 9824 || t === 9825 || t >= 9827 && t <= 9829 || t >= 9831 && t <= 9834 || t === 9836 || t === 9837 || t === 9839 || t === 9886 || t === 9887 || t === 9919 || t >= 9926 && t <= 9933 || t >= 9935 && t <= 9939 || t >= 9941 && t <= 9953 || t === 9955 || t === 9960 || t === 9961 || t >= 9963 && t <= 9969 || t === 9972 || t >= 9974 && t <= 9977 || t === 9979 || t === 9980 || t === 9982 || t === 9983 || t === 10045 || t >= 10102 && t <= 10111 || t >= 11094 && t <= 11097 || t >= 12872 && t <= 12879 || t >= 57344 && t <= 63743 || t >= 65024 && t <= 65039 || t === 65533 || t >= 127232 && t <= 127242 || t >= 127248 && t <= 127277 || t >= 127280 && t <= 127337 || t >= 127344 && t <= 127373 || t === 127375 || t === 127376 || t >= 127387 && t <= 127404 || t >= 917760 && t <= 917999 || t >= 983040 && t <= 1048573 || t >= 1048576 && t <= 1114109;
var ge = (t) => t === 12288 || t >= 65281 && t <= 65376 || t >= 65504 && t <= 65510;
var fe = (t) => t >= 4352 && t <= 4447 || t === 8986 || t === 8987 || t === 9001 || t === 9002 || t >= 9193 && t <= 9196 || t === 9200 || t === 9203 || t === 9725 || t === 9726 || t === 9748 || t === 9749 || t >= 9800 && t <= 9811 || t === 9855 || t === 9875 || t === 9889 || t === 9898 || t === 9899 || t === 9917 || t === 9918 || t === 9924 || t === 9925 || t === 9934 || t === 9940 || t === 9962 || t === 9970 || t === 9971 || t === 9973 || t === 9978 || t === 9981 || t === 9989 || t === 9994 || t === 9995 || t === 10024 || t === 10060 || t === 10062 || t >= 10067 && t <= 10069 || t === 10071 || t >= 10133 && t <= 10135 || t === 10160 || t === 10175 || t === 11035 || t === 11036 || t === 11088 || t === 11093 || t >= 11904 && t <= 11929 || t >= 11931 && t <= 12019 || t >= 12032 && t <= 12245 || t >= 12272 && t <= 12287 || t >= 12289 && t <= 12350 || t >= 12353 && t <= 12438 || t >= 12441 && t <= 12543 || t >= 12549 && t <= 12591 || t >= 12593 && t <= 12686 || t >= 12688 && t <= 12771 || t >= 12783 && t <= 12830 || t >= 12832 && t <= 12871 || t >= 12880 && t <= 19903 || t >= 19968 && t <= 42124 || t >= 42128 && t <= 42182 || t >= 43360 && t <= 43388 || t >= 44032 && t <= 55203 || t >= 63744 && t <= 64255 || t >= 65040 && t <= 65049 || t >= 65072 && t <= 65106 || t >= 65108 && t <= 65126 || t >= 65128 && t <= 65131 || t >= 94176 && t <= 94180 || t === 94192 || t === 94193 || t >= 94208 && t <= 100343 || t >= 100352 && t <= 101589 || t >= 101632 && t <= 101640 || t >= 110576 && t <= 110579 || t >= 110581 && t <= 110587 || t === 110589 || t === 110590 || t >= 110592 && t <= 110882 || t === 110898 || t >= 110928 && t <= 110930 || t === 110933 || t >= 110948 && t <= 110951 || t >= 110960 && t <= 111355 || t === 126980 || t === 127183 || t === 127374 || t >= 127377 && t <= 127386 || t >= 127488 && t <= 127490 || t >= 127504 && t <= 127547 || t >= 127552 && t <= 127560 || t === 127568 || t === 127569 || t >= 127584 && t <= 127589 || t >= 127744 && t <= 127776 || t >= 127789 && t <= 127797 || t >= 127799 && t <= 127868 || t >= 127870 && t <= 127891 || t >= 127904 && t <= 127946 || t >= 127951 && t <= 127955 || t >= 127968 && t <= 127984 || t === 127988 || t >= 127992 && t <= 128062 || t === 128064 || t >= 128066 && t <= 128252 || t >= 128255 && t <= 128317 || t >= 128331 && t <= 128334 || t >= 128336 && t <= 128359 || t === 128378 || t === 128405 || t === 128406 || t === 128420 || t >= 128507 && t <= 128591 || t >= 128640 && t <= 128709 || t === 128716 || t >= 128720 && t <= 128722 || t >= 128725 && t <= 128727 || t >= 128732 && t <= 128735 || t === 128747 || t === 128748 || t >= 128756 && t <= 128764 || t >= 128992 && t <= 129003 || t === 129008 || t >= 129292 && t <= 129338 || t >= 129340 && t <= 129349 || t >= 129351 && t <= 129535 || t >= 129648 && t <= 129660 || t >= 129664 && t <= 129672 || t >= 129680 && t <= 129725 || t >= 129727 && t <= 129733 || t >= 129742 && t <= 129755 || t >= 129760 && t <= 129768 || t >= 129776 && t <= 129784 || t >= 131072 && t <= 196605 || t >= 196608 && t <= 262141;
var At2 = /[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/y;
var it2 = /[\x00-\x08\x0A-\x1F\x7F-\x9F]{1,1000}/y;
var nt2 = /\t{1,1000}/y;
var wt = new RegExp("[\\u{1F1E6}-\\u{1F1FF}]{2}|\\u{1F3F4}[\\u{E0061}-\\u{E007A}]{2}[\\u{E0030}-\\u{E0039}\\u{E0061}-\\u{E007A}]{1,3}\\u{E007F}|(?:\\p{Emoji}\\uFE0F\\u20E3?|\\p{Emoji_Modifier_Base}\\p{Emoji_Modifier}?|\\p{Emoji_Presentation})(?:\\u200D(?:\\p{Emoji_Modifier_Base}\\p{Emoji_Modifier}?|\\p{Emoji_Presentation}|\\p{Emoji}\\uFE0F\\u20E3?))*", "yu");
var at2 = /(?:[\x20-\x7E\xA0-\xFF](?!\uFE0F)){1,1000}/y;
var Fe = new RegExp("\\p{M}+", "gu");
var ye = { limit: 1 / 0, ellipsis: "" };
var jt = (t, r = {}, s = {}) => {
  const i = r.limit ?? 1 / 0, a = r.ellipsis ?? "", o = r?.ellipsisWidth ?? (a ? jt(a, ye, s).width : 0), u = s.ansiWidth ?? 0, l = s.controlWidth ?? 0, n = s.tabWidth ?? 8, c = s.ambiguousWidth ?? 1, g = s.emojiWidth ?? 2, F = s.fullWidthWidth ?? 2, p = s.regularWidth ?? 1, E = s.wideWidth ?? 2;
  let $ = 0, m = 0, h = t.length, y2 = 0, f = false, v = h, S2 = Math.max(0, i - o), I2 = 0, B2 = 0, A = 0, w = 0;
  t: for (; ; ) {
    if (B2 > I2 || m >= h && m > $) {
      const _2 = t.slice(I2, B2) || t.slice($, m);
      y2 = 0;
      for (const D2 of _2.replaceAll(Fe, "")) {
        const T2 = D2.codePointAt(0) || 0;
        if (ge(T2) ? w = F : fe(T2) ? w = E : c !== p && pe(T2) ? w = c : w = p, A + w > S2 && (v = Math.min(v, Math.max(I2, $) + y2)), A + w > i) {
          f = true;
          break t;
        }
        y2 += D2.length, A += w;
      }
      I2 = B2 = 0;
    }
    if (m >= h) break;
    if (at2.lastIndex = m, at2.test(t)) {
      if (y2 = at2.lastIndex - m, w = y2 * p, A + w > S2 && (v = Math.min(v, m + Math.floor((S2 - A) / p))), A + w > i) {
        f = true;
        break;
      }
      A += w, I2 = $, B2 = m, m = $ = at2.lastIndex;
      continue;
    }
    if (At2.lastIndex = m, At2.test(t)) {
      if (A + u > S2 && (v = Math.min(v, m)), A + u > i) {
        f = true;
        break;
      }
      A += u, I2 = $, B2 = m, m = $ = At2.lastIndex;
      continue;
    }
    if (it2.lastIndex = m, it2.test(t)) {
      if (y2 = it2.lastIndex - m, w = y2 * l, A + w > S2 && (v = Math.min(v, m + Math.floor((S2 - A) / l))), A + w > i) {
        f = true;
        break;
      }
      A += w, I2 = $, B2 = m, m = $ = it2.lastIndex;
      continue;
    }
    if (nt2.lastIndex = m, nt2.test(t)) {
      if (y2 = nt2.lastIndex - m, w = y2 * n, A + w > S2 && (v = Math.min(v, m + Math.floor((S2 - A) / n))), A + w > i) {
        f = true;
        break;
      }
      A += w, I2 = $, B2 = m, m = $ = nt2.lastIndex;
      continue;
    }
    if (wt.lastIndex = m, wt.test(t)) {
      if (A + g > S2 && (v = Math.min(v, m)), A + g > i) {
        f = true;
        break;
      }
      A += g, I2 = $, B2 = m, m = $ = wt.lastIndex;
      continue;
    }
    m += 1;
  }
  return { width: f ? S2 : A, index: f ? v : h, truncated: f, ellipsed: f && i >= o };
};
var Ee = { limit: 1 / 0, ellipsis: "", ellipsisWidth: 0 };
var M2 = (t, r = {}) => jt(t, Ee, r).width;
var ot2 = "\x1B";
var Gt = "\x9B";
var ve = 39;
var Ct2 = "\x07";
var kt2 = "[";
var Ae = "]";
var Vt2 = "m";
var St = `${Ae}8;;`;
var Ht = new RegExp(`(?:\\${kt2}(?<code>\\d+)m|\\${St}(?<uri>.*)${Ct2})`, "y");
var we = (t) => {
  if (t >= 30 && t <= 37 || t >= 90 && t <= 97) return 39;
  if (t >= 40 && t <= 47 || t >= 100 && t <= 107) return 49;
  if (t === 1 || t === 2) return 22;
  if (t === 3) return 23;
  if (t === 4) return 24;
  if (t === 7) return 27;
  if (t === 8) return 28;
  if (t === 9) return 29;
  if (t === 0) return 0;
};
var Ut = (t) => `${ot2}${kt2}${t}${Vt2}`;
var Kt = (t) => `${ot2}${St}${t}${Ct2}`;
var Ce = (t) => t.map((r) => M2(r));
var It2 = (t, r, s) => {
  const i = r[Symbol.iterator]();
  let a = false, o = false, u = t.at(-1), l = u === void 0 ? 0 : M2(u), n = i.next(), c = i.next(), g = 0;
  for (; !n.done; ) {
    const F = n.value, p = M2(F);
    l + p <= s ? t[t.length - 1] += F : (t.push(F), l = 0), (F === ot2 || F === Gt) && (a = true, o = r.startsWith(St, g + 1)), a ? o ? F === Ct2 && (a = false, o = false) : F === Vt2 && (a = false) : (l += p, l === s && !c.done && (t.push(""), l = 0)), n = c, c = i.next(), g += F.length;
  }
  u = t.at(-1), !l && u !== void 0 && u.length > 0 && t.length > 1 && (t[t.length - 2] += t.pop());
};
var Se = (t) => {
  const r = t.split(" ");
  let s = r.length;
  for (; s > 0 && !(M2(r[s - 1]) > 0); ) s--;
  return s === r.length ? t : r.slice(0, s).join(" ") + r.slice(s).join("");
};
var Ie = (t, r, s = {}) => {
  if (s.trim !== false && t.trim() === "") return "";
  let i = "", a, o;
  const u = t.split(" "), l = Ce(u);
  let n = [""];
  for (const [$, m] of u.entries()) {
    s.trim !== false && (n[n.length - 1] = (n.at(-1) ?? "").trimStart());
    let h = M2(n.at(-1) ?? "");
    if ($ !== 0 && (h >= r && (s.wordWrap === false || s.trim === false) && (n.push(""), h = 0), (h > 0 || s.trim === false) && (n[n.length - 1] += " ", h++)), s.hard && l[$] > r) {
      const y2 = r - h, f = 1 + Math.floor((l[$] - y2 - 1) / r);
      Math.floor((l[$] - 1) / r) < f && n.push(""), It2(n, m, r);
      continue;
    }
    if (h + l[$] > r && h > 0 && l[$] > 0) {
      if (s.wordWrap === false && h < r) {
        It2(n, m, r);
        continue;
      }
      n.push("");
    }
    if (h + l[$] > r && s.wordWrap === false) {
      It2(n, m, r);
      continue;
    }
    n[n.length - 1] += m;
  }
  s.trim !== false && (n = n.map(($) => Se($)));
  const c = n.join(`
`), g = c[Symbol.iterator]();
  let F = g.next(), p = g.next(), E = 0;
  for (; !F.done; ) {
    const $ = F.value, m = p.value;
    if (i += $, $ === ot2 || $ === Gt) {
      Ht.lastIndex = E + 1;
      const f = Ht.exec(c)?.groups;
      if (f?.code !== void 0) {
        const v = Number.parseFloat(f.code);
        a = v === ve ? void 0 : v;
      } else f?.uri !== void 0 && (o = f.uri.length === 0 ? void 0 : f.uri);
    }
    const h = a ? we(a) : void 0;
    m === `
` ? (o && (i += Kt("")), a && h && (i += Ut(h))) : $ === `
` && (a && h && (i += Ut(a)), o && (i += Kt(o))), E += $.length, F = p, p = g.next();
  }
  return i;
};
function J2(t, r, s) {
  return String(t).normalize().replaceAll(`\r
`, `
`).split(`
`).map((i) => Ie(i, r, s)).join(`
`);
}
var be = (t, r, s, i, a) => {
  let o = r, u = 0;
  for (let l = s; l < i; l++) {
    const n = t[l];
    if (o = o - n.length, u++, o <= a) break;
  }
  return { lineCount: o, removals: u };
};
var X2 = (t) => {
  const { cursor: r, options: s, style: i } = t, a = t.output ?? process.stdout, o = rt(a), u = t.columnPadding ?? 0, l = t.rowPadding ?? 4, n = o - u, c = nt(a), g = import_picocolors2.default.dim("..."), F = t.maxItems ?? Number.POSITIVE_INFINITY, p = Math.max(c - l, 0), E = Math.max(Math.min(F, p), 5);
  let $ = 0;
  r >= E - 3 && ($ = Math.max(Math.min(r - E + 3, s.length - E), 0));
  let m = E < s.length && $ > 0, h = E < s.length && $ + E < s.length;
  const y2 = Math.min($ + E, s.length), f = [];
  let v = 0;
  m && v++, h && v++;
  const S2 = $ + (m ? 1 : 0), I2 = y2 - (h ? 1 : 0);
  for (let A = S2; A < I2; A++) {
    const w = J2(i(s[A], A === r), n, { hard: true, trim: false }).split(`
`);
    f.push(w), v += w.length;
  }
  if (v > p) {
    let A = 0, w = 0, _2 = v;
    const D2 = r - S2, T2 = (Y, L2) => be(f, _2, Y, L2, p);
    m ? ({ lineCount: _2, removals: A } = T2(0, D2), _2 > p && ({ lineCount: _2, removals: w } = T2(D2 + 1, f.length))) : ({ lineCount: _2, removals: w } = T2(D2 + 1, f.length), _2 > p && ({ lineCount: _2, removals: A } = T2(0, D2))), A > 0 && (m = true, f.splice(0, A)), w > 0 && (h = true, f.splice(f.length - w, w));
  }
  const B2 = [];
  m && B2.push(g);
  for (const A of f) for (const w of A) B2.push(w);
  return h && B2.push(g), B2;
};
var Re = (t) => {
  const r = t.active ?? "Yes", s = t.inactive ?? "No";
  return new kt({ active: r, inactive: s, signal: t.signal, input: t.input, output: t.output, initialValue: t.initialValue ?? true, render() {
    const i = t.withGuide ?? _.withGuide, a = `${i ? `${import_picocolors2.default.gray(d)}
` : ""}${W2(this.state)}  ${t.message}
`, o = this.value ? r : s;
    switch (this.state) {
      case "submit": {
        const u = i ? `${import_picocolors2.default.gray(d)}  ` : "";
        return `${a}${u}${import_picocolors2.default.dim(o)}`;
      }
      case "cancel": {
        const u = i ? `${import_picocolors2.default.gray(d)}  ` : "";
        return `${a}${u}${import_picocolors2.default.strikethrough(import_picocolors2.default.dim(o))}${i ? `
${import_picocolors2.default.gray(d)}` : ""}`;
      }
      default: {
        const u = i ? `${import_picocolors2.default.cyan(d)}  ` : "", l = i ? import_picocolors2.default.cyan(x2) : "";
        return `${a}${u}${this.value ? `${import_picocolors2.default.green(Q2)} ${r}` : `${import_picocolors2.default.dim(H2)} ${import_picocolors2.default.dim(r)}`}${t.vertical ? i ? `
${import_picocolors2.default.cyan(d)}  ` : `
` : ` ${import_picocolors2.default.dim("/")} `}${this.value ? `${import_picocolors2.default.dim(H2)} ${import_picocolors2.default.dim(s)}` : `${import_picocolors2.default.green(Q2)} ${s}`}
${l}
`;
      }
    }
  } }).prompt();
};
var R2 = { message: (t = [], { symbol: r = import_picocolors2.default.gray(d), secondarySymbol: s = import_picocolors2.default.gray(d), output: i = process.stdout, spacing: a = 1, withGuide: o } = {}) => {
  const u = [], l = o ?? _.withGuide, n = l ? s : "", c = l ? `${r}  ` : "", g = l ? `${s}  ` : "";
  for (let p = 0; p < a; p++) u.push(n);
  const F = Array.isArray(t) ? t : t.split(`
`);
  if (F.length > 0) {
    const [p, ...E] = F;
    p.length > 0 ? u.push(`${c}${p}`) : u.push(l ? r : "");
    for (const $ of E) $.length > 0 ? u.push(`${g}${$}`) : u.push(l ? s : "");
  }
  i.write(`${u.join(`
`)}
`);
}, info: (t, r) => {
  R2.message(t, { ...r, symbol: import_picocolors2.default.blue(ft2) });
}, success: (t, r) => {
  R2.message(t, { ...r, symbol: import_picocolors2.default.green(Ft2) });
}, step: (t, r) => {
  R2.message(t, { ...r, symbol: import_picocolors2.default.green(V) });
}, warn: (t, r) => {
  R2.message(t, { ...r, symbol: import_picocolors2.default.yellow(yt2) });
}, warning: (t, r) => {
  R2.warn(t, r);
}, error: (t, r) => {
  R2.message(t, { ...r, symbol: import_picocolors2.default.red(Et2) });
} };
var Ne = (t = "", r) => {
  (r?.output ?? process.stdout).write(`${import_picocolors2.default.gray(x2)}  ${import_picocolors2.default.red(t)}

`);
};
var We = (t = "", r) => {
  (r?.output ?? process.stdout).write(`${import_picocolors2.default.gray(ht2)}  ${t}
`);
};
var Le = (t = "", r) => {
  (r?.output ?? process.stdout).write(`${import_picocolors2.default.gray(d)}
${import_picocolors2.default.gray(x2)}  ${t}

`);
};
var Z2 = (t, r) => t.split(`
`).map((s) => r(s)).join(`
`);
var je = (t) => {
  const r = (i, a) => {
    const o = i.label ?? String(i.value);
    return a === "disabled" ? `${import_picocolors2.default.gray(q2)} ${Z2(o, (u) => import_picocolors2.default.strikethrough(import_picocolors2.default.gray(u)))}${i.hint ? ` ${import_picocolors2.default.dim(`(${i.hint ?? "disabled"})`)}` : ""}` : a === "active" ? `${import_picocolors2.default.cyan(st2)} ${o}${i.hint ? ` ${import_picocolors2.default.dim(`(${i.hint})`)}` : ""}` : a === "selected" ? `${import_picocolors2.default.green(U2)} ${Z2(o, import_picocolors2.default.dim)}${i.hint ? ` ${import_picocolors2.default.dim(`(${i.hint})`)}` : ""}` : a === "cancelled" ? `${Z2(o, (u) => import_picocolors2.default.strikethrough(import_picocolors2.default.dim(u)))}` : a === "active-selected" ? `${import_picocolors2.default.green(U2)} ${o}${i.hint ? ` ${import_picocolors2.default.dim(`(${i.hint})`)}` : ""}` : a === "submitted" ? `${Z2(o, import_picocolors2.default.dim)}` : `${import_picocolors2.default.dim(q2)} ${Z2(o, import_picocolors2.default.dim)}`;
  }, s = t.required ?? true;
  return new Lt({ options: t.options, signal: t.signal, input: t.input, output: t.output, initialValues: t.initialValues, required: s, cursorAt: t.cursorAt, validate(i) {
    if (s && (i === void 0 || i.length === 0)) return `Please select at least one option.
${import_picocolors2.default.reset(import_picocolors2.default.dim(`Press ${import_picocolors2.default.gray(import_picocolors2.default.bgWhite(import_picocolors2.default.inverse(" space ")))} to select, ${import_picocolors2.default.gray(import_picocolors2.default.bgWhite(import_picocolors2.default.inverse(" enter ")))} to submit`))}`;
  }, render() {
    const i = xt(t.output, t.message, `${vt2(this.state)}  `, `${W2(this.state)}  `), a = `${import_picocolors2.default.gray(d)}
${i}
`, o = this.value ?? [], u = (l, n) => {
      if (l.disabled) return r(l, "disabled");
      const c = o.includes(l.value);
      return n && c ? r(l, "active-selected") : c ? r(l, "selected") : r(l, n ? "active" : "inactive");
    };
    switch (this.state) {
      case "submit": {
        const l = this.options.filter(({ value: c }) => o.includes(c)).map((c) => r(c, "submitted")).join(import_picocolors2.default.dim(", ")) || import_picocolors2.default.dim("none"), n = xt(t.output, l, `${import_picocolors2.default.gray(d)}  `);
        return `${a}${n}`;
      }
      case "cancel": {
        const l = this.options.filter(({ value: c }) => o.includes(c)).map((c) => r(c, "cancelled")).join(import_picocolors2.default.dim(", "));
        if (l.trim() === "") return `${a}${import_picocolors2.default.gray(d)}`;
        const n = xt(t.output, l, `${import_picocolors2.default.gray(d)}  `);
        return `${a}${n}
${import_picocolors2.default.gray(d)}`;
      }
      case "error": {
        const l = `${import_picocolors2.default.yellow(d)}  `, n = this.error.split(`
`).map((F, p) => p === 0 ? `${import_picocolors2.default.yellow(x2)}  ${import_picocolors2.default.yellow(F)}` : `   ${F}`).join(`
`), c = a.split(`
`).length, g = n.split(`
`).length + 1;
        return `${a}${l}${X2({ output: t.output, options: this.options, cursor: this.cursor, maxItems: t.maxItems, columnPadding: l.length, rowPadding: c + g, style: u }).join(`
${l}`)}
${n}
`;
      }
      default: {
        const l = `${import_picocolors2.default.cyan(d)}  `, n = a.split(`
`).length;
        return `${a}${l}${X2({ output: t.output, options: this.options, cursor: this.cursor, maxItems: t.maxItems, columnPadding: l.length, rowPadding: n + 2, style: u }).join(`
${l}`)}
${import_picocolors2.default.cyan(x2)}
`;
      }
    }
  } }).prompt();
};
var Ge = (t) => import_picocolors2.default.dim(t);
var ke = (t, r, s) => {
  const i = { hard: true, trim: false }, a = J2(t, r, i).split(`
`), o = a.reduce((n, c) => Math.max(M2(c), n), 0), u = a.map(s).reduce((n, c) => Math.max(M2(c), n), 0), l = r - (u - o);
  return J2(t, l, i);
};
var Ve = (t = "", r = "", s) => {
  const i = s?.output ?? N2.stdout, a = s?.withGuide ?? _.withGuide, o = s?.format ?? Ge, u = ["", ...ke(t, rt(i) - 6, o).split(`
`).map(o), ""], l = M2(r), n = Math.max(u.reduce((p, E) => {
    const $ = M2(E);
    return $ > p ? $ : p;
  }, 0), l) + 2, c = u.map((p) => `${import_picocolors2.default.gray(d)}  ${p}${" ".repeat(n - M2(p))}${import_picocolors2.default.gray(d)}`).join(`
`), g = a ? `${import_picocolors2.default.gray(d)}
` : "", F = a ? Wt2 : gt2;
  i.write(`${g}${import_picocolors2.default.green(V)}  ${import_picocolors2.default.reset(r)} ${import_picocolors2.default.gray(rt2.repeat(Math.max(n - l - 1, 1)) + mt2)}
${c}
${import_picocolors2.default.gray(F + rt2.repeat(n + 2) + pt2)}
`);
};
var He = (t) => new Mt({ validate: t.validate, mask: t.mask ?? Nt, signal: t.signal, input: t.input, output: t.output, render() {
  const r = t.withGuide ?? _.withGuide, s = `${r ? `${import_picocolors2.default.gray(d)}
` : ""}${W2(this.state)}  ${t.message}
`, i = this.userInputWithCursor, a = this.masked;
  switch (this.state) {
    case "error": {
      const o = r ? `${import_picocolors2.default.yellow(d)}  ` : "", u = r ? `${import_picocolors2.default.yellow(x2)}  ` : "", l = a ?? "";
      return t.clearOnError && this.clear(), `${s.trim()}
${o}${l}
${u}${import_picocolors2.default.yellow(this.error)}
`;
    }
    case "submit": {
      const o = r ? `${import_picocolors2.default.gray(d)}  ` : "", u = a ? import_picocolors2.default.dim(a) : "";
      return `${s}${o}${u}`;
    }
    case "cancel": {
      const o = r ? `${import_picocolors2.default.gray(d)}  ` : "", u = a ? import_picocolors2.default.strikethrough(import_picocolors2.default.dim(a)) : "";
      return `${s}${o}${u}${a && r ? `
${import_picocolors2.default.gray(d)}` : ""}`;
    }
    default: {
      const o = r ? `${import_picocolors2.default.cyan(d)}  ` : "", u = r ? import_picocolors2.default.cyan(x2) : "";
      return `${s}${o}${i}
${u}
`;
    }
  }
} }).prompt();
var Ke = import_picocolors2.default.magenta;
var bt2 = ({ indicator: t = "dots", onCancel: r, output: s = process.stdout, cancelMessage: i, errorMessage: a, frames: o = et2 ? ["\u25D2", "\u25D0", "\u25D3", "\u25D1"] : ["\u2022", "o", "O", "0"], delay: u = et2 ? 80 : 120, signal: l, ...n } = {}) => {
  const c = ct2();
  let g, F, p = false, E = false, $ = "", m, h = performance.now();
  const y2 = rt(s), f = n?.styleFrame ?? Ke, v = (b) => {
    const O2 = b > 1 ? a ?? _.messages.error : i ?? _.messages.cancel;
    E = b === 1, p && (L2(O2, b), E && typeof r == "function" && r());
  }, S2 = () => v(2), I2 = () => v(1), B2 = () => {
    process.on("uncaughtExceptionMonitor", S2), process.on("unhandledRejection", S2), process.on("SIGINT", I2), process.on("SIGTERM", I2), process.on("exit", v), l && l.addEventListener("abort", I2);
  }, A = () => {
    process.removeListener("uncaughtExceptionMonitor", S2), process.removeListener("unhandledRejection", S2), process.removeListener("SIGINT", I2), process.removeListener("SIGTERM", I2), process.removeListener("exit", v), l && l.removeEventListener("abort", I2);
  }, w = () => {
    if (m === void 0) return;
    c && s.write(`
`);
    const b = J2(m, y2, { hard: true, trim: false }).split(`
`);
    b.length > 1 && s.write(import_sisteransi2.cursor.up(b.length - 1)), s.write(import_sisteransi2.cursor.to(0)), s.write(import_sisteransi2.erase.down());
  }, _2 = (b) => b.replace(/\.+$/, ""), D2 = (b) => {
    const O2 = (performance.now() - b) / 1e3, j2 = Math.floor(O2 / 60), G2 = Math.floor(O2 % 60);
    return j2 > 0 ? `[${j2}m ${G2}s]` : `[${G2}s]`;
  }, T2 = n.withGuide ?? _.withGuide, Y = (b = "") => {
    p = true, g = Bt({ output: s }), $ = _2(b), h = performance.now(), T2 && s.write(`${import_picocolors2.default.gray(d)}
`);
    let O2 = 0, j2 = 0;
    B2(), F = setInterval(() => {
      if (c && $ === m) return;
      w(), m = $;
      const G2 = f(o[O2]);
      let tt2;
      if (c) tt2 = `${G2}  ${$}...`;
      else if (t === "timer") tt2 = `${G2}  ${$} ${D2(h)}`;
      else {
        const te = ".".repeat(Math.floor(j2)).slice(0, 3);
        tt2 = `${G2}  ${$}${te}`;
      }
      const Zt = J2(tt2, y2, { hard: true, trim: false });
      s.write(Zt), O2 = O2 + 1 < o.length ? O2 + 1 : 0, j2 = j2 < 4 ? j2 + 0.125 : 0;
    }, u);
  }, L2 = (b = "", O2 = 0, j2 = false) => {
    if (!p) return;
    p = false, clearInterval(F), w();
    const G2 = O2 === 0 ? import_picocolors2.default.green(V) : O2 === 1 ? import_picocolors2.default.red(dt2) : import_picocolors2.default.red($t2);
    $ = b ?? $, j2 || (t === "timer" ? s.write(`${G2}  ${$} ${D2(h)}
`) : s.write(`${G2}  ${$}
`)), A(), g();
  };
  return { start: Y, stop: (b = "") => L2(b, 0), message: (b = "") => {
    $ = _2(b ?? $);
  }, cancel: (b = "") => L2(b, 1), error: (b = "") => L2(b, 2), clear: () => L2("", 0, true), get isCancelled() {
    return E;
  } };
};
var zt = { light: C("\u2500", "-"), heavy: C("\u2501", "="), block: C("\u2588", "#") };
var lt2 = (t, r) => t.includes(`
`) ? t.split(`
`).map((s) => r(s)).join(`
`) : r(t);
var Je = (t) => {
  const r = (s, i) => {
    const a = s.label ?? String(s.value);
    switch (i) {
      case "disabled":
        return `${import_picocolors2.default.gray(H2)} ${lt2(a, import_picocolors2.default.gray)}${s.hint ? ` ${import_picocolors2.default.dim(`(${s.hint ?? "disabled"})`)}` : ""}`;
      case "selected":
        return `${lt2(a, import_picocolors2.default.dim)}`;
      case "active":
        return `${import_picocolors2.default.green(Q2)} ${a}${s.hint ? ` ${import_picocolors2.default.dim(`(${s.hint})`)}` : ""}`;
      case "cancelled":
        return `${lt2(a, (o) => import_picocolors2.default.strikethrough(import_picocolors2.default.dim(o)))}`;
      default:
        return `${import_picocolors2.default.dim(H2)} ${lt2(a, import_picocolors2.default.dim)}`;
    }
  };
  return new Wt({ options: t.options, signal: t.signal, input: t.input, output: t.output, initialValue: t.initialValue, render() {
    const s = t.withGuide ?? _.withGuide, i = `${W2(this.state)}  `, a = `${vt2(this.state)}  `, o = xt(t.output, t.message, a, i), u = `${s ? `${import_picocolors2.default.gray(d)}
` : ""}${o}
`;
    switch (this.state) {
      case "submit": {
        const l = s ? `${import_picocolors2.default.gray(d)}  ` : "", n = xt(t.output, r(this.options[this.cursor], "selected"), l);
        return `${u}${n}`;
      }
      case "cancel": {
        const l = s ? `${import_picocolors2.default.gray(d)}  ` : "", n = xt(t.output, r(this.options[this.cursor], "cancelled"), l);
        return `${u}${n}${s ? `
${import_picocolors2.default.gray(d)}` : ""}`;
      }
      default: {
        const l = s ? `${import_picocolors2.default.cyan(d)}  ` : "", n = s ? import_picocolors2.default.cyan(x2) : "", c = u.split(`
`).length, g = s ? 2 : 1;
        return `${u}${l}${X2({ output: t.output, cursor: this.cursor, options: this.options, maxItems: t.maxItems, columnPadding: l.length, rowPadding: c + g, style: (F, p) => r(F, F.disabled ? "disabled" : p ? "active" : "inactive") }).join(`
${l}`)}
${n}
`;
      }
    }
  } }).prompt();
};
var Qt = `${import_picocolors2.default.gray(d)}  `;
var Ye = async (t, r) => {
  for (const s of t) {
    if (s.enabled === false) continue;
    const i = bt2(r);
    i.start(s.title);
    const a = await s.task(i.message);
    i.stop(a || s.title);
  }
};
var Ze = (t) => new $t({ validate: t.validate, placeholder: t.placeholder, defaultValue: t.defaultValue, initialValue: t.initialValue, output: t.output, signal: t.signal, input: t.input, render() {
  const r = t?.withGuide ?? _.withGuide, s = `${`${r ? `${import_picocolors2.default.gray(d)}
` : ""}${W2(this.state)}  `}${t.message}
`, i = t.placeholder ? import_picocolors2.default.inverse(t.placeholder[0]) + import_picocolors2.default.dim(t.placeholder.slice(1)) : import_picocolors2.default.inverse(import_picocolors2.default.hidden("_")), a = this.userInput ? this.userInputWithCursor : i, o = this.value ?? "";
  switch (this.state) {
    case "error": {
      const u = this.error ? `  ${import_picocolors2.default.yellow(this.error)}` : "", l = r ? `${import_picocolors2.default.yellow(d)}  ` : "", n = r ? import_picocolors2.default.yellow(x2) : "";
      return `${s.trim()}
${l}${a}
${n}${u}
`;
    }
    case "submit": {
      const u = o ? `  ${import_picocolors2.default.dim(o)}` : "", l = r ? import_picocolors2.default.gray(d) : "";
      return `${s}${l}${u}`;
    }
    case "cancel": {
      const u = o ? `  ${import_picocolors2.default.strikethrough(import_picocolors2.default.dim(o))}` : "", l = r ? import_picocolors2.default.gray(d) : "";
      return `${s}${l}${u}${o.trim() ? `
${l}` : ""}`;
    }
    default: {
      const u = r ? `${import_picocolors2.default.cyan(d)}  ` : "", l = r ? import_picocolors2.default.cyan(x2) : "";
      return `${s}${u}${a}
${l}
`;
    }
  }
} }).prompt();

// src/steps/welcome.ts
var import_picocolors3 = __toESM(require_picocolors(), 1);
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
  We(import_picocolors3.default.bgCyan(import_picocolors3.default.black(" claude-mem installer ")));
  R2.info(`Version: 1.0.0`);
  R2.info(`Platform: ${process.platform} (${process.arch})`);
  const settingsExist = existsSync(expandHome("~/.claude-mem/settings.json"));
  const pluginExist = existsSync(expandHome("~/.claude/plugins/marketplaces/thedotmack/"));
  const alreadyInstalled = settingsExist && pluginExist;
  if (alreadyInstalled) {
    R2.warn("Existing claude-mem installation detected.");
  }
  const installMode = await Je({
    message: "What would you like to do?",
    options: alreadyInstalled ? [
      { value: "upgrade", label: "Upgrade", hint: "update to latest version" },
      { value: "configure", label: "Configure", hint: "change settings only" },
      { value: "fresh", label: "Fresh Install", hint: "reinstall from scratch" }
    ] : [
      { value: "fresh", label: "Fresh Install", hint: "recommended" },
      { value: "configure", label: "Configure Only", hint: "set up settings without installing" }
    ]
  });
  if (Ct(installMode)) {
    Ne("Installation cancelled.");
    process.exit(0);
  }
  return installMode;
}

// src/steps/dependencies.ts
var import_picocolors4 = __toESM(require_picocolors(), 1);

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
  await Ye([
    {
      title: "Checking Node.js",
      task: async () => {
        const version = process.version.slice(1);
        if (compareVersions(version, "18.0.0")) {
          status.nodeOk = true;
          return `Node.js ${process.version} ${import_picocolors4.default.green("\u2713")}`;
        }
        return `Node.js ${process.version} \u2014 requires >= 18.0.0 ${import_picocolors4.default.red("\u2717")}`;
      }
    },
    {
      title: "Checking git",
      task: async () => {
        const info = findBinary("git");
        if (info.found) {
          status.gitOk = true;
          return `git ${info.version ?? ""} ${import_picocolors4.default.green("\u2713")}`;
        }
        return `git not found ${import_picocolors4.default.red("\u2717")}`;
      }
    },
    {
      title: "Checking Bun",
      task: async () => {
        const info = findBinary("bun", BUN_EXTRA_PATHS);
        if (info.found && info.version && compareVersions(info.version, "1.1.14")) {
          status.bunOk = true;
          status.bunPath = info.path;
          return `Bun ${info.version} ${import_picocolors4.default.green("\u2713")}`;
        }
        if (info.found && info.version) {
          return `Bun ${info.version} \u2014 requires >= 1.1.14 ${import_picocolors4.default.yellow("\u26A0")}`;
        }
        return `Bun not found ${import_picocolors4.default.yellow("\u26A0")}`;
      }
    },
    {
      title: "Checking uv",
      task: async () => {
        const info = findBinary("uv", UV_EXTRA_PATHS);
        if (info.found) {
          status.uvOk = true;
          status.uvPath = info.path;
          return `uv ${info.version ?? ""} ${import_picocolors4.default.green("\u2713")}`;
        }
        return `uv not found ${import_picocolors4.default.yellow("\u26A0")}`;
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
    Ne("Please install git and try again.");
    process.exit(1);
  }
  if (!status.nodeOk) {
    R2.error(`Node.js >= 18.0.0 is required. Current: ${process.version}`);
    Ne("Please upgrade Node.js and try again.");
    process.exit(1);
  }
  if (!status.bunOk) {
    const shouldInstall = await Re({
      message: "Bun is required but not found. Install it now?",
      initialValue: true
    });
    if (Ct(shouldInstall)) {
      Ne("Installation cancelled.");
      process.exit(0);
    }
    if (shouldInstall) {
      const s = bt2();
      s.start("Installing Bun...");
      try {
        installBun();
        const recheck = findBinary("bun", BUN_EXTRA_PATHS);
        if (recheck.found) {
          status.bunOk = true;
          status.bunPath = recheck.path;
          s.stop(`Bun installed ${import_picocolors4.default.green("\u2713")}`);
        } else {
          s.stop(`Bun installed but not found in PATH. You may need to restart your shell.`);
        }
      } catch {
        s.stop(`Bun installation failed. Install manually: curl -fsSL https://bun.sh/install | bash`);
      }
    } else {
      R2.warn("Bun is required for claude-mem. Install manually: curl -fsSL https://bun.sh/install | bash");
      Ne("Cannot continue without Bun.");
      process.exit(1);
    }
  }
  if (!status.uvOk) {
    const shouldInstall = await Re({
      message: "uv (Python package manager) is recommended for Chroma. Install it now?",
      initialValue: true
    });
    if (Ct(shouldInstall)) {
      Ne("Installation cancelled.");
      process.exit(0);
    }
    if (shouldInstall) {
      const s = bt2();
      s.start("Installing uv...");
      try {
        installUv();
        const recheck = findBinary("uv", UV_EXTRA_PATHS);
        if (recheck.found) {
          status.uvOk = true;
          status.uvPath = recheck.path;
          s.stop(`uv installed ${import_picocolors4.default.green("\u2713")}`);
        } else {
          s.stop("uv installed but not found in PATH. You may need to restart your shell.");
        }
      } catch {
        s.stop("uv installation failed. Install manually: curl -fsSL https://astral.sh/uv/install.sh | sh");
      }
    } else {
      R2.warn("Skipping uv \u2014 Chroma vector search will not be available.");
    }
  }
  return status;
}

// src/steps/ide-selection.ts
async function runIdeSelection() {
  const result = await je({
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
    Ne("Installation cancelled.");
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
  const provider = await Je({
    message: "Which AI provider should claude-mem use for memory compression?",
    options: [
      { value: "claude", label: "Claude", hint: "uses your Claude subscription" },
      { value: "gemini", label: "Gemini", hint: "free tier available" },
      { value: "openrouter", label: "OpenRouter", hint: "free models available" }
    ]
  });
  if (Ct(provider)) {
    Ne("Installation cancelled.");
    process.exit(0);
  }
  const config = { provider };
  if (provider === "claude") {
    const authMethod = await Je({
      message: "How should Claude authenticate?",
      options: [
        { value: "cli", label: "CLI (Max Plan subscription)", hint: "no API key needed" },
        { value: "api", label: "API Key", hint: "uses Anthropic API credits" }
      ]
    });
    if (Ct(authMethod)) {
      Ne("Installation cancelled.");
      process.exit(0);
    }
    config.claudeAuthMethod = authMethod;
    if (authMethod === "api") {
      const apiKey = await He({
        message: "Enter your Anthropic API key:",
        validate: (value) => {
          if (!value || value.trim().length === 0) return "API key is required";
          if (!value.startsWith("sk-ant-")) return "Anthropic API keys start with sk-ant-";
        }
      });
      if (Ct(apiKey)) {
        Ne("Installation cancelled.");
        process.exit(0);
      }
      config.apiKey = apiKey;
    }
  }
  if (provider === "gemini") {
    const apiKey = await He({
      message: "Enter your Gemini API key:",
      validate: (value) => {
        if (!value || value.trim().length === 0) return "API key is required";
      }
    });
    if (Ct(apiKey)) {
      Ne("Installation cancelled.");
      process.exit(0);
    }
    config.apiKey = apiKey;
    const model = await Je({
      message: "Which Gemini model?",
      options: [
        { value: "gemini-2.5-flash-lite", label: "Gemini 2.5 Flash Lite", hint: "fastest, highest free RPM" },
        { value: "gemini-2.5-flash", label: "Gemini 2.5 Flash", hint: "balanced" },
        { value: "gemini-3-flash-preview", label: "Gemini 3 Flash Preview", hint: "latest" }
      ]
    });
    if (Ct(model)) {
      Ne("Installation cancelled.");
      process.exit(0);
    }
    config.model = model;
    const rateLimiting = await Re({
      message: "Enable rate limiting? (recommended for free tier)",
      initialValue: true
    });
    if (Ct(rateLimiting)) {
      Ne("Installation cancelled.");
      process.exit(0);
    }
    config.rateLimitingEnabled = rateLimiting;
  }
  if (provider === "openrouter") {
    const apiKey = await He({
      message: "Enter your OpenRouter API key:",
      validate: (value) => {
        if (!value || value.trim().length === 0) return "API key is required";
      }
    });
    if (Ct(apiKey)) {
      Ne("Installation cancelled.");
      process.exit(0);
    }
    config.apiKey = apiKey;
    const model = await Ze({
      message: "Which OpenRouter model?",
      defaultValue: "xiaomi/mimo-v2-flash:free",
      placeholder: "xiaomi/mimo-v2-flash:free"
    });
    if (Ct(model)) {
      Ne("Installation cancelled.");
      process.exit(0);
    }
    config.model = model;
  }
  return config;
}

// src/steps/settings.ts
var import_picocolors5 = __toESM(require_picocolors(), 1);
async function runSettingsConfiguration() {
  const useDefaults = await Re({
    message: "Use default settings? (recommended for most users)",
    initialValue: true
  });
  if (Ct(useDefaults)) {
    Ne("Installation cancelled.");
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
  const workerPort = await Ze({
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
    Ne("Installation cancelled.");
    process.exit(0);
  }
  const dataDir = await Ze({
    message: "Data directory:",
    defaultValue: "~/.claude-mem",
    placeholder: "~/.claude-mem"
  });
  if (Ct(dataDir)) {
    Ne("Installation cancelled.");
    process.exit(0);
  }
  const contextObservations = await Ze({
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
    Ne("Installation cancelled.");
    process.exit(0);
  }
  const logLevel = await Je({
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
    Ne("Installation cancelled.");
    process.exit(0);
  }
  const pythonVersion = await Ze({
    message: "Python version (for Chroma):",
    defaultValue: "3.13",
    placeholder: "3.13"
  });
  if (Ct(pythonVersion)) {
    Ne("Installation cancelled.");
    process.exit(0);
  }
  const chromaEnabled = await Re({
    message: "Enable Chroma vector search?",
    initialValue: true
  });
  if (Ct(chromaEnabled)) {
    Ne("Installation cancelled.");
    process.exit(0);
  }
  let chromaMode;
  let chromaHost;
  let chromaPort;
  let chromaSsl;
  if (chromaEnabled) {
    const mode = await Je({
      message: "Chroma mode:",
      options: [
        { value: "local", label: "Local", hint: "starts local Chroma server" },
        { value: "remote", label: "Remote", hint: "connect to existing server" }
      ]
    });
    if (Ct(mode)) {
      Ne("Installation cancelled.");
      process.exit(0);
    }
    chromaMode = mode;
    if (mode === "remote") {
      const host = await Ze({
        message: "Chroma host:",
        defaultValue: "127.0.0.1",
        placeholder: "127.0.0.1"
      });
      if (Ct(host)) {
        Ne("Installation cancelled.");
        process.exit(0);
      }
      chromaHost = host;
      const port = await Ze({
        message: "Chroma port:",
        defaultValue: "8000",
        placeholder: "8000",
        validate: (value = "") => {
          const portNum = parseInt(value, 10);
          if (isNaN(portNum) || portNum < 1 || portNum > 65535) return "Port must be between 1 and 65535";
        }
      });
      if (Ct(port)) {
        Ne("Installation cancelled.");
        process.exit(0);
      }
      chromaPort = port;
      const ssl = await Re({
        message: "Use SSL for Chroma connection?",
        initialValue: false
      });
      if (Ct(ssl)) {
        Ne("Installation cancelled.");
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
    `Worker port: ${import_picocolors5.default.cyan(workerPort)}`,
    `Data directory: ${import_picocolors5.default.cyan(dataDir)}`,
    `Context observations: ${import_picocolors5.default.cyan(contextObservations)}`,
    `Log level: ${import_picocolors5.default.cyan(logLevel)}`,
    `Python version: ${import_picocolors5.default.cyan(pythonVersion)}`,
    `Chroma: ${chromaEnabled ? import_picocolors5.default.green("enabled") : import_picocolors5.default.dim("disabled")}`
  ];
  if (chromaEnabled && chromaMode) {
    summaryLines.push(`Chroma mode: ${import_picocolors5.default.cyan(chromaMode)}`);
  }
  Ve(summaryLines.join("\n"), "Settings Summary");
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
var import_picocolors6 = __toESM(require_picocolors(), 1);
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
  await Ye([
    {
      title: "Cloning claude-mem repository",
      task: async (message) => {
        message("Downloading latest release...");
        execSync3(
          `git clone --depth 1 https://github.com/thedotmack/claude-mem.git "${tempDir}"`,
          { stdio: "pipe" }
        );
        return `Repository cloned ${import_picocolors6.default.green("OK")}`;
      }
    },
    {
      title: "Installing dependencies",
      task: async (message) => {
        message("Running npm install...");
        execSync3("npm install", { cwd: tempDir, stdio: "pipe" });
        return `Dependencies installed ${import_picocolors6.default.green("OK")}`;
      }
    },
    {
      title: "Building plugin",
      task: async (message) => {
        message("Compiling TypeScript and bundling...");
        execSync3("npm run build", { cwd: tempDir, stdio: "pipe" });
        return `Plugin built ${import_picocolors6.default.green("OK")}`;
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
        return `Plugin registered (v${getPluginVersion()}) ${import_picocolors6.default.green("OK")}`;
      }
    }
  ]);
  try {
    execSync3(`rm -rf "${tempDir}"`, { stdio: "pipe" });
  } catch {
  }
  if (selectedIDEs.includes("cursor")) {
    R2.info("Cursor hook configuration will be available after first launch.");
    R2.info("Run: claude-mem cursor-setup (coming soon)");
  }
}

// src/steps/worker.ts
var import_picocolors7 = __toESM(require_picocolors(), 1);
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
  const s = bt2();
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
    s.stop(`Worker running on port ${import_picocolors7.default.cyan(workerPort)} ${import_picocolors7.default.green("OK")}`);
  } else {
    s.stop(`Worker may still be starting. Check logs at: ${logPath}`);
    R2.warn("Health check timed out. The worker might need more time to initialize.");
    R2.info(`Check status: curl http://127.0.0.1:${workerPort}/api/health`);
  }
}

// src/steps/complete.ts
var import_picocolors8 = __toESM(require_picocolors(), 1);
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
    `Provider:   ${import_picocolors8.default.cyan(getProviderLabel(providerConfig))}`,
    `IDEs:       ${import_picocolors8.default.cyan(getIDELabels(selectedIDEs))}`,
    `Data dir:   ${import_picocolors8.default.cyan(settingsConfig.dataDir)}`,
    `Port:       ${import_picocolors8.default.cyan(settingsConfig.workerPort)}`,
    `Chroma:     ${settingsConfig.chromaEnabled ? import_picocolors8.default.green("enabled") : import_picocolors8.default.dim("disabled")}`
  ];
  Ve(summaryLines.join("\n"), "Configuration Summary");
  const nextStepsLines = [];
  if (selectedIDEs.includes("claude-code")) {
    nextStepsLines.push("Open Claude Code and start a conversation \u2014 memory is automatic!");
  }
  if (selectedIDEs.includes("cursor")) {
    nextStepsLines.push("Open Cursor \u2014 hooks are active in your projects.");
  }
  nextStepsLines.push(`View your memories: ${import_picocolors8.default.underline(`http://localhost:${settingsConfig.workerPort}`)}`);
  nextStepsLines.push(`Search past work: use ${import_picocolors8.default.bold("/mem-search")} in Claude Code`);
  Ve(nextStepsLines.join("\n"), "Next Steps");
  Le(import_picocolors8.default.green("claude-mem installed successfully!"));
}

// src/index.ts
async function runInstaller() {
  if (!process.stdin.isTTY) {
    console.error("Error: This installer requires an interactive terminal.");
    console.error("Run directly: npx claude-mem-installer");
    process.exit(1);
  }
  const installMode = await runWelcome();
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
  Ne("Installation failed.");
  console.error(error);
  process.exit(1);
});
