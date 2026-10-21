import { useEffect, useState, type ReactNode } from "react";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { isTauri } from "../../lib/connection";
import { base64ToBlob } from "../../lib/images";
import { imageSource, resolvePath, type FileRef } from "../../lib/localPaths";
import { useStore } from "../../state/store";

/** Images read from disk, by path. Small: a transcript shows few at a time. */
const images = new Map<string, Promise<Blob>>();
const IMAGE_CACHE = 50;

function loadImage(path: string): Promise<Blob> {
  const cached = images.get(path);
  if (cached) return cached;
  const client = useStore.getState().client;
  if (!client) return Promise.reject(new Error("not connected"));
  const load = client.readImage(path).then((r) => base64ToBlob(r.data, r.media_type));
  load.catch(() => images.delete(path));
  images.set(path, load);
  if (images.size > IMAGE_CACHE) images.delete(images.keys().next().value!);
  return load;
}

/** Test hook: forget the images read so far. */
export function clearImageCache() {
  images.clear();
}

async function absolute(path: string): Promise<string> {
  if (!path.startsWith("~/")) return path;
  const home = await useStore.getState().client?.home();
  if (!home) throw new Error("no home folder");
  return `${home.replace(/\/$/, "")}/${path.slice(2)}`;
}

/**
 * A path in an agent's message. In the desktop app a click shows the file in
 * the system file manager (Finder, Explorer); elsewhere it is plain text.
 */
export function FileLink({ file, cwd, children }: { file: FileRef; cwd: string | undefined; children: ReactNode }) {
  const path = resolvePath(file.path, cwd);
  if (!path || !isTauri()) return <span title={path ?? file.path}>{children}</span>;
  const title = `${path}${file.line ? `:${file.line}` : ""} · show in folder`;
  return (
    <a className="md-link md-file" href={path} title={title} data-hint
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        void absolute(path).then(revealItemInDir).catch((error: unknown) => {
          useStore.getState().toast(`Could not show ${path}: ${String(error)}`, "error");
        });
      }}>
      {children}
    </a>
  );
}

/**
 * An image in a message. https and data: images load directly; files on disk
 * through the daemon, which reads image files only, and only for messages
 * that come with a folder (`cwd`). Anything else shows as its text.
 */
export function MarkdownImage({ src, alt, title, cwd }: { src: string; alt: string; title?: string; cwd: string | undefined }) {
  const source = imageSource(src, cwd);
  const localPath = source.kind === "local" ? source.path : null;
  const [local, setLocal] = useState<{ path: string; url: string | null; blob: Blob | null; error: string | null } | null>(null);
  const [broken, setBroken] = useState(false);
  useEffect(() => {
    if (!localPath) return;
    let url: string | null = null;
    let live = true;
    absolute(localPath).then(loadImage).then(
      (blob) => {
        if (!live) return;
        url = URL.createObjectURL(blob);
        setLocal({ path: localPath, url, blob, error: null });
      },
      (error: unknown) => live && setLocal({ path: localPath, url: null, blob: null, error: String(error instanceof Error ? error.message : error) }),
    );
    return () => {
      live = false;
      if (url) URL.revokeObjectURL(url);
    };
  }, [localPath]);

  const caption = alt || title || src;
  const fallback = (why: string | null) => (
    <span className="md-img-missing" title={why ? `${src}: ${why}` : src}>
      🖼 {alt || src}{alt && <span className="dim"> ({src})</span>}
    </span>
  );
  if (source.kind === "none" || broken) return fallback(null);
  const shown = source.kind === "remote" ? source.url : local?.path === localPath ? local.url : null;
  if (source.kind === "local" && local?.path === localPath && local.error) return fallback(local.error);
  if (!shown) return <span className="md-img-loading" title={src}>🖼 {alt || src}</span>;
  const open = () => {
    const blob = local?.blob;
    useStore.getState().openDialog({
      kind: "image",
      caption,
      preview: shown,
      load: blob ? () => Promise.resolve(blob) : undefined,
    });
  };
  return (
    <button type="button" className="md-img" data-command="image.open" data-hint title={title ?? caption} aria-label={`Open ${caption}`}
      onClick={(e) => {
        e.stopPropagation();
        open();
      }}>
      <img src={shown} alt={alt} loading="lazy" referrerPolicy="no-referrer" draggable={false} onError={() => setBroken(true)} />
    </button>
  );
}
