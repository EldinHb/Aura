# Creating an Aura theme

This guide is for coding agents asked to change how Aura looks. It assumes a
terminal on a machine where Aura is installed, and nothing else: no Aura source
code, no build step. Print it again any time with `aura guide themes`.

## What a theme is

A theme is one JSON file that starts from one of Aura's built-in looks (`dark`
or `light`) and overrides some of its design tokens: the CSS custom properties
the whole app, mods included, is painted with. An optional CSS file next to
it can change what tokens cannot.

```
<data dir>/themes/<id>.json     required
<data dir>/themes/<id>.css      optional
```

The data folder is `~/.aura` on every OS (`%USERPROFILE%\.aura` on Windows)
unless `AURA_DATA_DIR` points elsewhere. The id is the file name: lowercase
letters, digits and dashes; `dark`, `light` and `system` are taken.

Themes appear in **Settings › General › Theme** under "Your themes". Aura
watches the folder: saving a theme file applies the change to the open windows
at once, with no reload.

A theme made of tokens only needs no approval. A theme with a CSS file does:
its CSS can restyle every screen in Aura, including the cards where you
approve what agents run, so Aura applies a theme's CSS only after the user
approved that exact CSS, in a prompt like the one for mods. Until then, and
whenever the CSS changes afterwards, only its tokens apply. Changing only the
tokens never asks again.

