/**
 * Images attached in the composer and shown on sent messages.
 *
 * A draft keeps the file as a Blob plus a small `data:` thumbnail; it is only
 * read as base64 when sent. The daemon records each sent image on the user
 * message under `data.attachments` (thumbnail, name, size, and an id to fetch
 * the full image with `session.attachment`). Messages from before that carry
 * Codex's `data.content` images or ACP's `data.images` count instead.
 */
import type { CapabilitySet, ImageInput, ProviderKind } from "../gen";
import type { AcpSessionInfo } from "./acp";

export type DraftImage = {
  key: string;
  blob: Blob;
  name: string | null;
  media_type: string;
  width: number | null;
  height: number | null;
  thumbnail: string | null;
};

/** What every agent Aura drives accepts. Other formats are converted to PNG. */
const ACCEPTED = ["image/png", "image/jpeg", "image/gif", "image/webp"];
const THUMB_PX = 256;
/** Past this a PNG/WebP thumbnail is redone as JPEG; it is stored with every sent message. */
const THUMB_MAX_CHARS = 60_000;

let seq = 0;

function loadImage(blob: Blob): Promise<HTMLImageElement> {
  const url = URL.createObjectURL(blob);
  const img = new Image();
  return new Promise<HTMLImageElement>((resolve, reject) => {
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("cannot decode image"));
    img.src = url;
  }).finally(() => URL.revokeObjectURL(url));
}

function draw(img: HTMLImageElement, w: number, h: number, background?: string): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("no canvas");
  if (background) {
    ctx.fillStyle = background;
    ctx.fillRect(0, 0, w, h);
  }
  ctx.drawImage(img, 0, 0, w, h);
  return canvas;
}

function toBlob(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob> {
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("cannot encode image"))), type, quality));
}

/** Screenshots pasted on macOS are all called `image.png`; that name says nothing. */
function usefulName(name: string): string | null {
  return name && !/^image\.\w+$/i.test(name) ? name : null;
}

/** Reads dimensions and makes the thumbnail. Formats agents do not take become PNG. */
export async function prepareImage(file: File): Promise<DraftImage> {
  const draft: DraftImage = { key: `img-${++seq}`, blob: file, name: usefulName(file.name), media_type: file.type || "image/png", width: null, height: null, thumbnail: null };
  let img: HTMLImageElement;
  try {
    img = await loadImage(file);
  } catch {
    if (!ACCEPTED.includes(draft.media_type)) throw new Error(`${file.name || "this image"} is not a PNG, JPEG, GIF or WebP image`);
    return draft;
  }
  const width = img.naturalWidth;
  const height = img.naturalHeight;
  if (!width || !height) return draft;
  if (!ACCEPTED.includes(draft.media_type)) {
    draft.blob = await toBlob(draw(img, width, height), "image/png");
    draft.media_type = "image/png";
  }
  const scale = Math.min(1, THUMB_PX / Math.max(width, height));
  const w = Math.max(1, Math.round(width * scale));
  const h = Math.max(1, Math.round(height * scale));
  try {
    const jpeg = draft.media_type === "image/jpeg";
    let thumb = draw(img, w, h).toDataURL(jpeg ? "image/jpeg" : "image/webp", 0.8);
    if (thumb.length > THUMB_MAX_CHARS) thumb = draw(img, w, h, "#fff").toDataURL("image/jpeg", 0.75);
    draft.thumbnail = thumb;
  } catch {
    // No preview; the strip shows a placeholder.
  }
  return { ...draft, width, height };
}

function base64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ""));
    reader.onerror = () => reject(reader.error ?? new Error("cannot read image"));
    reader.readAsDataURL(blob);
  });
}

/**
 * What an agent takes per image. Images over either limit are shrunk when sent.
 *
 * - Claude Code: the API allows 8000 px and 10 MB base64, but 5 MB on Bedrock
 *   and Vertex, and only 2000 px per image once a request holds more than 20
 *   images. Claude Code resends every earlier image each turn, so a long
 *   session crosses that. Claude itself downscales past 1568 px (2576 px on
 *   4.7 and later), so 2000 px loses little.
 * - Codex shrinks images to fit 2048 px itself; doing it here keeps what the
 *   transcript keeps equal to what the model saw. The API has no per-image
 *   byte limit worth hitting, so 10 MB only keeps requests sane.
 * - ACP says nothing about limits, so ACP agents get the strictest known ones.
 */
