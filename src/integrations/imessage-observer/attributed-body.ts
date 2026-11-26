/**
 * Reads the plain text out of a Messages `attributedBody` blob.
 *
 * Since macOS Ventura, Messages often leaves `message.text` empty and keeps
 * the words only in `attributedBody`: an NSAttributedString archived with
 * Apple's old "typedstream" format (NSArchiver, not a plist). The string sits
 * right after the NSString class record:
 *
 *   … "NSString" 0x01 0x94 0x84 0x01 '+' <length> <UTF-8 bytes> …
 *
 * `+` is the typedstream code for a UTF-8 byte string. The length is a
 * typedstream integer: one byte below 0x80, or 0x81 and two bytes, or 0x82
 * and four bytes, little-endian. Only that one string is read; links,
 * mentions and formatting in the rest of the archive are ignored.
 */

const STREAM_HEADER = 'streamtyped';
const STRING_CLASSES = ['NSString', 'NSMutableString'];
/** How far past the class name the string's `+` tag may sit. */
const TAG_SEARCH_BYTES = 16;
const UTF8_TAG = 0x2b;
const INT16_TAG = 0x81;
const INT32_TAG = 0x82;

function indexOfBytes(haystack: Uint8Array, needle: Uint8Array, from = 0): number {
  outer: for (let i = from; i <= haystack.length - needle.length; i += 1) {
    for (let j = 0; j < needle.length; j += 1) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  return -1;
}

function readLength(blob: Uint8Array, at: number): { length: number; next: number } | null {
  const first = blob[at];
  if (first === undefined) return null;
  if (first < 0x80) return { length: first, next: at + 1 };
  if (first === INT16_TAG) {
    if (at + 2 >= blob.length) return null;
    return { length: blob[at + 1]! | (blob[at + 2]! << 8), next: at + 3 };
  }
  if (first === INT32_TAG) {
    if (at + 4 >= blob.length) return null;
    const length = (blob[at + 1]! | (blob[at + 2]! << 8) | (blob[at + 3]! << 16) | (blob[at + 4]! << 24)) >>> 0;
    return { length, next: at + 5 };
  }
  return null;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: false });

/** The message text inside an `attributedBody` blob, or null when it cannot be read. */
export function textFromAttributedBody(blob: Uint8Array | null | undefined): string | null {
  if (!blob || blob.length < 16) return null;
  if (indexOfBytes(blob.subarray(0, 32), encoder.encode(STREAM_HEADER)) < 0) return null;
  for (const name of STRING_CLASSES) {
    const at = indexOfBytes(blob, encoder.encode(name));
    if (at < 0) continue;
    const start = at + name.length;
    const end = Math.min(blob.length, start + TAG_SEARCH_BYTES);
    for (let i = start; i < end; i += 1) {
      if (blob[i] !== UTF8_TAG) continue;
      const read = readLength(blob, i + 1);
      if (!read || read.next + read.length > blob.length) continue;
      return decoder.decode(blob.subarray(read.next, read.next + read.length));
    }
  }
  return null;
}

/**
 * Builds a minimal `attributedBody` blob around `text`, in the layout
 * Messages writes. For tests and for the fake chat.db fixture only.
 */
export function attributedBodyFor(text: string): Uint8Array {
  const bytes = encoder.encode(text);
  const length = bytes.length < 0x80
    ? [bytes.length]
    : bytes.length <= 0xffff
      ? [INT16_TAG, bytes.length & 0xff, bytes.length >> 8]
      : [INT32_TAG, bytes.length & 0xff, (bytes.length >> 8) & 0xff, (bytes.length >> 16) & 0xff, (bytes.length >>> 24) & 0xff];
  const head = [
    0x04, 0x0b, ...encoder.encode(STREAM_HEADER), 0x81, 0xe8, 0x03, 0x84, 0x01, 0x40, 0x84, 0x84, 0x84,
    0x12, ...encoder.encode('NSAttributedString'), 0x00, 0x84, 0x84, 0x08, ...encoder.encode('NSObject'), 0x00,
    0x85, 0x92, 0x84, 0x84, 0x84, 0x08, ...encoder.encode('NSString'), 0x01, 0x94, 0x84, 0x01, UTF8_TAG,
    ...length,
  ];
  const tail = [
    0x86, 0x84, 0x02, 0x69, 0x49, 0x01, 0x05, 0x92, 0x84, 0x84, 0x84, 0x0c, ...encoder.encode('NSDictionary'),
    0x00, 0x94, 0x84, 0x01, 0x69, 0x01, 0x92, 0x84, 0x96, 0x96, 0x1d, ...encoder.encode('__kIMMessagePartAttributeName'),
    0x86, 0x92, 0x84, 0x84, 0x84, 0x08, ...encoder.encode('NSNumber'), 0x00, 0x84, 0x84, 0x07, ...encoder.encode('NSValue'),
    0x00, 0x94, 0x84, 0x01, 0x2a, 0x84, 0x99, 0x99, 0x00, 0x86, 0x86, 0x86,
  ];
  return new Uint8Array([...head, ...bytes, ...tail]);
}
