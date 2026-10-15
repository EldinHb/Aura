import { afterEach, describe, expect, it, vi } from "vitest";
import { base64Length, encodeWithin, fitDimensions, imageLimits, planNote, sendPlan, toImageInput, type DraftImage, type Encoder } from "./images";

const MB = 1024 * 1024;
const claude = imageLimits("claude");
const codex = imageLimits("codex");

describe("limits per agent", () => {
  it("uses Codex's own 2048 px and the strictest known limits for everyone else", () => {
    expect(codex).toEqual({ maxEdge: 2048, maxBase64: 10_000_000 });
    expect(claude).toEqual({ maxEdge: 2000, maxBase64: 5_000_000 });
    expect(imageLimits("acp")).toEqual(claude);
    expect(imageLimits(undefined)).toEqual(claude);
  });
});

describe("dimension and size math", () => {
  it("fits the long edge and keeps the aspect ratio", () => {
    expect(fitDimensions(5120, 2880, 2000)).toEqual({ width: 2000, height: 1125 });
    expect(fitDimensions(1100, 6000, 2000)).toEqual({ width: 367, height: 2000 });
    expect(fitDimensions(1600, 900, 2000)).toEqual({ width: 1600, height: 900 });
    expect(fitDimensions(40000, 10, 2000)).toEqual({ width: 2000, height: 1 });
  });

  it("counts the base64 text, which is a third larger than the file", () => {
    expect(base64Length(3)).toBe(4);
    expect(base64Length(4)).toBe(8);
    expect(base64Length(3_750_000)).toBe(5_000_000);
  });
});

describe("what happens to an image when sent", () => {
  const img = (width: number | null, height: number | null, size: number, media_type = "image/png") => ({ width, height, size, media_type, name: "shot.png" });

  it("sends small images as they are", () => {
    expect(sendPlan(img(1600, 1000, 900_000), claude)).toEqual({ kind: "keep" });
  });

  it("shrinks a Retina full-screen capture to the long-edge limit", () => {
    expect(sendPlan(img(5120, 2880, 6 * MB), claude)).toEqual({ kind: "resize", width: 2000, height: 1125 });
    expect(sendPlan(img(5120, 2880, 6 * MB), codex)).toEqual({ kind: "resize", width: 2048, height: 1152 });
  });

  it("re-encodes an image within the pixel limit that is over the byte limit", () => {
    // 3.8 MB of file is 5.07 MB of base64.
    expect(sendPlan(img(1900, 1900, 3_800_000), claude)).toEqual({ kind: "resize", width: 1900, height: 1900 });
    expect(sendPlan(img(1900, 1900, 3_800_000), codex)).toEqual({ kind: "keep" });
  });

  it("sends an image it cannot decode when it is under the byte limit, and blocks it when over", () => {
    expect(sendPlan(img(null, null, 2 * MB), claude)).toEqual({ kind: "keep" });
    const plan = sendPlan(img(null, null, 8 * MB), claude);
    expect(plan).toMatchObject({ kind: "blocked" });
    expect(planNote(plan)).toEqual({ badge: "too large", detail: "shot.png is over the 5 MB this agent accepts and could not be decoded to shrink it" });
    expect(planNote({ kind: "resize", width: 2000, height: 1125 })).toEqual({ badge: "resized", detail: "will be sent resized to 2000 × 1125" });
    expect(planNote({ kind: "keep" })).toBeNull();
  });
});

