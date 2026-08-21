import type { Cinematography } from "@/lib/engine/types";

/**
 * Built-in cinematic frame renderer.
 *
 * Generates a deterministic 9:16 film still as SVG, composed entirely from the
 * scene's emotional cinematography — palette, light direction, grain, vignette
 * and haze all come from the emotion engine. This is a real renderer, not a
 * placeholder: the same scene always produces the same frame, and a different
 * emotional state produces a visibly different one.
 *
 * When an image/video provider key is configured, the provider layer uses that
 * instead and this becomes the fallback path.
 */

const W = 1080;
const H = 1920;

/** Small deterministic PRNG (mulberry32) seeded from the scene descriptor. */
function rng(seed: string) {
  let h = 1779033703 ^ seed.length;
  for (let i = 0; i < seed.length; i++) {
    h = Math.imul(h ^ seed.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  let a = h >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface FrameSpec {
  seed: string;
  cinematography: Cinematography;
  /** Scene slug drives the environment: interior, exterior, vehicle, water… */
  slug: string;
  /** 0..1 — how deep into the story we are; late scenes sit lower and heavier. */
  progress: number;
}

type Env = "city" | "interior" | "vehicle" | "water" | "corridor" | "rooftop";

function envFor(slug: string): Env {
  const s = slug.toLowerCase();
  if (s.includes("car") || s.includes("vehicle") || s.includes("driving")) return "vehicle";
  if (s.includes("river") || s.includes("water") || s.includes("bridge")) return "water";
  if (s.includes("hallway") || s.includes("stairwell") || s.includes("corridor") || s.includes("garage")) return "corridor";
  if (s.includes("roof")) return "rooftop";
  if (s.startsWith("int.") || s.includes("apartment") || s.includes("kitchen") || s.includes("bedroom") || s.includes("diner") || s.includes("office")) return "interior";
  return "city";
}

const esc = (s: string) => s.replace(/[<>&"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" }[c]!));

function skyline(rand: () => number, baseY: number): string {
  let d = `M 0 ${H} L 0 ${baseY}`;
  let x = 0;
  while (x < W) {
    const w = 40 + rand() * 120;
    const h = 60 + rand() * 340;
    const y = baseY - h;
    d += ` L ${x.toFixed(0)} ${y.toFixed(0)} L ${(x + w).toFixed(0)} ${y.toFixed(0)}`;
    x += w;
  }
  d += ` L ${W} ${baseY} L ${W} ${H} Z`;
  return d;
}

function windows(rand: () => number, baseY: number, glow: string): string {
  const out: string[] = [];
  const n = 90;
  for (let i = 0; i < n; i++) {
    if (rand() > 0.55) continue;
    const x = rand() * W;
    const y = baseY - rand() * 360;
    const w = 4 + rand() * 7;
    const h = 6 + rand() * 10;
    out.push(`<rect x="${x.toFixed(0)}" y="${y.toFixed(0)}" width="${w.toFixed(0)}" height="${h.toFixed(0)}" fill="${glow}" opacity="${(0.12 + rand() * 0.5).toFixed(2)}"/>`);
  }
  return out.join("");
}

function rain(rand: () => number, amount: number, glow: string): string {
  const out: string[] = [];
  const n = Math.round(amount * 220);
  for (let i = 0; i < n; i++) {
    const x = rand() * W;
    const y = rand() * H;
    const len = 18 + rand() * 46;
    out.push(`<line x1="${x.toFixed(0)}" y1="${y.toFixed(0)}" x2="${(x - 6).toFixed(0)}" y2="${(y + len).toFixed(0)}" stroke="${glow}" stroke-width="1.1" opacity="${(0.05 + rand() * 0.16).toFixed(2)}"/>`);
  }
  return out.join("");
}

/** The protagonist silhouette — framing follows the cinematography directive. */
function figure(c: Cinematography, progress: number): string {
  const tight = /tight|punched|close|intimate/.test(c.framing);
  const wide = /wide/.test(c.framing);
  const scale = tight ? 1.55 : wide ? 0.62 : 1;
  const cx = wide ? W * 0.36 : W * 0.5;
  const baseY = H * (wide ? 0.78 : 0.94) + progress * 20;
  const headR = 78 * scale;
  const headY = baseY - 470 * scale;
  const shoulderW = 240 * scale;

  return `
    <g opacity="0.94">
      <ellipse cx="${cx}" cy="${headY}" rx="${headR}" ry="${headR * 1.12}" fill="#000"/>
      <path d="M ${cx - shoulderW} ${baseY}
               C ${cx - shoulderW} ${headY + 180 * scale}, ${cx - 120 * scale} ${headY + 96 * scale}, ${cx} ${headY + 96 * scale}
               C ${cx + 120 * scale} ${headY + 96 * scale}, ${cx + shoulderW} ${headY + 180 * scale}, ${cx + shoulderW} ${baseY} Z"
            fill="#000"/>
    </g>`;
}

export function renderFrameSVG(spec: FrameSpec): string {
  const { cinematography: c, seed, slug, progress } = spec;
  const rand = rng(seed);
  const env = envFor(slug);
  const horizon = H * (env === "interior" || env === "vehicle" ? 0.52 : 0.62);

  // Light comes from the side for hard/side-lit looks, overhead otherwise.
  const sideLit = /side|hard|below/.test(c.lighting);
  const lightX = sideLit ? (rand() > 0.5 ? W * 0.18 : W * 0.82) : W * 0.5;
  const lightY = H * (sideLit ? 0.34 : 0.22);

  const wet = /rain|river|water/.test(slug.toLowerCase()) || c.dominant === "fear" || c.dominant === "regret";
  const rainAmount = wet ? 0.6 + c.grain * 0.5 : 0.12;

  const shafts: string[] = [];
  const shaftCount = env === "corridor" ? 5 : env === "interior" ? 3 : 4;
  for (let i = 0; i < shaftCount; i++) {
    const x = (i + 0.5) * (W / shaftCount) + (rand() - 0.5) * 90;
    const spread = 90 + rand() * 150;
    shafts.push(
      `<polygon points="${lightX.toFixed(0)},${lightY.toFixed(0)} ${(x - spread).toFixed(0)},${H} ${(x + spread).toFixed(0)},${H}" fill="url(#shaft)" opacity="${(0.1 + rand() * 0.16).toFixed(2)}"/>`,
    );
  }

  const environment =
    env === "interior" || env === "corridor"
      ? `<rect x="0" y="0" width="${W}" height="${H}" fill="url(#sky)"/>
         <rect x="0" y="${horizon}" width="${W}" height="${H - horizon}" fill="${c.palette.base}" opacity="0.9"/>
         <rect x="${W * 0.06}" y="${H * 0.16}" width="${W * 0.26}" height="${H * 0.3}" fill="${c.palette.glow}" opacity="0.07"/>
         <rect x="0" y="${horizon - 3}" width="${W}" height="3" fill="${c.palette.accent}" opacity="0.35"/>`
      : env === "vehicle"
        ? `<rect x="0" y="0" width="${W}" height="${H}" fill="url(#sky)"/>
           ${windows(rand, horizon, c.palette.glow)}
           <rect x="0" y="${H * 0.72}" width="${W}" height="${H * 0.28}" fill="#000" opacity="0.92"/>
           <rect x="${W * 0.08}" y="${H * 0.1}" width="${W * 0.84}" height="${H * 0.6}" rx="42" fill="none" stroke="#000" stroke-width="46" opacity="0.85"/>`
        : env === "water"
          ? `<rect x="0" y="0" width="${W}" height="${H}" fill="url(#sky)"/>
             <path d="${skyline(rand, horizon)}" fill="#000" opacity="0.88"/>
             ${windows(rand, horizon, c.palette.glow)}
             <rect x="0" y="${horizon}" width="${W}" height="${H - horizon}" fill="${c.palette.accent}" opacity="0.16"/>
             <rect x="0" y="${horizon}" width="${W}" height="${H - horizon}" fill="url(#ripple)" opacity="0.3"/>`
          : `<rect x="0" y="0" width="${W}" height="${H}" fill="url(#sky)"/>
             <path d="${skyline(rand, horizon)}" fill="#000" opacity="0.9"/>
             ${windows(rand, horizon, c.palette.glow)}
             <rect x="0" y="${horizon}" width="${W}" height="${H - horizon}" fill="${c.palette.base}" opacity="0.55"/>`;

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="${esc(slug)}">
  <defs>
    <linearGradient id="sky" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="${c.palette.fog}"/>
      <stop offset="55%" stop-color="${c.palette.base}"/>
      <stop offset="100%" stop-color="#000000"/>
    </linearGradient>
    <radialGradient id="key" cx="${(lightX / W).toFixed(3)}" cy="${(lightY / H).toFixed(3)}" r="0.72">
      <stop offset="0%" stop-color="${c.palette.glow}" stop-opacity="0.5"/>
      <stop offset="45%" stop-color="${c.palette.accent}" stop-opacity="0.18"/>
      <stop offset="100%" stop-color="${c.palette.base}" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="shaft" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="${c.palette.glow}" stop-opacity="0.5"/>
      <stop offset="100%" stop-color="${c.palette.glow}" stop-opacity="0"/>
    </linearGradient>
    <linearGradient id="ripple" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="${c.palette.glow}" stop-opacity="0.28"/>
      <stop offset="100%" stop-color="#000" stop-opacity="0"/>
    </linearGradient>
    <radialGradient id="vig" cx="0.5" cy="0.46" r="0.78">
      <stop offset="55%" stop-color="#000" stop-opacity="0"/>
      <stop offset="100%" stop-color="#000" stop-opacity="${c.vignette.toFixed(2)}"/>
    </radialGradient>
    <filter id="grain" x="0" y="0" width="100%" height="100%">
      <feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="3" seed="${Math.floor(rand() * 999)}" result="n"/>
      <feColorMatrix type="saturate" values="0" in="n" result="m"/>
      <feComponentTransfer in="m" result="g">
        <feFuncA type="linear" slope="${(c.grain * 0.55).toFixed(3)}"/>
      </feComponentTransfer>
    </filter>
    <filter id="haze" x="-20%" y="-20%" width="140%" height="140%">
      <feGaussianBlur stdDeviation="${(18 + c.grain * 26).toFixed(1)}"/>
    </filter>
  </defs>

  <rect width="${W}" height="${H}" fill="${c.palette.base}"/>
  ${environment}
  <g filter="url(#haze)" opacity="0.55"><rect width="${W}" height="${H}" fill="url(#key)"/></g>
  ${shafts.join("")}
  ${rain(rand, rainAmount, c.palette.glow)}
  ${figure(c, progress)}
  <rect width="${W}" height="${H}" fill="url(#key)" opacity="0.28" style="mix-blend-mode:screen"/>
  <rect width="${W}" height="${H}" fill="url(#vig)"/>
  <rect width="${W}" height="${H}" filter="url(#grain)" opacity="0.85"/>
  <rect x="0" y="0" width="${W}" height="${Math.round(H * 0.045)}" fill="#000"/>
  <rect x="0" y="${H - Math.round(H * 0.045)}" width="${W}" height="${Math.round(H * 0.045)}" fill="#000"/>
</svg>`;
}

/** Movie poster variant — same world, title-safe composition. */
export function renderPosterSVG(spec: FrameSpec & { title: string; tagline: string }): string {
  const base = renderFrameSVG(spec);
  const title = esc(spec.title.toUpperCase());
  const tagline = esc(spec.tagline.toUpperCase());
  const overlay = `
  <rect x="0" y="${H * 0.62}" width="${W}" height="${H * 0.38}" fill="#000" opacity="0.62"/>
  <text x="${W / 2}" y="${H * 0.79}" text-anchor="middle" font-family="Helvetica,Arial,sans-serif"
        font-size="104" font-weight="700" letter-spacing="-3" fill="#F5F3F0">${title}</text>
  <text x="${W / 2}" y="${H * 0.845}" text-anchor="middle" font-family="Helvetica,Arial,sans-serif"
        font-size="30" font-weight="500" letter-spacing="7" fill="#F5F3F0" opacity="0.62">${tagline}</text>
  <rect x="${W / 2 - 60}" y="${H * 0.865}" width="120" height="2" fill="#F5F3F0" opacity="0.35"/>
  <text x="${W / 2}" y="${H * 0.905}" text-anchor="middle" font-family="Helvetica,Arial,sans-serif"
        font-size="26" font-weight="600" letter-spacing="10" fill="#F5F3F0" opacity="0.5">FACE CARD</text>`;
  return base.replace("</svg>", `${overlay}</svg>`);
}

export function svgToDataUri(svg: string): string {
  return `data:image/svg+xml;base64,${Buffer.from(svg, "utf8").toString("base64")}`;
}
