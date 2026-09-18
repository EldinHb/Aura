/** Pure helpers for hint mode (Vimium-style keyboard clicking). */

export const HINT_ALPHABET = "asdfghjkl";

/** Generate `n` prefix-free labels from the home-row alphabet, all the same length. */
export function generateLabels(n: number, alphabet = HINT_ALPHABET): string[] {
  if (n <= 0) return [];
  const chars = [...alphabet];
  let len = 1;
  while (Math.pow(chars.length, len) < n) len++;
  const out: string[] = [];
  const total = Math.pow(chars.length, len);
  for (let i = 0; i < n && i < total; i++) {
    let x = i;
    let label = "";
    for (let k = 0; k < len; k++) {
      label = chars[x % chars.length] + label;
      x = Math.floor(x / chars.length);
    }
    out.push(label);
  }
  return out;
}

/** Labels that still match the typed prefix. */
export function filterLabels(labels: string[], typed: string): string[] {
  return labels.filter((l) => l.startsWith(typed));
}

export const HINT_SELECTOR =
  '[data-command], [data-hint], button, a[href], input, textarea, select, [tabindex]:not([tabindex="-1"])';

export type HintTarget = { el: HTMLElement; rect: DOMRect; label: string };

function isVisible(el: HTMLElement): boolean {
  if (el.hasAttribute("disabled") || el.getAttribute("aria-hidden") === "true") return false;
  const check = (el as HTMLElement & { checkVisibility?: () => boolean }).checkVisibility;
  if (typeof check === "function" && !check.call(el)) return false;
  const r = el.getBoundingClientRect();
  if (r.width <= 0 || r.height <= 0) return false;
  if (r.bottom < 0 || r.right < 0 || r.top > window.innerHeight || r.left > window.innerWidth) return false;
  const style = getComputedStyle(el);
  return style.visibility !== "hidden" && style.pointerEvents !== "none";
}

/** Collect visible interactive elements; when overlays are open, only elements inside the topmost one. */
export function collectHintTargets(root: ParentNode = document): HintTarget[] {
  const overlays = [...document.querySelectorAll<HTMLElement>(".overlay, .palette-overlay")];
  const scope: ParentNode = overlays.length > 0 ? overlays[overlays.length - 1] : root;
  const els = [...scope.querySelectorAll<HTMLElement>(HINT_SELECTOR)].filter(isVisible);
  const labels = generateLabels(els.length);
  return els.map((el, i) => ({ el, rect: el.getBoundingClientRect(), label: labels[i] }));
}

export function activateHintTarget(el: HTMLElement) {
  const tag = el.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el.isContentEditable) {
    el.focus();
    return;
  }
  el.focus({ preventScroll: true });
  el.click();
}