describe("re-encoding within the byte limit", () => {
  /** Pretends each format compresses a pixel to so many bytes; `writes` lists what the webview can produce. */
  function encoder(bytesPerPixel: Record<string, number>, writes = Object.keys(bytesPerPixel)) {
    const calls: string[] = [];
    const encode: Encoder = async (w, h, type, quality) => {
      calls.push(`${type}@${w}x${h}${quality ? `:${quality}` : ""}`);
      const real = writes.includes(type) ? type : "image/png";
      return new Blob([new Uint8Array(Math.round(w * h * bytesPerPixel[real]))], { type: real });
    };
    return { encode, calls };
  }

  it("keeps a screenshot PNG when the PNG fits", async () => {
    const { encode, calls } = encoder({ "image/png": 0.5, "image/webp": 0.2, "image/jpeg": 0.2 });
    const out = await encodeWithin(2000, 1125, "image/png", claude, encode);
    expect(out).toMatchObject({ width: 2000, height: 1125 });
    expect(out.blob.type).toBe("image/png");
    expect(calls).toEqual(["image/png@2000x1125"]);
  });

  it("falls back to high-quality WebP, or JPEG where the webview cannot write WebP", async () => {
    const photo = { "image/png": 3, "image/webp": 0.6, "image/jpeg": 0.7 };
    const withWebp = await encodeWithin(2000, 1125, "image/png", claude, encoder(photo).encode);
    expect(withWebp.blob.type).toBe("image/webp");
    const safari = encoder(photo, ["image/png", "image/jpeg"]);
    const out = await encodeWithin(2000, 1125, "image/png", claude, safari.encode);
    expect(out.blob.type).toBe("image/jpeg");
    expect(safari.calls).toEqual(["image/png@2000x1125", "image/webp@2000x1125:0.92", "image/jpeg@2000x1125:0.9"]);
  });

  it("keeps JPEG photos JPEG and shrinks further until they fit", async () => {
    const { encode, calls } = encoder({ "image/png": 3, "image/jpeg": 2 });
    const out = await encodeWithin(2000, 2000, "image/jpeg", claude, encode);
    expect(out.blob.type).toBe("image/jpeg");
    expect(base64Length(out.blob.size)).toBeLessThanOrEqual(claude.maxBase64);
    expect(out.width).toBeLessThan(2000);
    expect(calls.every((c) => c.startsWith("image/jpeg"))).toBe(true);
  });
});

describe("toImageInput", () => {
  const draft = (over: Partial<DraftImage>): DraftImage => ({ key: "k", blob: new Blob(["png-bytes"], { type: "image/png" }), name: "shot.png", media_type: "image/png", width: 800, height: 600, thumbnail: null, ...over });
  afterEach(() => vi.unstubAllGlobals());

  it("sends small images untouched", async () => {
    const input = await toImageInput(draft({}), claude);
    expect(input).toMatchObject({ data: btoa("png-bytes"), media_type: "image/png", width: 800, height: 600, original_width: null });
  });

  it("refuses an image it can neither send nor shrink", async () => {
    const big = new Blob([new Uint8Array(4_000_000)], { type: "image/png" });
    await expect(toImageInput(draft({ blob: big, width: null, height: null }), claude)).rejects.toThrow(/could not be decoded/);
  });

  it("draws an oversized image on a canvas at the fitted size and records the original", async () => {
    // jsdom has no canvas or image decoding; stand in for both.
    class FakeImage {
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      naturalWidth = 5120;
      naturalHeight = 2880;
      set src(_: string) {
        queueMicrotask(() => this.onload?.());
      }
    }
    vi.stubGlobal("Image", FakeImage);
    URL.createObjectURL = vi.fn(() => "blob:src");
    URL.revokeObjectURL = vi.fn();
    const drawn: number[][] = [];
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(function (this: HTMLCanvasElement) {
      return { drawImage: (_: unknown, x: number, y: number, w: number, h: number) => drawn.push([x, y, w, h]), fillRect: () => {}, fillStyle: "" } as unknown as CanvasRenderingContext2D;
    } as never);
    vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation(function (this: HTMLCanvasElement, cb: BlobCallback, type?: string) {
      cb(new Blob([`${type}:${this.width}x${this.height}`], { type }));
    });
    const input = await toImageInput(draft({ blob: new Blob([new Uint8Array(6 * MB)], { type: "image/png" }), width: 5120, height: 2880 }), claude);
    expect(drawn).toEqual([[0, 0, 2000, 1125]]);
    expect(input).toMatchObject({ media_type: "image/png", width: 2000, height: 1125, original_width: 5120, original_height: 2880 });
    expect(atob(input.data!)).toBe("image/png:2000x1125");
    vi.restoreAllMocks();
  });
});
