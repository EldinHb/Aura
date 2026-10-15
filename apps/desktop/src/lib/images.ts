/**
 * Images attached in the composer and shown on sent messages.
 *
 * A draft keeps the file as a Blob plus a small `data:` thumbnail; it is only
 * read as base64 when sent. The daemon records each sent image on the user
 * message under `data.attachments` (thumbnail, name, size, and an id to fetch
 * the full image with `session.attachment`). Messages from before that carry
 * Codex's `data.content` images or ACP's `data.images` count instead.
 */
import type { CapabilitySet, ImageInput } from "../gen";
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

function toBlob(canvas: HTMLCanvasElement, type: string): Promise<Blob> {
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("cannot encode image"))), type));
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

export async function toImageInput(img: DraftImage): Promise<ImageInput> {
  return { path: null, data: await base64(img.blob), media_type: img.media_type, name: img.name, thumbnail: img.thumbnail, width: img.width, height: img.height };
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
      }));
  }
  // Codex echoes the input it was given: inline images as data URLs, files by path.
  if (Array.isArray(d.content)) {
    return d.content.flatMap((c, i): MessageImage[] => {
      if (!c || typeof c !== "object") return [];
      const part = c as Record<string, unknown>;
      const base = { key: `c${i}`, media_type: null, width: null, height: null, attachment: null };
      const url = str(part.url) ?? str(part.image_url);
      if (part.type === "image" && url?.startsWith("data:image/")) return [{ ...base, name: null, thumbnail: url }];
      if (part.type === "localImage" && str(part.path)) return [{ ...base, name: basename(part.path as string), thumbnail: null }];
      return [];
    });
  }
  // ACP messages only counted their images.
  const count = num(d.images);
  if (count && count > 0) {
    return Array.from({ length: Math.min(count, 20) }, (_, i) => ({ key: `n${i}`, name: null, media_type: null, width: null, height: null, thumbnail: null, attachment: null }));
  }
  return [];
}

/** Tooltip / lightbox caption: name, then pixel size. */
export function imageCaption(img: { name: string | null; width: number | null; height: number | null; media_type?: string | null }): string {
  const parts = [img.name ?? (img.media_type ? img.media_type.replace("image/", "").toUpperCase() + " image" : "Image")];
  if (img.width && img.height) parts.push(`${img.width} × ${img.height}`);
  return parts.join(" · ");
}

export function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
