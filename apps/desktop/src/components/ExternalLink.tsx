import type { ComponentProps } from "react";
import { open } from "@tauri-apps/plugin-shell";
import { isTauri } from "../lib/connection";
import { useStore } from "../state/store";

export function ExternalLink({ href, children, ...props }: ComponentProps<"a"> & { href: string }) {
  return (
    <a {...props} href={href} target="_blank" rel="noopener noreferrer" data-hint
      onClick={(event) => {
        if (!isTauri()) return;
        event.preventDefault();
        void open(href).catch((error: unknown) => {
          useStore.getState().toast(`Could not open link: ${String(error)}`, "error");
        });
      }}>
      {children}
    </a>
  );
}
