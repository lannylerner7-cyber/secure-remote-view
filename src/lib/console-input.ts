import type React from "react";

export function keyToVirtualKey(e: React.KeyboardEvent<HTMLElement>): number | null {
  const named: Record<string, number> = {
    Backspace: 0x08,
    Tab: 0x09,
    Enter: 0x0d,
    Escape: 0x1b,
    PageUp: 0x21,
    PageDown: 0x22,
    End: 0x23,
    Home: 0x24,
    ArrowLeft: 0x25,
    ArrowUp: 0x26,
    ArrowRight: 0x27,
    ArrowDown: 0x28,
    Insert: 0x2d,
    Delete: 0x2e,
    Shift: e.code === "ShiftRight" ? 0xa1 : 0xa0,
    Control: e.code === "ControlRight" ? 0xa3 : 0xa2,
    Alt: e.code === "AltRight" ? 0xa5 : 0xa4,
    Meta: e.code === "MetaRight" ? 0x5c : 0x5b,
  };
  if (named[e.key]) return named[e.key];

  const keyMatch = /^Key([A-Z])$/.exec(e.code);
  if (keyMatch) return keyMatch[1].charCodeAt(0);
  const digitMatch = /^Digit([0-9])$/.exec(e.code);
  if (digitMatch) return digitMatch[1].charCodeAt(0);
  const numpadMatch = /^Numpad([0-9])$/.exec(e.code);
  if (numpadMatch) return 0x60 + Number(numpadMatch[1]);

  const byCode: Record<string, number> = {
    Space: 0x20,
    NumpadEnter: 0x0d,
    NumpadMultiply: 0x6a,
    NumpadAdd: 0x6b,
    NumpadSubtract: 0x6d,
    NumpadDecimal: 0x6e,
    NumpadDivide: 0x6f,
    F1: 0x70,
    F2: 0x71,
    F3: 0x72,
    F4: 0x73,
    F5: 0x74,
    F6: 0x75,
    F7: 0x76,
    F8: 0x77,
    F9: 0x78,
    F10: 0x79,
    F11: 0x7a,
    F12: 0x7b,
  };
  return byCode[e.code] ?? null;
}

/**
 * Map a client-space point onto the visible remote surface, normalized 0..1.
 *
 * Both live layers — the WebRTC <video> and the JPEG <img> — are letterboxed
 * with object-contain inside the same element, so the rect maths is identical
 * and only the SOURCE dimensions differ (video.videoWidth/Height vs the frame
 * row's width/height). The caller passes whichever layer is currently visible.
 *
 * `source` is null while the active layer's natural size is still unknown (a
 * video element before its first decoded frame). We return null in that case
 * so the caller HOLDS the input rather than sending a click computed against a
 * guessed size — a wrong mapping during a transport swap lands the click in
 * the wrong place on the user's desktop.
 */
export function getContainedPoint(
  el: HTMLElement,
  clientX: number,
  clientY: number,
  source: { width: number; height: number } | null,
): { x: number; y: number } | null {
  if (!source) return null;
  const rect = el.getBoundingClientRect();
  const { width: sourceW, height: sourceH } = source;
  if (!sourceW || !sourceH || !rect.width || !rect.height) return null;

  const scale = Math.min(rect.width / sourceW, rect.height / sourceH);
  const renderedW = sourceW * scale;
  const renderedH = sourceH * scale;
  const renderedLeft = rect.left + (rect.width - renderedW) / 2;
  const renderedTop = rect.top + (rect.height - renderedH) / 2;
  const x = (clientX - renderedLeft) / renderedW;
  const y = (clientY - renderedTop) / renderedH;

  if (x < 0 || x > 1 || y < 0 || y > 1) return null;
  return { x, y };
}