export type ImageLimits = { maxEdge: number; maxBase64: number };
const STRICTEST: ImageLimits = { maxEdge: 2000, maxBase64: 5_000_000 };
export function imageLimits(provider: ProviderKind | undefined): ImageLimits {
  if (provider === "codex") return { maxEdge: 2048, maxBase64: 10_000_000 };
  return STRICTEST;
}

/** Length of the base64 text for `bytes` bytes; that is what the limits count. */
export const base64Length = (bytes: number) => 4 * Math.ceil(bytes / 3);

/** Largest size within `maxEdge` on both sides that keeps the aspect ratio. */
export function fitDimensions(width: number, height: number, maxEdge: number): { width: number; height: number } {
  const scale = Math.min(1, maxEdge / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

export type SendPlan =
  | { kind: "keep" }
  | { kind: "resize"; width: number; height: number }
  /** Over the limits and could not be decoded, so it cannot be shrunk. */
  | { kind: "blocked"; reason: string };

export function sendPlan(img: Pick<DraftImage, "width" | "height" | "media_type" | "name"> & { size: number }, limits: ImageLimits): SendPlan {
  const tooBig = base64Length(img.size) > limits.maxBase64;
  if (!img.width || !img.height) {
    if (!tooBig) return { kind: "keep" };
    const mb = (limits.maxBase64 / 1_000_000).toFixed(0);
    return { kind: "blocked", reason: `${img.name ?? "An image"} is over the ${mb} MB this agent accepts and could not be decoded to shrink it` };
  }
  const fit = fitDimensions(img.width, img.height, limits.maxEdge);
  if (fit.width === img.width && fit.height === img.height && !tooBig && ACCEPTED.includes(img.media_type)) return { kind: "keep" };
  return { kind: "resize", ...fit };
}

export const planFor = (img: DraftImage, limits: ImageLimits) => sendPlan({ ...img, size: img.blob.size }, limits);

/** Encodes the decoded image at a size; the result's type says what the webview really produced. */
export type Encoder = (width: number, height: number, type: string, quality?: number) => Promise<Blob>;

/**
 * Re-encodes at `width` × `height`, shrinking further until it fits the byte
 * limit. Screenshots and other lossless sources stay PNG when that fits, then
 * try WebP (where the webview can write it) and JPEG at high quality.
 */
export async function encodeWithin(width: number, height: number, sourceType: string, limits: ImageLimits, encode: Encoder): Promise<{ blob: Blob; width: number; height: number }> {
  let w = width;
  let h = height;
  const formats: [string, number | undefined][] = sourceType === "image/jpeg" ? [["image/jpeg", 0.92], ["image/jpeg", 0.85]] : [["image/png", undefined], ["image/webp", 0.92], ["image/jpeg", 0.9], ["image/jpeg", 0.82]];
  for (let round = 0; round < 8; round++) {
    for (const [type, quality] of formats) {
      const blob = await encode(w, h, type, quality);
      // A webview that cannot write WebP hands back PNG; that was tried already.
      if (blob.type && blob.type !== type) continue;
      if (base64Length(blob.size) <= limits.maxBase64) return { blob: blob.type ? blob : new Blob([blob], { type }), width: w, height: h };
    }
    w = Math.max(1, Math.round(w * 0.8));
    h = Math.max(1, Math.round(h * 0.8));
  }
  throw new Error("cannot make the image small enough");
}

/** Reads the image as the agent gets it: shrunk to the limits when needed. */
export async function toImageInput(img: DraftImage, limits: ImageLimits = STRICTEST): Promise<ImageInput> {
  const plan = planFor(img, limits);
  const input: ImageInput = { path: null, data: null, media_type: img.media_type, name: img.name, thumbnail: img.thumbnail, width: img.width, height: img.height, original_width: null, original_height: null };
  if (plan.kind === "blocked") throw new Error(plan.reason);
  if (plan.kind === "keep") return { ...input, data: await base64(img.blob) };
  let source: HTMLImageElement;
  try {
    source = await loadImage(img.blob);
  } catch {
    throw new Error(`${img.name ?? "An image"} is too large for this agent and could not be decoded to shrink it`);
  }
  // White behind transparency only matters for JPEG, which has none.
  const encode: Encoder = (w, h, type, quality) => toBlob(draw(source, w, h, type === "image/jpeg" ? "#fff" : undefined), type, quality);
  const out = await encodeWithin(plan.width, plan.height, img.media_type, limits, encode);
  return { ...input, data: await base64(out.blob), media_type: out.blob.type, width: out.width, height: out.height, original_width: img.width, original_height: img.height };
}

export function base64ToBlob(data: string, type: string): Blob {
  const bin = atob(data);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type });
}

