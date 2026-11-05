import type { GuideBoardPage } from "./guide-contract";

/**
 * Paints one caption page onto the physical board face. The layout searches
 * for the largest type size at which EVERY supplied word fits; tokens that are
 * wider than a line are broken across lines so nothing is ever clipped.
 */
const INK = "#0d1524";
const PANEL_EDGE = "#1b2a44";
const TEXT = "#f1f4fa";
const UPCOMING = "#b9c6da";
const ACCENT = "#6ea8ff";
const ACCENT_INK = "#06101f";
const MUTED = "#8ea2c2";

type Placed = { text: string; index: number; x: number; y: number; w: number };

function breakToken(ctx: CanvasRenderingContext2D, token: string, maxW: number): string[] {
  if (ctx.measureText(token).width <= maxW) return [token];
  const parts: string[] = [];
  let cur = "";
  for (const ch of Array.from(token)) {
    if (cur && ctx.measureText(cur + ch).width > maxW) {
      parts.push(cur);
      cur = ch;
    } else cur += ch;
  }
  if (cur) parts.push(cur);
  return parts;
}

function layout(
  ctx: CanvasRenderingContext2D,
  words: string[],
  size: number,
  font: string,
  maxW: number,
  maxH: number,
): { placed: Placed[]; lineH: number; fits: boolean } {
  ctx.font = `600 ${size}px ${font}`;
  const space = ctx.measureText(" ").width * 1.15;
  const lineH = size * 1.42;
  const placed: Placed[] = [];
  let x = 0;
  let line = 0;
  words.forEach((word, index) => {
    for (const piece of breakToken(ctx, word, maxW)) {
      const w = ctx.measureText(piece).width;
      if (x > 0 && x + w > maxW) {
        line += 1;
        x = 0;
      }
      placed.push({ text: piece, index, x, y: line * lineH, w });
      x += w + space;
    }
  });
  const used = words.length ? (line + 1) * lineH : 0;
  return { placed, lineH, fits: used <= maxH };
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function clampLines(ctx: CanvasRenderingContext2D, text: string, maxW: number, maxLines: number): string[] {
  const words = text.trim().split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let cur = "";
  for (const raw of words) {
    for (const word of breakToken(ctx, raw, maxW)) {
      const next = cur ? `${cur} ${word}` : word;
      if (ctx.measureText(next).width > maxW && cur) {
        lines.push(cur);
        cur = word;
      } else cur = next;
    }
  }
  if (cur) lines.push(cur);
  if (lines.length <= maxLines) return lines;
  const kept = lines.slice(0, maxLines);
  let last = kept[maxLines - 1];
  while (last.length > 1 && ctx.measureText(`${last}…`).width > maxW) last = last.slice(0, -1);
  kept[maxLines - 1] = `${last.trimEnd()}…`;
  return kept;
}

export function paintBoard(canvas: HTMLCanvasElement, page: GuideBoardPage | null, font: string) {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const W = canvas.width;
  const H = canvas.height;
  const bg = ctx.createLinearGradient(0, 0, 0, H);
  bg.addColorStop(0, "#111c30");
  bg.addColorStop(1, INK);
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);
  ctx.strokeStyle = PANEL_EDGE;
  ctx.lineWidth = W * 0.012;
  ctx.strokeRect(W * 0.006, W * 0.006, W - W * 0.012, H - W * 0.012);

  const pad = W * 0.075;
  const innerW = W - pad * 2;
  let y = pad;

  // Kicker
  ctx.fillStyle = ACCENT;
  ctx.fillRect(pad, y, W * 0.05, W * 0.009);
  ctx.font = `700 ${W * 0.03}px ${font}`;
  ctx.textBaseline = "top";
  ctx.fillStyle = MUTED;
  ctx.fillText("CONNECTLIVE  GUIDE", pad + W * 0.07, y - W * 0.011);
  y += W * 0.06;

  const heading = page?.heading?.trim() || "Ask me about ConnectLive";
  const hSize = W * 0.062;
  ctx.font = `700 ${hSize}px ${font}`;
  ctx.fillStyle = TEXT;
  for (const line of clampLines(ctx, heading, innerW, 2)) {
    ctx.fillText(line, pad, y);
    y += hSize * 1.18;
  }
  y += W * 0.025;
  ctx.fillStyle = "rgba(142,162,194,0.35)";
  ctx.fillRect(pad, y, innerW, Math.max(2, W * 0.003));
  y += W * 0.05;

  const footerH = W * 0.11;
  const bodyH = H - y - footerH - pad * 0.6;
  const words = page?.words?.filter((w) => w.length > 0) ?? [];
  const active = page?.activeWord ?? -1;

  if (words.length) {
    let size = W * 0.085;
    let result = layout(ctx, words, size, font, innerW, bodyH);
    while (!result.fits && size > W * 0.026) {
      size *= 0.94;
      result = layout(ctx, words, size, font, innerW, bodyH);
    }
    ctx.font = `600 ${size}px ${font}`;
    for (const p of result.placed) {
      const py = y + p.y;
      if (p.index === active) {
        ctx.fillStyle = ACCENT;
        roundRect(ctx, pad + p.x - size * 0.16, py - size * 0.1, p.w + size * 0.32, size * 1.28, size * 0.22);
        ctx.fill();
        ctx.fillStyle = ACCENT_INK;
      } else {
        ctx.fillStyle = active < 0 || p.index < active ? TEXT : UPCOMING;
      }
      ctx.fillText(p.text, pad + p.x, py);
    }
  } else {
    ctx.font = `500 ${W * 0.045}px ${font}`;
    ctx.fillStyle = UPCOMING;
    ctx.fillText("Pick a question below.", pad, y);
  }

  // Footer: status + page progress
  const fy = H - pad * 0.6 - footerH * 0.55;
  const status = (page?.status || "Ready").toUpperCase();
  ctx.font = `700 ${W * 0.032}px ${font}`;
  ctx.fillStyle = active >= 0 ? ACCENT : MUTED;
  ctx.beginPath();
  ctx.arc(pad + W * 0.012, fy + W * 0.016, W * 0.011, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = MUTED;
  const statusLines = clampLines(ctx, status, innerW * 0.55, 1);
  ctx.fillText(statusLines[0] ?? "", pad + W * 0.04, fy);
  if (page && page.pages > 0) {
    const label = `${page.page} / ${page.pages}`;
    ctx.fillStyle = TEXT;
    const lw = ctx.measureText(label).width;
    ctx.fillText(label, W - pad - lw, fy);
    const dots = Math.min(page.pages, 8);
    const gap = W * 0.03;
    const start = W - pad - lw - W * 0.04 - (dots - 1) * gap;
    for (let i = 0; i < dots; i++) {
      ctx.fillStyle = i === Math.min(page.page, dots) - 1 ? ACCENT : "rgba(142,162,194,0.45)";
      ctx.beginPath();
      ctx.arc(start + i * gap, fy + W * 0.016, W * 0.009, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}
