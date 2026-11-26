/**
 * What a mod's UI half imports instead of bundling: Aura's own React, zustand
 * and clsx, and "@aura/host" with Aura's building blocks. The SDK build maps
 * these imports to `globalThis.__aura.modules[name]`.
 *
 * Keep the "@aura/host" list in step with packages/mod-sdk/src/host.ts.
 */
import * as React from "react";
import * as jsxRuntime from "react/jsx-runtime";
import * as ReactDOM from "react-dom";
import * as zustand from "zustand";
import * as zustandShallow from "zustand/shallow";
import * as zustandReactShallow from "zustand/react/shallow";
import clsx from "clsx";
import { Modal, KeyList, useListNav } from "../components/Modal";
import { ModalC } from "../components/ModalC";
import { ExternalLink } from "../components/ExternalLink";
import { Markdown } from "../views/transcript/MarkdownView";
import { DiffRenderer } from "../components/diff/DiffRenderer";
import * as diff from "../components/diff/parse";
import { timeAgo, exactTime } from "../lib/time";
import { isMac, modLabel, shortId, basename, relTime } from "../lib/platform";
import { useStore } from "../state/store";
import { setFocus } from "../commands/core";
import { openExternal } from "./hostExtras";

export const auraHost = {
  Modal,
  KeyList,
  useListNav,
  ModalC,
  ExternalLink,
  Markdown,
  DiffRenderer,
  diff,
  timeAgo,
  exactTime,
  isMac,
  modLabel,
  shortId,
  basename,
  relTime,
  useStore,
  setFocus,
  openExternal,
};

/** Install the shared modules once, before the first mod loads. */
export function installHostModules() {
  const g = globalThis as unknown as { __aura?: { modules: Record<string, unknown> } };
  if (g.__aura) return;
  g.__aura = {
    modules: {
      react: React,
      "react/jsx-runtime": jsxRuntime,
      "react-dom": ReactDOM,
      zustand,
      "zustand/shallow": zustandShallow,
      "zustand/react/shallow": zustandReactShallow,
      clsx: Object.assign(clsx, { default: clsx, clsx }),
      "@aura/host": auraHost,
    },
  };
}
