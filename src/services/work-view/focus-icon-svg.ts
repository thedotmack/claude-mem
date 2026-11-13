/**
 * The check a generated focus icon passes before the worker saves it. An agent's answer is untrusted text, so this
 * reads it with its own small reader that knows only the icon subset of SVG, refuses everything else by name, and
 * answers the icon written out again from what it read. The saved file is that rewrite, never the agent's bytes, so
 * nothing a browser's parser would read differently from this one can ride along.
 */
import { MAX_FOCUS_ICON_SVG_BYTES } from './focus-icons.mjs';

const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';
const XLINK_NAMESPACE = 'http://www.w3.org/1999/xlink';
const MAX_ELEMENTS = 80;

const SHAPES = new Set(['path', 'circle', 'ellipse', 'rect', 'line', 'polyline', 'polygon']);
const ELEMENTS = new Set(['svg', 'g', 'defs', 'linearGradient', 'radialGradient', 'stop', 'title', ...SHAPES]);
const GRADIENTS = new Set(['linearGradient', 'radialGradient']);
const ATTRIBUTES = new Set([
  'xmlns', 'xmlns:xlink', 'viewBox', 'width', 'height', 'id', 'role', 'aria-label', 'aria-hidden',
  'd', 'points', 'cx', 'cy', 'r', 'rx', 'ry', 'x', 'y', 'x1', 'y1', 'x2', 'y2', 'fx', 'fy', 'transform',
  'fill', 'fill-opacity', 'fill-rule', 'clip-rule', 'opacity',
  'stroke', 'stroke-width', 'stroke-linecap', 'stroke-linejoin', 'stroke-miterlimit', 'stroke-dasharray', 'stroke-dashoffset', 'stroke-opacity', 'vector-effect',
  'offset', 'stop-color', 'stop-opacity', 'gradientUnits', 'gradientTransform', 'spreadMethod', 'href', 'xlink:href',
]);
const SAME_DOCUMENT_ID = /^#[A-Za-z_][\w.-]*$/;
const SAME_DOCUMENT_URL = /^url\(#[A-Za-z_][\w.-]*\)$/;
const TAG = /^<(\/?)([A-Za-z][A-Za-z0-9]*)((?:\s+[A-Za-z_][-A-Za-z0-9_:.]*\s*=\s*(?:"[^"<]*"|'[^'<]*'))*)\s*(\/?)>/;
const ATTRIBUTE = /([A-Za-z_][-A-Za-z0-9_:.]*)\s*=\s*(?:"([^"<]*)"|'([^'<]*)')/g;

export class FocusIconRefused extends Error {}
const refuse = (why: string): never => { throw new FocusIconRefused(`The icon was refused: ${why}.`); };

/** The `<svg>…</svg>` in an agent's answer, without a code fence or a sentence around it. Null when there is none. */
export function svgInAnswer(answer: string): string | null {
  const start = answer.indexOf('<svg');
  const end = answer.lastIndexOf('</svg>');
  return start === -1 || end < start ? null : answer.slice(start, end + '</svg>'.length);
}

function checkedAttribute(element: string, name: string, raw: string): string {
  const value = raw.trim();
  if (/^on/i.test(name)) refuse(`it has an event attribute (${name})`);
  if (name === 'style' || name === 'class') refuse(`it has a ${name} attribute; an icon sets its colors with fill and stroke`);
  if (!ATTRIBUTES.has(name)) refuse(`the attribute ${name} is not one an icon may use`);
  // A backslash is a CSS escape, which could spell url( without writing it.
  if (/[\\\u0000-\u001f]/.test(value)) refuse(`the attribute ${name} holds a character an icon may not use`);
  if (name === 'xmlns' || name === 'xmlns:xlink') {
    if (value !== (name === 'xmlns' ? SVG_NAMESPACE : XLINK_NAMESPACE)) refuse(`its ${name} is not the standard namespace`);
    return value;
  }
  if (name === 'href' || name === 'xlink:href') {
    if (!GRADIENTS.has(element)) refuse(`a ${element} may not link anywhere`);
    if (!SAME_DOCUMENT_ID.test(value)) refuse('it links outside the icon');
  } else if (/url\s*\(/i.test(value) && !SAME_DOCUMENT_URL.test(value)) refuse(`the attribute ${name} points outside the icon`);
  else if (/(?:javascript|data|https?|file)\s*:/i.test(value)) refuse(`the attribute ${name} holds a link`);
  return value;
}

const escaped = (text: string) => text.replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');

/**
 * The icon, rewritten from what was read: one `<svg>` with a square viewBox, only the icon elements and attributes,
 * and no link that leaves the document. Throws FocusIconRefused with the reason in plain words.
 */
export function validateFocusIconSvg(source: string): string {
  const text = source.trim();
  if (!text) refuse('the answer held no SVG');
  if (Buffer.byteLength(text, 'utf8') > MAX_FOCUS_ICON_SVG_BYTES) refuse(`it is larger than ${Math.round(MAX_FOCUS_ICON_SVG_BYTES / 1000)} KB`);
  if (/<!|<\?/.test(text)) refuse('it has a DOCTYPE, an entity, a comment or a processing instruction');
  if (text.includes('&')) refuse('it uses an entity');

  let at = 0, out = '', elements = 0, shapes = 0, rootClosed = false;
  const open: string[] = [];
  while (at < text.length) {
    const next = text.indexOf('<', at);
    const between = text.slice(at, next === -1 ? text.length : next);
    if (between.trim()) {
      if (open.at(-1) !== 'title') refuse('it has text outside a title');
      out += escaped(between.trim());
    }
    if (next === -1) break;
    const tag = TAG.exec(text.slice(next));
    if (!tag) { refuse('it is not well-formed SVG'); break; }
    const [whole, closing, name, attributeText, selfClosing] = tag;
    at = next + whole.length;
    if (name === 'script' || name === 'foreignObject' || name === 'style') refuse(`it has a <${name}> element`);
    if (!ELEMENTS.has(name)) refuse(`the element <${name}> is not one an icon may use`);
    if (rootClosed) refuse('it has more than one root element');
    if (closing) {
      if (attributeText.trim() || selfClosing || open.pop() !== name) refuse('it is not well-formed SVG');
      out += `</${name}>`;
      if (!open.length) rootClosed = true;
      continue;
    }
    if (!open.length && name !== 'svg') refuse('its root element is not <svg>');
    if (open.length && name === 'svg') refuse('it nests one <svg> in another');
    if (open.at(-1) === 'title') refuse('its title holds an element');
    if (++elements > MAX_ELEMENTS) refuse(`it has more than ${MAX_ELEMENTS} elements`);
    if (SHAPES.has(name)) shapes++;
    const attributes = new Map<string, string>();
    for (const [, attribute, double, single] of attributeText.matchAll(ATTRIBUTE)) {
      if (attributes.has(attribute)) refuse(`the attribute ${attribute} is written twice`);
      attributes.set(attribute, checkedAttribute(name, attribute, double ?? single ?? ''));
    }
    if (name === 'svg') {
      const box = (attributes.get('viewBox') ?? '').split(/[\s,]+/).filter(Boolean).map(Number);
      if (box.length !== 4 || box.some(value => !Number.isFinite(value)) || box[2] <= 0 || box[2] !== box[3]) refuse('it needs a square viewBox');
      // The page sizes the icon; the namespace is written once, here.
      attributes.delete('width'); attributes.delete('height'); attributes.delete('xmlns');
      out += `<svg xmlns="${SVG_NAMESPACE}"`;
    } else out += `<${name}`;
    for (const [attribute, value] of attributes) out += ` ${attribute}="${escaped(value)}"`;
    if (selfClosing) {
      out += '/>';
      if (!open.length) rootClosed = true;
    } else { out += '>'; open.push(name); }
  }
  if (open.length || !rootClosed) refuse('it is not well-formed SVG');
  if (!shapes) refuse('it draws nothing');
  return out;
}
