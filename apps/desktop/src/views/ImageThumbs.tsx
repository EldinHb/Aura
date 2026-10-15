import { useEffect, useRef, useState } from "react";
import clsx from "clsx";
import { Modal } from "../components/Modal";
import { useStore } from "../state/store";
import { base64ToBlob, imageCaption, messageImages, type MessageImage } from "../lib/images";

/** One square preview; a placeholder when there is no thumbnail. */
export function ImageThumb({ src, caption, badge, badgeKind, onOpen, onRemove, onKeyDown, small }: {
  src: string | null;
  caption: string;
  /** A word on the corner, e.g. "resized"; the caption says the rest. */
  badge?: string;
  badgeKind?: "info" | "err";
  onOpen?: () => void;
  onRemove?: () => void;
  onKeyDown?: (e: React.KeyboardEvent<HTMLButtonElement>) => void;
  small?: boolean;
}) {
  return (
    <span className={clsx("image-thumb", small && "small")}>
      <button
        type="button"
        className="image-thumb-open"
        data-command={onOpen ? "image.open" : undefined}
        data-hint={onOpen ? true : undefined}
        title={caption}
        aria-label={onOpen ? `Open ${caption}` : caption}
        disabled={!onOpen}
        onClick={(e) => {
          e.stopPropagation();
          onOpen?.();
        }}
        onKeyDown={onKeyDown}
      >
        {src ? <img src={src} alt="" draggable={false} /> : <span className="image-thumb-empty" aria-hidden>🖼</span>}
        {badge && <span className={clsx("image-thumb-badge", badgeKind)} aria-hidden>{badge}</span>}
      </button>
      {onRemove && (
        <button
          type="button"
          className="image-thumb-remove"
          data-command="composer.remove-image"
          data-hint
          tabIndex={-1}
          title="Remove"
          aria-label={`Remove ${caption}`}
          onClick={(e) => {
            e.stopPropagation();
            onRemove();
          }}
        >
          ×
        </button>
      )}
    </span>
  );
}

/** The images of a sent user message. */
export function MessageImages({ sessionId, data }: { sessionId: string; data: unknown }) {
  const images = messageImages(data);
  if (images.length === 0) return null;
  const open = (img: MessageImage) => {
    const { client, openDialog } = useStore.getState();
    const id = img.attachment;
    openDialog({
      kind: "image",
      caption: imageCaption(img),
      preview: img.thumbnail,
      load: id && client ? () => client.attachment(sessionId, id).then((r) => base64ToBlob(r.data, r.media_type)) : undefined,
    });
  };
  return (
    <div className="message-images">
      {images.map((img) => (
        <ImageThumb key={img.key} small src={img.thumbnail} caption={imageCaption(img)} badge={img.original ? "resized" : undefined} onOpen={img.thumbnail || img.attachment ? () => open(img) : undefined} />
      ))}
    </div>
  );
}

/** Lightbox. Shows the preview at once and swaps in the full image once loaded. */
export function ImageDialog({ caption, preview, load }: { caption: string; preview: string | null; load?: () => Promise<Blob> }) {
  const [full, setFull] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const returnFocus = useRef(document.activeElement as HTMLElement | null);
  const closeDialog = useStore((s) => s.closeDialog);

  useEffect(() => {
    if (!load) return;
    let url: string | null = null;
    let live = true;
    load()
      .then((blob) => {
        if (!live) return;
        url = URL.createObjectURL(blob);
        setFull(url);
      })
      .catch((e) => live && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      live = false;
      if (url) URL.revokeObjectURL(url);
    };
  }, [load]);
  useEffect(() => () => returnFocus.current?.focus?.(), []);

  const src = full ?? preview;
  return (
    <Modal
      className="image-modal"
      width={1100}
      title={
        <>
          <span className="grow">{caption}</span>
          <button className="btn small" data-autofocus data-command="image.close" onClick={closeDialog} title="Close (Esc)">
            ×
          </button>
        </>
      }
    >
      {src ? <img src={src} alt={caption} /> : <div className="dim">{error ? "" : "Loading…"}</div>}
      {error && <div className="dim">Full size is not available{preview ? "; showing the preview" : ""}.</div>}
    </Modal>
  );
}