On a system whose web engine has no CSS cascade layers (macOS 12.0 to 12.2,
with Safari before 15.4), Aura cannot keep its approval prompts out of a
theme's CSS, so it never applies theme CSS there, approved or not: only the
tokens. Settings › General says so under the theme picker ("This system can't
protect approval prompts from theme CSS, so only its colours are used").

## Quick start

```sh
aura themes new ocean --base dark     # ~/.aura/themes/ocean.json with every token
aura themes check ocean               # validate
aura themes use ocean                 # show it in Aura, now and after a restart
```

`aura themes new <id>` options: `--base dark|light` (default `dark`), `--name
"Display name"`, `--css` (also write `<id>.css`), `--force` (overwrite).

The scaffold lists every token with the base theme's current value, grouped,
with a `"// Group"` comment entry before each group. Change the values you
want and **delete the lines you do not change**: a token left out keeps the
base theme's value, and keeps following it when Aura's defaults improve.

`aura themes use <id>` switches every open Aura window and is kept, like a
choice in Settings: windows opened later and Aura after a restart show it too.
It refuses (exit code 1) a theme that does not exist or cannot be used, with
the reason; run `aura themes check <id>` for the details. The user can switch
back in Settings; `aura themes use dark` (or `light`, `system`) returns to a
built-in theme. `aura themes list` shows all themes and whether each is valid.

`aura themes approve <id>` makes Aura's window show the approval prompt for a
theme's CSS; only the user's click there approves it.

## The file format

```json
{
  "name": "Ocean",
  "author": "Ada",
  "base": "dark",
  "tokens": {
    "// Colour roles": "Comments are keys that start with //; they are ignored.",
    "--md-primary": "#7cc4ff",
    "--md-on-primary": "#00325a",
    "--md-surface": "#0b1520"
  }
}
```

| Field | Required | Meaning |
| --- | --- | --- |
| `name` | yes | Shown in the theme picker; 1 to 80 characters |
| `base` | yes | `"dark"` or `"light"`: the built-in theme it starts from. It also sets the colour of native controls (scrollbars, select menus) |
| `author` | no | Who made it |
| `tokens` | no | `"--token": "value"` pairs. Values are CSS values: colours (`#rrggbb`, `rgb()`, `hsl()`, `oklch()`, `color-mix()`), lengths, font stacks, shadows, or `var(--other-token)` |
| `description`, keys starting with `//` | no | Ignored; use them for notes |

`<id>.css` holds any CSS, applied after the tokens. Use it for what tokens
cannot express (a font weight, a border on one element). Scope rules to the
theme with `:root[data-user-theme="<id>"] …` if you want to be explicit.
Prefer tokens: they reach mods too, and survive Aura's updates, while class
names in `<id>.css` may change between versions.

## Validation

Aura checks a theme each time it changes. `aura themes check <id>` prints the
same result and exits with 1 when the theme cannot be used. Give it an id
(looked up the way Aura finds themes, including `<mod id>:<name>` for a mod's
theme) or a path to a `.json` file (`./mine.json`, checked on its own; its
file name must still be a valid id).

Aura reads CSS the way a browser does: escapes are decoded first, so
`u\72l(`, `\75 rl(` and `@im\70ort` count as `url(` and `@import`.

Errors make the theme unusable. Aura then shows its base theme (or dark), and
Settings › General shows the reason under the picker:

- the JSON does not parse, or is not an object
- `name` missing or empty; `base` missing or not `dark`/`light`
- `tokens` is not an object
- a token value that is not one CSS value: a `;`, `{`, `}` or `!important`
  outside quotes and brackets (`"red;display:none"` is refused)
- a resource that is not a `data:` URL: in `url()`, `src()`, `image()`,
  `image-set()` or `cross-fade()`, in a token or in the CSS (also inside
  `@font-face`). A theme never loads anything from the web or from disk;
  embed images and fonts as `data:` URLs
- `@import`, and `@layer` (Aura uses cascade layers to keep its approval
  prompts out of every theme's reach)
- `<id>.json` larger than 128 KB, or `<id>.css` larger than 256 KB (Aura
  never reads more than that)
- a file that is not a regular file, or a symlink that points outside the
  themes folder (a symlink to another file in the same folder is fine)

Warnings leave the theme usable and are shown too:

- a token name Aura does not have (it is ignored). When it is close to a real
  one, the warning says which: `--md-primay is not an Aura token; ignored. Did
  you mean --md-primary?`
- a value that is not a string, is empty, or longer than 4000 characters
  (ignored)
- an unknown top-level field

Beyond those checks the CSS is not judged; a CSS syntax mistake only drops
the broken rule, as in any stylesheet. Approved CSS can restyle every screen
in Aura, including the cards where you approve what agents run; only Aura's
approval prompts for mods and themes stay as they are: they are drawn above
everything and styled in a cascade layer no theme can override.

## How to design one

1. Pick the base closest to what you want: `dark` for a dark theme, `light`
   for a light one.
2. Change the **colour roles** first (`--md-*`). Almost everything is painted
   from them, so a dozen values restyle the whole app:
   `--md-primary`, `--md-on-primary`, `--md-primary-container`,
   `--md-on-primary-container`, `--md-secondary-container`,
   `--md-on-secondary-container`, the five `--md-surface*` tones,
   `--md-on-surface`, `--md-on-surface-variant`, `--md-outline-variant`,
   `--md-divider`.
3. Keep the surface tones in order: `lowest` → `low` → (plain) → `high` →
   `highest` get steadily further from the window frame. In dark themes
   higher means lighter; in light themes the frame (`--frame`) is the darker
   tone and panels are lighter.
4. Then adjust the status colours (`--md-tertiary` for warnings, `--md-error`,
   `--md-success`, `--md-info`), `--fg-dim`, `--accent-2` and the agent colours.
5. Match the terminal (`--term-*`): at least `--term-bg`, `--term-fg`,
   `--term-cursor` and `--term-selection`, so the terminal pane sits on the
   theme's surfaces. Each base has its own full palette, so a light theme
   already gets a light terminal; override the 16 ANSI colours only if you
   want different ones, and keep each readable on `--term-bg`. Use plain
   colours here: the terminal cannot use `color-mix()`.
6. Only then, if needed, shape (`--shape-*`), spacing (`--space-*`) and fonts
   (`--font`, `--mono`).
7. Run `aura themes check <id>`, switch to it with `aura themes use <id>`, and
   look at the sidebar, a transcript, a terminal session, a dialog
   (`⌘K` / `Ctrl+K`) and Settings.

### Accessibility

- Text needs a contrast ratio of at least **4.5:1** against what it sits on
  (3:1 for large text and icons). Check every `on-*` pair
  (`--md-on-primary` on `--md-primary`, `--md-on-primary-container` on
  `--md-primary-container`, …), and `--md-on-surface`,
  `--md-on-surface-variant` and `--fg-dim` on `--md-surface`,
  `--md-surface-container-low` and `--md-surface-container`.
- The contrast ratio of colours A and B is `(L1 + 0.05) / (L2 + 0.05)`, with
  L1 the lighter relative luminance; compute it rather than guess.
- Keep `--md-primary` (the focus ring and the selection) clearly visible on
  every surface: at least 3:1.
- Do not tell states apart by hue alone: warning, error and success should
  differ in lightness too.
- Terminal colours: `--term-fg` and every ANSI colour you set on
  `--term-bg` at 4.5:1 too, except `--term-black` (and `--term-white` in a
  light theme), which programs use as backgrounds.
- Leave `--font-size` alone: the user sets it in Settings, which wins anyway.

## Themes in a mod

A mod can ship themes: put `<name>.json` (and `<name>.css`) in a `themes/`
folder inside the mod. They are listed as `<mod id>:<name>` while the mod is
enabled and approved, and follow the same rules, including the approval of
their CSS. See `aura guide mods`.

## Two complete examples

A dark green theme, `~/.aura/themes/forest.json` (every text pair here is at
least 5.5:1):

```json
{
  "name": "Forest",
  "author": "Aura guide",
  "base": "dark",
  "tokens": {
    "--md-primary": "#8fd5a6",
    "--md-on-primary": "#003920",
    "--md-primary-container": "#1f5135",
    "--md-on-primary-container": "#abf2c1",
    "--md-secondary-container": "#2c4a3a",
    "--md-on-secondary-container": "#cfe9d9",
    "--md-tertiary": "#f0c27a",
    "--md-surface": "#0f1512",
    "--md-surface-container-lowest": "#0a0f0c",
    "--md-surface-container-low": "#151d18",
    "--md-surface-container": "#1a231e",
    "--md-surface-container-high": "#232d27",
    "--md-surface-container-highest": "#2d3832",
    "--md-on-surface": "#dfe9e2",
    "--md-on-surface-variant": "#bccabf",
    "--md-outline": "#869489",
    "--md-outline-variant": "#3f4a43",
    "--md-divider": "#24302a",
    "--md-success": "#8fd5a6",
    "--fg-dim": "#8d9a91",
    "--accent-2": "#9ccfd8",
    "--term-bg": "#0f1512",
    "--term-fg": "#dfe9e2",
    "--term-cursor": "#8fd5a6",
    "--term-cursor-accent": "#0f1512",
    "--term-selection": "rgba(143,213,166,0.3)",
    "--term-green": "#8fd5a6",
    "--shape-md": "8px",
    "--shape-lg": "12px"
  }
}
```

A warm light theme with a CSS file, `~/.aura/themes/paper.json` (every text
pair at least 5:1):

```json
{
  "name": "Paper",
  "author": "Aura guide",
  "base": "light",
  "tokens": {
    "--md-primary": "#8a4b14",
    "--md-on-primary": "#ffffff",
    "--md-primary-container": "#ffdcc2",
    "--md-on-primary-container": "#6b3a0c",
    "--md-secondary-container": "#f1e4d6",
    "--md-on-secondary-container": "#3a2e22",
    "--md-tertiary": "#8a5300",
    "--md-error": "#ba1a1a",
    "--md-success": "#2e6b3f",
    "--md-surface": "#fdf8f1",
    "--md-surface-container-lowest": "#ffffff",
    "--md-surface-container-low": "#f8f2ea",
    "--md-surface-container": "#f2ebe2",
    "--md-surface-container-high": "#ece4da",
    "--md-surface-container-highest": "#e6ded3",
    "--md-on-surface": "#1f1b16",
    "--md-on-surface-variant": "#4f453b",
    "--md-outline": "#81756a",
    "--md-outline-variant": "#d4c4b5",
    "--md-divider": "#e8ddd1",
    "--fg-dim": "#6d6257",
    "--accent-2": "#5b6b2e",
    "--font": "Charter, \"Iowan Old Style\", Georgia, serif"
  }
}
```

`~/.aura/themes/paper.css`:

```css
/* Paper: a little more air in agent replies. */
:root[data-user-theme="paper"] .md p { line-height: 1.6; }
```

## Token reference

Every token, what it is for, and its value in the built-in dark and light
themes. A light value equal to the dark one means the light theme does not
change it. Values like `var(--md-surface)` point at another token.

<!-- token-reference:start (generated from apps/desktop/src/styles.css; do not edit by hand) -->

### Colour roles

Material 3 colour roles. Most of the app is painted from these; change these first. An `on-*` colour is text and icons drawn on top of the colour it names, so keep each pair readable (4.5:1 contrast for text).

| Token | Role | Dark default | Light default |
| --- | --- | --- | --- |
| `--md-primary` | Main accent: links, focused borders, selected items, primary buttons | `#bcc2ff` | `#4c56a8` |
| `--md-on-primary` | Text and icons on `--md-primary` (primary button labels) | `#232a6b` | `#ffffff` |
| `--md-primary-container` | Quieter accent fill: selected chips and highlighted rows | `#3b4285` | `#dfe0ff` |
| `--md-on-primary-container` | Text on `--md-primary-container` | `#dfe0ff` | `#333c8e` |
| `--md-secondary` | Secondary accent for less prominent controls | `#c3c5dd` | `#5a5d72` |
| `--md-on-secondary` | Text on `--md-secondary` | `#2c2f42` | `#ffffff` |
| `--md-secondary-container` | Fill of selected list rows, tabs and toggles (`--accent-bg`) | `#383c56` | `#e0e1f9` |
| `--md-on-secondary-container` | Text on `--md-secondary-container` | `#e0e1fa` | `#2f3247` |
| `--md-tertiary` | Warning colour (`--warn`): waiting sessions, cautions | `#f3bf7f` | `#8a5300` |
| `--md-on-tertiary` | Text on `--md-tertiary` | `#472a00` | `#ffffff` |
| `--md-tertiary-container` | Fill of warning banners | `#5c3c08` | `#ffdcb8` |
| `--md-on-tertiary-container` | Text on `--md-tertiary-container` | `#ffdcb8` | `#5e3800` |
| `--md-error` | Errors, failed states and destructive buttons (`--err`) | `#ffb4ab` | `#ba1a1a` |
| `--md-on-error` | Text on `--md-error` | `#690005` | `#ffffff` |
| `--md-error-container` | Fill of error banners | `#93000a` | `#ffdad6` |
| `--md-on-error-container` | Text on `--md-error-container` | `#ffdad6` | `#93000a` |
| `--md-success` | Success and running states (`--ok`) | `#86d9a3` | `#1b6d3f` |
| `--md-on-success` | Text on `--md-success` | `#00391c` | `#ffffff` |
| `--md-info` | Informational highlights (`--info`) | `#a3c9ff` | `#1f5fa8` |
| `--md-surface` | Base surface; the window frame (`--frame`) in the dark theme | `#111216` | `#fbf8ff` |
| `--md-surface-container-lowest` | Lowest surface tone; the panels in the light theme | `#0c0d11` | `#ffffff` |
| `--md-surface-container-low` | Panels: main area and inspector cards (`--panel`) in the dark theme | `#18191f` | `#f6f3fb` |
| `--md-surface-container` | Raised surfaces: popovers and inputs (`--bg-elev`); the frame in the light theme | `#1d1e25` | `#efedf5` |
| `--md-surface-container-high` | Higher surfaces: dialogs and menus (`--bg-elev2`) | `#26272f` | `#e9e7ef` |
| `--md-surface-container-highest` | Highest surface tone: tooltips, pressed fills | `#31323a` | `#e3e1e9` |
| `--md-on-surface` | Main text colour (`--fg`) | `#e3e1e9` | `#1b1b21` |
| `--md-on-surface-variant` | Secondary text: labels, metadata (`--fg-muted`) | `#c6c5d0` | `#46464f` |
| `--md-outline` | Strong outlines: input borders, focus outlines | `#8f8f9a` | `#767680` |
| `--md-outline-variant` | Subtle outlines (`--border-strong`) | `#45464f` | `#c7c5d0` |
| `--md-divider` | Hairline dividers between rows and panes (`--border`) | `#2a2b33` | `#e2e0ea` |
| `--md-inverse-surface` | Background of snackbars and toasts | `#e3e1e9` | `#303036` |
| `--md-inverse-on-surface` | Text on `--md-inverse-surface` | `#2f3036` | `#f2eff7` |
| `--md-inverse-primary` | Accent on inverse surfaces (toast actions) | `#4c56a8` | `#bcc2ff` |
| `--md-inverse-warn` | Warning colour on inverse surfaces | `#8a5300` | `#f3bf7f` |
| `--md-inverse-error` | Error colour on inverse surfaces | `#ba1a1a` | `#ffb4ab` |
| `--md-scrim` | Dimming layer behind dialogs (use a colour with alpha) | `rgb(0 0 0 / 0.55)` | `rgb(0 0 0 / 0.32)` |

### Layout surfaces

Which surface tone the big areas use.

| Token | Role | Dark default | Light default |
| --- | --- | --- | --- |
| `--frame` | Window frame: title bar, sidebar, gaps between panes | `var(--md-surface)` | `var(--md-surface-container)` |
| `--panel` | Main area and inspector cards | `var(--md-surface-container-low)` | `var(--md-surface-container-lowest)` |

### State layers

Hover and press feedback: an on-colour laid over a surface at a fixed opacity.

| Token | Role | Dark default | Light default |
| --- | --- | --- | --- |
| `--state-hover` | Opacity of the hover layer (a percentage) | `8%` | `8%` |
| `--state-focus` | Opacity of the focus layer (a percentage) | `10%` | `10%` |
| `--state-pressed` | Opacity of the pressed layer (a percentage) | `12%` | `12%` |
| `--hover-layer` | Colour laid over a hovered row or button | `color-mix(in srgb, var(--md-on-surface) var(--state-hover), transparent)` | `color-mix(in srgb, var(--md-on-surface) var(--state-hover), transparent)` |
| `--pressed-layer` | Colour laid over a pressed row or button | `color-mix(in srgb, var(--md-on-surface) var(--state-pressed), transparent)` | `color-mix(in srgb, var(--md-on-surface) var(--state-pressed), transparent)` |

### Elevation

Shadows, only for what floats over the window: menus, dialogs, snackbars.

| Token | Role | Dark default | Light default |
| --- | --- | --- | --- |
| `--elev-1` | Shadow of small floating elements (menus, chips) | `0 1px 2px rgb(0 0 0 / 0.3), 0 1px 3px 1px rgb(0 0 0 / 0.15)` | `0 1px 2px rgb(0 0 0 / 0.12), 0 1px 3px 1px rgb(0 0 0 / 0.06)` |
| `--elev-2` | Shadow of popovers | `0 1px 2px rgb(0 0 0 / 0.3), 0 2px 6px 2px rgb(0 0 0 / 0.15)` | `0 1px 2px rgb(0 0 0 / 0.12), 0 2px 6px 2px rgb(0 0 0 / 0.08)` |
| `--elev-3` | Shadow of dialogs | `0 4px 8px 3px rgb(0 0 0 / 0.15), 0 1px 3px rgb(0 0 0 / 0.3)` | `0 4px 8px 3px rgb(0 0 0 / 0.08), 0 1px 3px rgb(0 0 0 / 0.14)` |

### Shape

Corner radii.

| Token | Role | Dark default | Light default |
| --- | --- | --- | --- |
| `--shape-xs` | Extra-small radius: chips, small buttons | `4px` | `4px` |
| `--shape-sm` | Small radius: inputs, rows | `8px` | `8px` |
| `--shape-md` | Medium radius: cards | `12px` | `12px` |
| `--shape-lg` | Large radius: dialogs | `16px` | `16px` |
| `--shape-xl` | Extra-large radius: sheets | `28px` | `28px` |
| `--shape-full` | Pill shape | `999px` | `999px` |
| `--radius` | Default radius of older components | `var(--shape-md)` | `var(--shape-md)` |

### Spacing

The 4/8 px spacing rhythm. Changing these makes the app denser or roomier.

| Token | Role | Dark default | Light default |
| --- | --- | --- | --- |
| `--space-1` | 4 px step | `4px` | `4px` |
| `--space-2` | 8 px step | `8px` | `8px` |
| `--space-3` | 12 px step | `12px` | `12px` |
| `--space-4` | 16 px step | `16px` | `16px` |
| `--space-5` | 20 px step | `20px` | `20px` |
| `--space-6` | 24 px step | `24px` | `24px` |

### Typography

Fonts and the type scale. Only fonts installed on the machine (or embedded with a data: URL in the theme's CSS) can be used.

| Token | Role | Dark default | Light default |
| --- | --- | --- | --- |
| `--fs-label-s` | Small labels and badges | `11px` | `11px` |
| `--fs-label-m` | Labels and metadata | `12px` | `12px` |
| `--fs-title-s` | Small titles: section and card headings | `14px` | `14px` |
| `--fs-title-m` | Titles: dialog headings | `16px` | `16px` |
| `--fs-headline-s` | Headlines: empty states | `22px` | `22px` |
| `--font` | Interface font stack | `"Google Sans Text", "Google Sans", "Roboto Flex", Roboto, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif` | `"Google Sans Text", "Google Sans", "Roboto Flex", Roboto, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif` |
| `--mono` | Monospace font stack: code, diffs, terminals | `"Roboto Mono", "JetBrains Mono", "SF Mono", Menlo, Consolas, monospace` | `"Roboto Mono", "JetBrains Mono", "SF Mono", Menlo, Consolas, monospace` |
| `--font-size` | Base text size. Settings › Font size sets this on the window, which wins over a theme | `13px` | `13px` |

### App aliases

The app's original short names. Most point at a colour role above, so overriding the role is usually enough; override an alias to change only the places that use it.

| Token | Role | Dark default | Light default |
| --- | --- | --- | --- |
| `--bg` | Window background | `var(--frame)` | `var(--frame)` |
| `--bg-elev` | Raised background: inputs, popovers | `var(--md-surface-container)` | `var(--md-surface-container-low)` |
| `--bg-elev2` | Higher background: dialogs, menus | `var(--md-surface-container-high)` | `var(--md-surface-container-high)` |
| `--bg-hover` | Hover background of rows and buttons | `var(--hover-layer)` | `var(--hover-layer)` |
| `--border` | Hairline borders | `var(--md-divider)` | `var(--md-divider)` |
| `--border-strong` | Stronger borders | `var(--md-outline-variant)` | `var(--md-outline-variant)` |
| `--fg` | Main text | `var(--md-on-surface)` | `var(--md-on-surface)` |
| `--fg-muted` | Secondary text | `var(--md-on-surface-variant)` | `var(--md-on-surface-variant)` |
| `--fg-dim` | Faint text: timestamps, placeholders | `#94949f` | `#62626d` |
| `--accent` | Accent colour | `var(--md-primary)` | `var(--md-primary)` |
| `--on-accent` | Text on the accent colour | `var(--md-on-primary)` | `var(--md-on-primary)` |
| `--accent-2` | Second accent: links in session rows, highlights | `#80d5c3` | `#006b5f` |
| `--accent-bg` | Fill of selected rows | `var(--md-secondary-container)` | `var(--md-secondary-container)` |
| `--ok` | Success colour | `var(--md-success)` | `var(--md-success)` |
| `--on-ok` | Text on the success colour | `var(--md-on-success)` | `var(--md-on-success)` |
| `--warn` | Warning colour | `var(--md-tertiary)` | `var(--md-tertiary)` |
| `--err` | Error colour | `var(--md-error)` | `var(--md-error)` |
| `--on-err` | Text on the error colour | `var(--md-on-error)` | `var(--md-on-error)` |
| `--info` | Info colour | `var(--md-info)` | `var(--md-info)` |
| `--focus-ring` | Box-shadow drawn around the focused control | `0 0 0 2px var(--md-primary), 0 0 0 5px color-mix(in srgb, var(--md-primary) 24%, transparent)` | `0 0 0 2px var(--md-primary), 0 0 0 5px color-mix(in srgb, var(--md-primary) 24%, transparent)` |

### Agent colours

The colour that marks each kind of agent in session rows and transcripts.

| Token | Role | Dark default | Light default |
| --- | --- | --- | --- |
| `--agent-claude` | Claude sessions | `#e8a878` | `#9a4c16` |
| `--agent-codex` | Codex sessions | `#8fd9b5` | `#2a7d59` |
| `--agent-terminal` | Terminal sessions | `#a8b1ff` | `#4d5bd6` |
| `--agent-acp` | ACP agent sessions | `#d8b7f5` | `#8045b8` |

### Icons

Small icons drawn from CSS. `--chevron` is an image (it carries its own colour); the others are masks painted in the current text colour. Only `data:` URLs are allowed.

| Token | Role | Dark default | Light default |
| --- | --- | --- | --- |
| `--chevron` | Arrow of select menus (an SVG data: URL) | *(SVG data URL)* | *(SVG data URL)* |
| `--feature-owner-icon` | Flag marking a feature owner session (a mask) | *(SVG data URL)* | *(SVG data URL)* |
| `--orchestrator-icon` | Mark of an orchestrator session (a mask) | *(SVG data URL)* | *(SVG data URL)* |
| `--inbox-icon` | Inbox icon (a mask) | *(SVG data URL)* | *(SVG data URL)* |

### Terminal

The embedded terminal's colours. Use plain colours (#rrggbb, rgb(), rgba(), hsl()): the terminal draws on a canvas and cannot use color-mix(); var(--token) works when that token is a plain colour. The 16 ANSI colours are what programs ask for by number, so keep each readable on --term-bg.

| Token | Role | Dark default | Light default |
| --- | --- | --- | --- |
| `--term-bg` | Terminal background | `#0b0d13` | `#fbfbfe` |
| `--term-fg` | Default text colour | `#e6e8ef` | `#1f2230` |
| `--term-cursor` | Cursor colour | `#8b7cff` | `#4c56a8` |
| `--term-cursor-accent` | Text under a block cursor | `#0b0d13` | `#fbfbfe` |
| `--term-selection` | Selection background (use alpha so text shows through) | `rgba(139,124,255,0.35)` | `rgba(76,86,168,0.22)` |
| `--term-black` | ANSI 0, black | `#1b1f2d` | `#1f2230` |
| `--term-red` | ANSI 1, red | `#ff6b7a` | `#b3261e` |
| `--term-green` | ANSI 2, green | `#4ad295` | `#1b6d3f` |
| `--term-yellow` | ANSI 3, yellow | `#f2b84b` | `#7a5900` |
| `--term-blue` | ANSI 4, blue | `#62b0ff` | `#1f5fa8` |
| `--term-magenta` | ANSI 5, magenta | `#c792ea` | `#7d3aa8` |
| `--term-cyan` | ANSI 6, cyan | `#5ee0c8` | `#00696b` |
| `--term-white` | ANSI 7, white (a grey in light themes, so it stays readable) | `#d0d4e0` | `#5d6273` |
| `--term-bright-black` | ANSI 8, bright black (dim text, comments) | `#6b7490` | `#6b7080` |
| `--term-bright-red` | ANSI 9, bright red | `#ff8a95` | `#c4372e` |
| `--term-bright-green` | ANSI 10, bright green | `#7fe0b3` | `#237f4b` |
| `--term-bright-yellow` | ANSI 11, bright yellow | `#ffd07a` | `#8a6600` |
| `--term-bright-blue` | ANSI 12, bright blue | `#8cc6ff` | `#2a6cc0` |
| `--term-bright-magenta` | ANSI 13, bright magenta | `#dcb3f5` | `#8e4bbb` |
| `--term-bright-cyan` | ANSI 14, bright cyan | `#8fece0` | `#0b7b7d` |
| `--term-bright-white` | ANSI 15, bright white (the darkest ink in light themes) | `#ffffff` | `#2b2f3d` |

### Layout sizes

Default sizes of the panes and the title bar.

| Token | Role | Dark default | Light default |
| --- | --- | --- | --- |
| `--sidebar-w` | Sidebar width | `280px` | `280px` |
| `--inspector-w` | Inspector width | `320px` | `320px` |
| `--titlebar-h` | Title bar height | `38px` | `38px` |

<!-- token-reference:end -->