/**
 * Whether the session's agent takes images, with the reason when not. ACP
 * agents say so per agent once their session has started.
 */
export function imageSupport(caps: CapabilitySet | undefined, acp: AcpSessionInfo | null, agentName: string): { ok: true } | { ok: false; reason: string } {
  if (!caps?.images || acp?.agent?.images === false) return { ok: false, reason: `${agentName} does not accept images` };
  return { ok: true };
}

/** An image on a sent message, from any daemon version. */
export type MessageImage = {
  key: string;
  name: string | null;
  media_type: string | null;
  width: number | null;
  height: number | null;
  /** Preview to show inline; null for a placeholder. */
  thumbnail: string | null;
  /** Id for `session.attachment`, when the daemon kept the full image. */
  attachment: string | null;
  /** Size before it was shrunk for the agent. */
  original: { width: number; height: number } | null;
};

const str = (v: unknown) => (typeof v === "string" && v ? v : null);
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const basename = (p: string) => p.split(/[\\/]/).pop() || p;

export function messageImages(data: unknown): MessageImage[] {
  if (!data || typeof data !== "object") return [];
  const d = data as Record<string, unknown>;
  if (Array.isArray(d.attachments)) {
    return d.attachments
      .filter((a): a is Record<string, unknown> => !!a && typeof a === "object")
      .map((a, i) => ({
        key: str(a.id) ?? `a${i}`,
        name: str(a.name),
        media_type: str(a.media_type),
        width: num(a.width),
        height: num(a.height),
        thumbnail: str(a.thumbnail)?.startsWith("data:image/") ? str(a.thumbnail) : null,
        attachment: str(a.id),
        original: num(a.original_width) && num(a.original_height) ? { width: num(a.original_width)!, height: num(a.original_height)! } : null,
      }));
  }
  // Codex echoes the input it was given: inline images as data URLs, files by path.
  if (Array.isArray(d.content)) {
    return d.content.flatMap((c, i): MessageImage[] => {
      if (!c || typeof c !== "object") return [];
      const part = c as Record<string, unknown>;
      const base = { key: `c${i}`, media_type: null, width: null, height: null, attachment: null, original: null };
      const url = str(part.url) ?? str(part.image_url);
      if (part.type === "image" && url?.startsWith("data:image/")) return [{ ...base, name: null, thumbnail: url }];
      if (part.type === "localImage" && str(part.path)) return [{ ...base, name: basename(part.path as string), thumbnail: null }];
      return [];
    });
  }
  // ACP messages only counted their images.
  const count = num(d.images);
  if (count && count > 0) {
    return Array.from({ length: Math.min(count, 20) }, (_, i) => ({ key: `n${i}`, name: null, media_type: null, width: null, height: null, thumbnail: null, attachment: null, original: null }));
  }
  return [];
}

/** Tooltip / lightbox caption: name, then pixel size, then what shrinking did. */
export function imageCaption(img: { name: string | null; width: number | null; height: number | null; media_type?: string | null; original?: { width: number; height: number } | null }): string {
  const parts = [img.name ?? (img.media_type ? img.media_type.replace("image/", "").toUpperCase() + " image" : "Image")];
  if (img.width && img.height) parts.push(`${img.width} × ${img.height}`);
  if (img.original) parts.push(`resized from ${img.original.width} × ${img.original.height}`);
  return parts.join(" · ");
}

/** What the strip says about an image that will not go out as it is. */
export function planNote(plan: SendPlan): { badge: string; detail: string } | null {
  if (plan.kind === "resize") return { badge: "resized", detail: `will be sent resized to ${plan.width} × ${plan.height}` };
  if (plan.kind === "blocked") return { badge: "too large", detail: plan.reason };
  return null;
}

export function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
