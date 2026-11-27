//! User themes: `<data dir>/themes/<id>.json` (plus an optional `<id>.css`),
//! and the same inside a mod's `themes/` folder.
//!
//! A theme picks a base (`dark` or `light`) and overrides design tokens, the
//! CSS custom properties of the desktop's `styles.css`. The token list is read
//! from that file at compile time, so it cannot drift from the app it ships
//! with. Validation never fails a listing: a theme that cannot be used is
//! listed with `error` set, and the app falls back to its base.

use serde::Serialize;
use serde_json::Value;
use std::collections::BTreeMap;
use std::path::Path;
use std::sync::OnceLock;

/// The desktop's stylesheet, whose `:root` blocks define the tokens.
const STYLES_CSS: &str = include_str!("../../../apps/desktop/src/styles.css");

/// Largest `<id>.json` accepted.
pub const MAX_JSON_BYTES: usize = 128 * 1024;
/// Largest `<id>.css` accepted.
pub const MAX_CSS_BYTES: usize = 256 * 1024;
/// Longest single token value.
pub const MAX_VALUE_CHARS: usize = 4000;
/// Names a user theme may not take: the built-in choices.
pub const RESERVED_IDS: [&str; 3] = ["dark", "light", "system"];

/// One design token: its name, what it is for, and its built-in values.
#[derive(Debug, Clone, Serialize)]
pub struct Token {
    pub name: String,
    pub group: &'static str,
    pub role: &'static str,
    pub dark: String,
    pub light: String,
}

/// A token group, with the comment the scaffold and the guide print for it.
pub struct Group {
    pub title: &'static str,
    pub about: &'static str,
    pub tokens: &'static [(&'static str, &'static str)],
}

/// What every token is for, grouped. Every token in `styles.css` must be here
/// (a test checks both ways).
pub const GROUPS: &[Group] = &[
    Group {
        title: "Colour roles",
        about: "Material 3 colour roles. Most of the app is painted from these; change these first. An `on-*` colour is text and icons drawn on top of the colour it names, so keep each pair readable (4.5:1 contrast for text).",
        tokens: &[
            ("--md-primary", "Main accent: links, focused borders, selected items, primary buttons"),
            ("--md-on-primary", "Text and icons on `--md-primary` (primary button labels)"),
            ("--md-primary-container", "Quieter accent fill: selected chips and highlighted rows"),
            ("--md-on-primary-container", "Text on `--md-primary-container`"),
            ("--md-secondary", "Secondary accent for less prominent controls"),
            ("--md-on-secondary", "Text on `--md-secondary`"),
            ("--md-secondary-container", "Fill of selected list rows, tabs and toggles (`--accent-bg`)"),
            ("--md-on-secondary-container", "Text on `--md-secondary-container`"),
            ("--md-tertiary", "Warning colour (`--warn`): waiting sessions, cautions"),
            ("--md-on-tertiary", "Text on `--md-tertiary`"),
            ("--md-tertiary-container", "Fill of warning banners"),
            ("--md-on-tertiary-container", "Text on `--md-tertiary-container`"),
            ("--md-error", "Errors, failed states and destructive buttons (`--err`)"),
            ("--md-on-error", "Text on `--md-error`"),
            ("--md-error-container", "Fill of error banners"),
            ("--md-on-error-container", "Text on `--md-error-container`"),
            ("--md-success", "Success and running states (`--ok`)"),
            ("--md-on-success", "Text on `--md-success`"),
            ("--md-info", "Informational highlights (`--info`)"),
            ("--md-surface", "Base surface; the window frame (`--frame`) in the dark theme"),
            ("--md-surface-container-lowest", "Lowest surface tone; the panels in the light theme"),
            ("--md-surface-container-low", "Panels: main area and inspector cards (`--panel`) in the dark theme"),
            ("--md-surface-container", "Raised surfaces: popovers and inputs (`--bg-elev`); the frame in the light theme"),
            ("--md-surface-container-high", "Higher surfaces: dialogs and menus (`--bg-elev2`)"),
            ("--md-surface-container-highest", "Highest surface tone: tooltips, pressed fills"),
            ("--md-on-surface", "Main text colour (`--fg`)"),
            ("--md-on-surface-variant", "Secondary text: labels, metadata (`--fg-muted`)"),
            ("--md-outline", "Strong outlines: input borders, focus outlines"),
            ("--md-outline-variant", "Subtle outlines (`--border-strong`)"),
            ("--md-divider", "Hairline dividers between rows and panes (`--border`)"),
            ("--md-inverse-surface", "Background of snackbars and toasts"),
            ("--md-inverse-on-surface", "Text on `--md-inverse-surface`"),
            ("--md-inverse-primary", "Accent on inverse surfaces (toast actions)"),
            ("--md-inverse-warn", "Warning colour on inverse surfaces"),
            ("--md-inverse-error", "Error colour on inverse surfaces"),
            ("--md-scrim", "Dimming layer behind dialogs (use a colour with alpha)"),
        ],
    },
    Group {
        title: "Layout surfaces",
        about: "Which surface tone the big areas use.",
        tokens: &[
            ("--frame", "Window frame: title bar, sidebar, gaps between panes"),
            ("--panel", "Main area and inspector cards"),
        ],
    },
    Group {
        title: "State layers",
        about: "Hover and press feedback: an on-colour laid over a surface at a fixed opacity.",
        tokens: &[
            ("--state-hover", "Opacity of the hover layer (a percentage)"),
            ("--state-focus", "Opacity of the focus layer (a percentage)"),
            ("--state-pressed", "Opacity of the pressed layer (a percentage)"),
            ("--hover-layer", "Colour laid over a hovered row or button"),
            ("--pressed-layer", "Colour laid over a pressed row or button"),
        ],
    },
    Group {
        title: "Elevation",
        about: "Shadows, only for what floats over the window: menus, dialogs, snackbars.",
        tokens: &[
            ("--elev-1", "Shadow of small floating elements (menus, chips)"),
            ("--elev-2", "Shadow of popovers"),
            ("--elev-3", "Shadow of dialogs"),
        ],
    },
    Group {
        title: "Shape",
        about: "Corner radii.",
        tokens: &[
            ("--shape-xs", "Extra-small radius: chips, small buttons"),
            ("--shape-sm", "Small radius: inputs, rows"),
            ("--shape-md", "Medium radius: cards"),
            ("--shape-lg", "Large radius: dialogs"),
            ("--shape-xl", "Extra-large radius: sheets"),
            ("--shape-full", "Pill shape"),
            ("--radius", "Default radius of older components"),
        ],
    },
    Group {
        title: "Spacing",
        about: "The 4/8 px spacing rhythm. Changing these makes the app denser or roomier.",
        tokens: &[
            ("--space-1", "4 px step"),
            ("--space-2", "8 px step"),
            ("--space-3", "12 px step"),
            ("--space-4", "16 px step"),
            ("--space-5", "20 px step"),
            ("--space-6", "24 px step"),
        ],
    },
    Group {
        title: "Typography",
        about: "Fonts and the type scale. Only fonts installed on the machine (or embedded with a data: URL in the theme's CSS) can be used.",
        tokens: &[
            ("--fs-label-s", "Small labels and badges"),
            ("--fs-label-m", "Labels and metadata"),
            ("--fs-title-s", "Small titles: section and card headings"),
            ("--fs-title-m", "Titles: dialog headings"),
            ("--fs-headline-s", "Headlines: empty states"),
            ("--font", "Interface font stack"),
            ("--mono", "Monospace font stack: code, diffs, terminals"),
            ("--font-size", "Base text size. Settings › Font size sets this on the window, which wins over a theme"),
        ],
    },
    Group {
        title: "App aliases",
        about: "The app's original short names. Most point at a colour role above, so overriding the role is usually enough; override an alias to change only the places that use it.",
        tokens: &[
            ("--bg", "Window background"),
            ("--bg-elev", "Raised background: inputs, popovers"),
            ("--bg-elev2", "Higher background: dialogs, menus"),
            ("--bg-hover", "Hover background of rows and buttons"),
            ("--border", "Hairline borders"),
            ("--border-strong", "Stronger borders"),
            ("--fg", "Main text"),
            ("--fg-muted", "Secondary text"),
            ("--fg-dim", "Faint text: timestamps, placeholders"),
            ("--accent", "Accent colour"),
            ("--on-accent", "Text on the accent colour"),
            ("--accent-2", "Second accent: links in session rows, highlights"),
            ("--accent-bg", "Fill of selected rows"),
            ("--ok", "Success colour"),
            ("--on-ok", "Text on the success colour"),
            ("--warn", "Warning colour"),
            ("--err", "Error colour"),
            ("--on-err", "Text on the error colour"),
            ("--info", "Info colour"),
            ("--focus-ring", "Box-shadow drawn around the focused control"),
        ],
    },
    Group {
        title: "Agent colours",
        about: "The colour that marks each kind of agent in session rows and transcripts.",
        tokens: &[
            ("--agent-claude", "Claude sessions"),
            ("--agent-codex", "Codex sessions"),
            ("--agent-terminal", "Terminal sessions"),
            ("--agent-acp", "ACP agent sessions"),
        ],
    },
    Group {
        title: "Icons",
        about: "Small icons drawn from CSS. `--chevron` is an image (it carries its own colour); the others are masks painted in the current text colour. Only `data:` URLs are allowed.",
        tokens: &[
            ("--chevron", "Arrow of select menus (an SVG data: URL)"),
            ("--feature-owner-icon", "Flag marking a feature owner session (a mask)"),
            ("--orchestrator-icon", "Mark of an orchestrator session (a mask)"),
            ("--inbox-icon", "Inbox icon (a mask)"),
        ],
    },
    Group {
        title: "Terminal",
        about: "The embedded terminal's colours. Use plain colours (#rrggbb, rgb(), rgba(), hsl()): the terminal draws on a canvas and cannot use color-mix(); var(--token) works when that token is a plain colour. The 16 ANSI colours are what programs ask for by number, so keep each readable on --term-bg.",
        tokens: &[
            ("--term-bg", "Terminal background"),
            ("--term-fg", "Default text colour"),
            ("--term-cursor", "Cursor colour"),
            ("--term-cursor-accent", "Text under a block cursor"),
            ("--term-selection", "Selection background (use alpha so text shows through)"),
            ("--term-black", "ANSI 0, black"),
            ("--term-red", "ANSI 1, red"),
            ("--term-green", "ANSI 2, green"),
            ("--term-yellow", "ANSI 3, yellow"),
            ("--term-blue", "ANSI 4, blue"),
            ("--term-magenta", "ANSI 5, magenta"),
            ("--term-cyan", "ANSI 6, cyan"),
            ("--term-white", "ANSI 7, white (a grey in light themes, so it stays readable)"),
            ("--term-bright-black", "ANSI 8, bright black (dim text, comments)"),
            ("--term-bright-red", "ANSI 9, bright red"),
            ("--term-bright-green", "ANSI 10, bright green"),
            ("--term-bright-yellow", "ANSI 11, bright yellow"),
            ("--term-bright-blue", "ANSI 12, bright blue"),
            ("--term-bright-magenta", "ANSI 13, bright magenta"),
            ("--term-bright-cyan", "ANSI 14, bright cyan"),
            ("--term-bright-white", "ANSI 15, bright white (the darkest ink in light themes)"),
        ],
    },
    Group {
        title: "Layout sizes",
        about: "Default sizes of the panes and the title bar.",
        tokens: &[
            ("--sidebar-w", "Sidebar width"),
            ("--inspector-w", "Inspector width"),
            ("--titlebar-h", "Title bar height"),
        ],
    },
];

/// The `--name: value` declarations of the rule `selector` in `css`, whatever its formatting.
fn declarations(css: &str, selector: &str) -> Vec<(String, String)> {
    crate::css::custom_properties(css, selector)
}

/// The tokens of `styles.css` with their dark and light values, in file order.
pub fn tokens() -> &'static [Token] {
    static TOKENS: OnceLock<Vec<Token>> = OnceLock::new();
    TOKENS.get_or_init(|| tokens_from(STYLES_CSS))
}

fn tokens_from(css: &str) -> Vec<Token> {
    let light: BTreeMap<String, String> = declarations(css, ":root[data-theme=\"light\"]")
        .into_iter()
        .collect();
    declarations(css, ":root")
        .into_iter()
        .map(|(name, dark)| {
            let (group, role) = describe(&name).unwrap_or(("Other", ""));
            Token {
                light: light.get(&name).cloned().unwrap_or_else(|| dark.clone()),
                name,
                group,
                role,
                dark,
            }
        })
        .collect()
}

fn describe(name: &str) -> Option<(&'static str, &'static str)> {
    GROUPS.iter().find_map(|g| {
        g.tokens
            .iter()
            .find(|(n, _)| *n == name)
            .map(|(_, r)| (g.title, *r))
    })
}

pub fn is_token(name: &str) -> bool {
    tokens().iter().any(|t| t.name == name)
}

/// A theme as the app sees it. `error` set means it cannot be used; the app
/// then shows `base` (or dark) and the reason.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Theme {
    pub id: String,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub author: Option<String>,
    pub base: String,
    /// Valid overrides only.
    pub tokens: BTreeMap<String, String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub css: Option<String>,
    /// `<id>.json` on disk.
    pub path: String,
    /// `user`, or `mod:<mod id>` for a theme a mod ships.
    pub source: String,
    pub warnings: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    /// For a theme with CSS, set by the daemon: `"needs_approval"` (its CSS
    /// is withheld until the user approves it) or `"approved"`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub approval: Option<String>,
    /// The size of CSS that waits for approval.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub css_bytes: Option<usize>,
}

/// Whether `id` may name a theme file: lowercase letters, digits and dashes.
pub fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && !id.starts_with('-')
        && id
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
        && !RESERVED_IDS.contains(&id)
}

/// Why `text` (a token value or a theme's CSS) would load something from
/// outside the app or use a construct a theme may not. Escapes are decoded
/// first (see [`crate::css`]); only `data:` URLs are allowed.
pub fn remote_reference(text: &str) -> Option<String> {
    crate::css::resource_problem(text)
}

/// Levenshtein distance, for "did you mean".
fn distance(a: &str, b: &str) -> usize {
    let b: Vec<char> = b.chars().collect();
    let mut prev: Vec<usize> = (0..=b.len()).collect();
    for (i, ca) in a.chars().enumerate() {
        let mut cur = vec![i + 1];
        for (j, cb) in b.iter().enumerate() {
            cur.push(
                (prev[j] + usize::from(ca != *cb))
                    .min(prev[j + 1] + 1)
                    .min(cur[j] + 1),
            );
        }
        prev = cur;
    }
    prev[b.len()]
}

/// The token closest to a misspelt `name`, when one is close enough to be the likely intent.
pub fn closest_token(name: &str) -> Option<&'static str> {
    let (best, d) = tokens()
        .iter()
        .map(|t| (t.name.as_str(), distance(name, &t.name)))
        .min_by_key(|(_, d)| *d)?;
    (d <= (name.len() / 3).max(2)).then_some(best)
}

/// Validate a theme's `<id>.json` text and optional `<id>.css` text.
pub fn validate(id: &str, json: &str, css: Option<&str>) -> Theme {
    let mut t = Theme {
        id: id.to_string(),
        name: id.to_string(),
        author: None,
        base: "dark".into(),
        tokens: BTreeMap::new(),
        css: None,
        path: String::new(),
        source: "user".into(),
        warnings: vec![],
        error: None,
        approval: None,
        css_bytes: None,
    };
    let mut errors: Vec<String> = vec![];
    if json.len() > MAX_JSON_BYTES {
        t.error = Some(format!(
            "{id}.json is {} KB; the limit is {} KB",
            json.len() / 1024,
            MAX_JSON_BYTES / 1024
        ));
        return t;
    }
    let doc: Value = match serde_json::from_str(json) {
        Ok(v) => v,
        Err(e) => {
            t.error = Some(format!("{id}.json is not valid JSON: {e}"));
            return t;
        }
    };
    let Some(obj) = doc.as_object() else {
        t.error = Some(format!("{id}.json must be a JSON object"));
        return t;
    };
    match obj.get("name") {
        Some(Value::String(n)) if !n.trim().is_empty() && n.chars().count() <= 80 => {
            t.name = n.trim().to_string()
        }
        Some(_) => {
            errors.push("\"name\" must be a non-empty string of at most 80 characters".into())
        }
        None => errors.push("\"name\" is missing".into()),
    }
    match obj.get("author") {
        None | Some(Value::Null) => {}
        Some(Value::String(a)) => t.author = Some(a.chars().take(80).collect()),
        Some(_) => t
            .warnings
            .push("\"author\" should be a string; ignored".into()),
    }
    match obj.get("base").and_then(Value::as_str) {
        Some(b @ ("dark" | "light")) => t.base = b.to_string(),
        Some(other) => errors.push(format!(
            "\"base\" is {other:?}; it must be \"dark\" or \"light\""
        )),
        None => errors.push("\"base\" is missing; set it to \"dark\" or \"light\"".into()),
    }
    for key in obj.keys() {
        if !matches!(
            key.as_str(),
            "name" | "author" | "base" | "tokens" | "description" | "$schema"
        ) && !key.starts_with("//")
        {
            t.warnings.push(format!("unknown field {key:?} is ignored"));
        }
    }
    match obj.get("tokens") {
        None => t
            .warnings
            .push("no \"tokens\": the theme looks exactly like its base".into()),
        Some(Value::Object(tokens)) => {
            for (name, value) in tokens {
                if name.starts_with("//") {
                    continue; // a comment
                }
                if !is_token(name) {
                    t.warnings.push(match closest_token(name) {
                        Some(near) => {
                            format!("{name} is not an Aura token; ignored. Did you mean {near}?")
                        }
                        None => format!(
                            "{name} is not an Aura token; ignored (see `aura guide themes`)"
                        ),
                    });
                    continue;
                }
                let Some(v) = value.as_str() else {
                    t.warnings.push(format!(
                        "{name} must be a string, like \"#336699\"; ignored"
                    ));
                    continue;
                };
                let v = v.trim();
                if v.is_empty() {
                    t.warnings.push(format!("{name} is empty; ignored"));
                } else if v.chars().count() > MAX_VALUE_CHARS {
                    t.warnings.push(format!(
                        "{name} is longer than {MAX_VALUE_CHARS} characters; ignored"
                    ));
                } else if let Some(why) = crate::css::single_value_problem(v) {
                    errors.push(format!("{name}: {why}"));
                } else if let Some(why) = crate::css::token_resource_problem(v) {
                    errors.push(format!("{name}: {why}"));
                } else {
                    t.tokens.insert(name.clone(), v.to_string());
                }
            }
        }
        Some(_) => {
            errors.push("\"tokens\" must be an object of \"--token\": \"value\" pairs".into())
        }
    }
    if let Some(css) = css {
        if css.len() > MAX_CSS_BYTES {
            errors.push(format!(
                "{id}.css is {} KB; the limit is {} KB",
                css.len() / 1024,
                MAX_CSS_BYTES / 1024
            ));
        } else if let Some(why) = remote_reference(css) {
            errors.push(format!("{id}.css: {why}"));
        } else if !css.trim().is_empty() {
            t.css = Some(css.to_string());
        }
    }
    if !errors.is_empty() {
        t.error = Some(errors.join("; "));
        t.tokens.clear();
        t.css = None;
    }
    t
}

/// Read and validate `<dir>/<stem>.json` (and `<stem>.css`). Never fails: a
/// problem is reported in the theme's `error`.
pub fn load(json_path: &Path, id: &str, source: &str) -> Theme {
    let css_path = json_path.with_extension("css");
    let mut t = match read_capped(json_path, MAX_JSON_BYTES) {
        Err(e) => {
            let mut t = validate(id, "{}", None);
            t.warnings.clear();
            t.error = Some(e);
            t
        }
        Ok(json) => match std::fs::symlink_metadata(&css_path)
            .is_ok()
            .then(|| read_capped(&css_path, MAX_CSS_BYTES))
        {
            Some(Err(e)) => {
                let mut t = validate(id, &json, None);
                t.error = Some(e);
                t.tokens.clear();
                t
            }
            Some(Ok(css)) => validate(id, &json, Some(&css)),
            None => validate(id, &json, None),
        },
    };
    t.path = json_path.to_string_lossy().to_string();
    t.source = source.to_string();
    t
}

/// Read a theme file of at most `cap` bytes. The file is opened once and at
/// most `cap + 1` bytes are read, so a huge or growing file costs nothing.
/// It must be a regular file; a symlink is followed only when its target is
/// inside the theme's own folder.
pub fn read_capped(path: &Path, cap: usize) -> Result<String, String> {
    use std::io::Read;
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();
    let link = std::fs::symlink_metadata(path).map_err(|e| format!("cannot read {name}: {e}"))?;
    if link.file_type().is_symlink() {
        let folder = path.parent().and_then(|p| std::fs::canonicalize(p).ok());
        let target =
            std::fs::canonicalize(path).map_err(|e| format!("{name} is a broken symlink: {e}"))?;
        if !folder.is_some_and(|f| target.starts_with(&f)) {
            return Err(format!(
                "{name} is a symlink to {}, outside the theme's folder; Aura reads theme files only from that folder",
                target.display()
            ));
        }
    }
    let file = std::fs::File::open(path).map_err(|e| format!("cannot read {name}: {e}"))?;
    let meta = file
        .metadata()
        .map_err(|e| format!("cannot read {name}: {e}"))?;
    if !meta.is_file() {
        return Err(format!("{name} is not a regular file"));
    }
    let mut bytes = Vec::new();
    file.take(cap as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| format!("cannot read {name}: {e}"))?;
    if bytes.len() > cap {
        let len = meta.len().max(bytes.len() as u64) as usize;
        return Err(format!(
            "{name} is {} KB; the limit is {} KB",
            len / 1024,
            cap / 1024
        ));
    }
    String::from_utf8(bytes).map_err(|_| format!("{name} is not UTF-8 text"))
}

/// The themes in `dir` (`*.json`), ids prefixed with `prefix` when given
/// (`<mod id>:` for a mod's themes). Sorted by id.
pub fn list_dir(dir: &Path, prefix: Option<&str>, source: &str) -> Vec<Theme> {
    let Ok(read) = std::fs::read_dir(dir) else {
        return vec![];
    };
    let mut out: Vec<Theme> = read
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|p| p.extension().is_some_and(|x| x == "json") && !p.is_dir())
        .filter_map(|p| {
            let stem = p.file_stem()?.to_string_lossy().to_string();
            let id = match prefix {
                Some(m) => format!("{m}:{stem}"),
                None => stem.clone(),
            };
            let mut t = load(&p, &id, source);
            if !valid_id(&stem) && t.error.is_none() {
                t.error = Some(format!(
                    "the file name {stem:?} is not a theme id: use lowercase letters, digits and dashes (not dark, light or system)"
                ));
                t.tokens.clear();
                t.css = None;
            }
            Some(t)
        })
        .collect();
    out.sort_by(|a, b| a.id.cmp(&b.id));
    out
}

/// A new theme's JSON: every token with the base's current value, a comment per group.
pub fn scaffold(name: &str, base: &str) -> String {
    // Written by hand: serde_json's map sorts keys, and the groups must stay in order.
    let light = base == "light";
    let s = |v: &str| serde_json::to_string(v).unwrap_or_default();
    let mut lines: Vec<String> = vec![];
    for g in GROUPS {
        lines.push(format!(
            "    {}: {}",
            s(&format!("// {}", g.title)),
            s(g.about)
        ));
        for (name, _) in g.tokens {
            if let Some(t) = tokens_by_name(name) {
                lines.push(format!(
                    "    {}: {}",
                    s(&t.name),
                    s(if light { &t.light } else { &t.dark })
                ));
            }
        }
    }
    format!(
        "{{\n  \"//\": {},\n  \"name\": {},\n  \"author\": \"\",\n  \"base\": {},\n  \"tokens\": {{\n{}\n  }}\n}}\n",
        s("An Aura theme. Change the values you want and delete the rest: a token left out keeps the base theme's value. `aura guide themes` explains every token; `aura themes check <id>` validates this file."),
        s(name),
        s(base),
        lines.join(",\n")
    )
}

fn tokens_by_name(name: &str) -> Option<&'static Token> {
    tokens().iter().find(|t| t.name == name)
}

/// The token reference section of the themes guide (between the markers).
pub fn reference_markdown() -> String {
    let mut out = String::new();
    for g in GROUPS {
        out.push_str(&format!("### {}\n\n{}\n\n", g.title, g.about));
        out.push_str(
            "| Token | Role | Dark default | Light default |\n| --- | --- | --- | --- |\n",
        );
        for (name, role) in g.tokens {
            let Some(t) = tokens_by_name(name) else {
                continue;
            };
            let cell = |v: &str| {
                if v.starts_with("url(") {
                    "*(SVG data URL)*".to_string()
                } else {
                    format!("`{}`", v.replace('|', "\\|"))
                }
            };
            out.push_str(&format!(
                "| `{}` | {} | {} | {} |\n",
                t.name,
                role,
                cell(&t.dark),
                cell(&t.light)
            ));
        }
        out.push('\n');
    }
    out.trim_end().to_string() + "\n"
}

pub const REFERENCE_START: &str = "<!-- token-reference:start (generated from apps/desktop/src/styles.css; do not edit by hand) -->";
pub const REFERENCE_END: &str = "<!-- token-reference:end -->";

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_token_in_styles_css_is_described_and_nothing_else() {
        let names: Vec<&str> = tokens().iter().map(|t| t.name.as_str()).collect();
        assert!(
            names.len() > 90,
            "found only {} tokens in styles.css",
            names.len()
        );
        let undocumented: Vec<&&str> = names.iter().filter(|n| describe(n).is_none()).collect();
        assert!(
            undocumented.is_empty(),
            "styles.css has tokens without a role in aura_core::themes::GROUPS: {undocumented:?}"
        );
        let stale: Vec<&str> = GROUPS
            .iter()
            .flat_map(|g| g.tokens.iter().map(|(n, _)| *n))
            .filter(|n| !names.contains(n))
            .collect();
        assert!(
            stale.is_empty(),
            "GROUPS names tokens styles.css no longer has: {stale:?}"
        );
    }

    #[test]
    fn the_themes_guide_has_the_current_token_reference() {
        let path =
            Path::new(env!("CARGO_MANIFEST_DIR")).join("../../docs/agents/creating-themes.md");
        let guide = std::fs::read_to_string(&path).unwrap();
        let start = guide.find(REFERENCE_START).expect("start marker") + REFERENCE_START.len();
        let end = guide.find(REFERENCE_END).expect("end marker");
        let want = format!("\n\n{}\n", reference_markdown());
        if guide[start..end] != want {
            if std::env::var_os("UPDATE_GUIDES").is_some() {
                let updated = format!("{}{}{}", &guide[..start], want, &guide[end..]);
                std::fs::write(&path, updated).unwrap();
            } else {
                panic!(
                    "docs/agents/creating-themes.md has an outdated token reference; run\n  UPDATE_GUIDES=1 cargo test -p aura-core themes"
                );
            }
        }
    }

    #[test]
    fn terminal_colours_are_tokens_with_both_palettes() {
        let term: Vec<&Token> = tokens()
            .iter()
            .filter(|t| t.name.starts_with("--term-"))
            .collect();
        assert_eq!(
            term.len(),
            21,
            "background, foreground, cursor, cursor accent, selection and 16 ANSI colours"
        );
        assert!(term.iter().all(|t| t.group == "Terminal"));
        assert_eq!(tokens_by_name("--term-bg").unwrap().dark, "#0b0d13");
        assert_eq!(tokens_by_name("--term-bg").unwrap().light, "#fbfbfe");
        let differ = term.iter().filter(|t| t.dark != t.light).count();
        assert_eq!(differ, 21, "the light theme has its own terminal palette");
        assert!(reference_markdown().contains("| `--term-bright-white` |"));
    }

    #[test]
    fn token_values_cannot_inject_declarations() {
        // The reviewer's case: this hid the whole app.
        let t = validate(
            "x",
            r#"{"name":"X","base":"dark","tokens":{"--fg":"red;display:none"}}"#,
            None,
        );
        assert!(
            t.error.as_deref().unwrap().contains("--fg"),
            "{:?}",
            t.error
        );
        let t = validate(
            "x",
            r#"{"name":"X","base":"dark","tokens":{"--fg":"red !important"}}"#,
            None,
        );
        assert!(t.error.is_some());
        let t = validate(
            "x",
            r#"{"name":"X","base":"dark","tokens":{"--font":"\"a;b\", serif"}}"#,
            None,
        );
        assert_eq!(t.error, None, "; inside a string is text");
    }

    #[test]
    fn escaped_resources_are_refused_in_tokens_and_css() {
        let t = validate(
            "x",
            r#"{"name":"X","base":"dark","tokens":{"--chevron":"u\\72l(https://evil.example/a.svg)"}}"#,
            None,
        );
        assert!(
            t.error.as_deref().unwrap().contains("--chevron"),
            "{:?}",
            t.error
        );
        let css = validate(
            "x",
            r#"{"name":"X","base":"dark"}"#,
            Some(r#"@im\70ort "https://evil.example/x.css";"#),
        );
        assert!(
            css.error.as_deref().unwrap().contains("@import"),
            "{:?}",
            css.error
        );
    }

    #[test]
    fn a_tokens_only_theme_cannot_fetch_through_var() {
        // The re-review's probe: needs no approval, and both engines fetched the URL.
        let t = validate(
            "x",
            r#"{"name":"X","base":"dark","tokens":{"--mono":"\"https://evil.example/a.png\"","--chevron":"image-set(var(--mono) 1x)"}}"#,
            None,
        );
        assert!(
            t.error.as_deref().unwrap().contains("--chevron"),
            "{:?}",
            t.error
        );
        let css = validate(
            "x",
            r#"{"name":"X","base":"dark"}"#,
            Some(".a { background-image: image-set(var(--mono) 1x) }"),
        );
        assert!(
            css.error.as_deref().unwrap().contains("var()"),
            "{:?}",
            css.error
        );
        // Every built-in token value is still accepted.
        for tok in tokens() {
            assert_eq!(
                crate::css::token_resource_problem(&tok.dark),
                None,
                "{}",
                tok.name
            );
            assert_eq!(
                crate::css::token_resource_problem(&tok.light),
                None,
                "{}",
                tok.name
            );
        }
    }

    #[test]
    fn unknown_tokens_suggest_the_closest() {
        assert_eq!(closest_token("--md-primay"), Some("--md-primary"));
        assert_eq!(closest_token("--term-backround"), None, "too far: no guess");
        assert_eq!(closest_token("--term-bgg"), Some("--term-bg"));
        let t = validate(
            "x",
            r#"{"name":"X","base":"dark","tokens":{"--md-primay":"red"}}"#,
            None,
        );
        assert!(
            t.warnings[0].contains("Did you mean --md-primary?"),
            "{:?}",
            t.warnings
        );
    }

    #[test]
    fn reads_are_bounded_and_symlinks_stay_inside() {
        let dir = tempfile::tempdir().unwrap();
        let themes = dir.path().join("themes");
        std::fs::create_dir_all(&themes).unwrap();
        std::fs::write(themes.join("big.json"), vec![b' '; MAX_JSON_BYTES * 4]).unwrap();
        let err = read_capped(&themes.join("big.json"), MAX_JSON_BYTES).unwrap_err();
        assert!(err.contains("limit"), "{err}");
        std::fs::create_dir_all(themes.join("dir.json")).unwrap();
        assert!(
            list_dir(&themes, None, "user")
                .iter()
                .all(|t| t.id != "dir"),
            "a folder is not a theme"
        );
        #[cfg(unix)]
        {
            std::fs::write(
                dir.path().join("outside.json"),
                r#"{"name":"O","base":"dark"}"#,
            )
            .unwrap();
            std::os::unix::fs::symlink(dir.path().join("outside.json"), themes.join("out.json"))
                .unwrap();
            std::fs::write(themes.join("real.json"), r#"{"name":"R","base":"dark"}"#).unwrap();
            std::os::unix::fs::symlink(themes.join("real.json"), themes.join("alias.json"))
                .unwrap();
            let list = list_dir(&themes, None, "user");
            let out = list.iter().find(|t| t.id == "out").unwrap();
            assert!(
                out.error
                    .as_deref()
                    .unwrap()
                    .contains("outside the theme's folder"),
                "{:?}",
                out.error
            );
            assert_eq!(
                list.iter().find(|t| t.id == "alias").unwrap().error,
                None,
                "a link inside the folder is fine"
            );
        }
    }

    #[test]
    fn light_values_fall_back_to_dark() {
        let t = tokens_by_name("--md-primary").unwrap();
        assert_eq!(t.dark, "#bcc2ff");
        assert_eq!(t.light, "#4c56a8");
        let shape = tokens_by_name("--shape-md").unwrap();
        assert_eq!(shape.light, shape.dark);
    }

    #[test]
    fn a_valid_theme() {
        let t = validate(
            "ocean",
            r##"{"name":"Ocean","author":"me","base":"light","tokens":{"// c":"x","--md-primary":"#0066cc","--bg":"var(--md-surface)"}}"##,
            Some(":root { --x: 1px }"),
        );
        assert_eq!(t.error, None);
        assert_eq!(t.name, "Ocean");
        assert_eq!(t.base, "light");
        assert_eq!(t.tokens.len(), 2);
        assert!(t.warnings.is_empty(), "{:?}", t.warnings);
        assert!(t.css.is_some());
    }

    #[test]
    fn unknown_tokens_warn_and_are_dropped() {
        let t = validate(
            "x",
            r#"{"name":"X","base":"dark","tokens":{"--nope":"red","--fg":3}}"#,
            None,
        );
        assert_eq!(t.error, None);
        assert!(t.tokens.is_empty());
        assert_eq!(t.warnings.len(), 2, "{:?}", t.warnings);
        assert!(t.warnings.iter().any(|w| w.contains("--nope")));
    }

    #[test]
    fn broken_themes_say_why() {
        let bad_json = validate("x", "{ nope", None);
        assert!(bad_json.error.unwrap().contains("not valid JSON"));
        let bad_base = validate("x", r#"{"name":"X","base":"blue"}"#, None);
        assert!(bad_base.error.unwrap().contains("\"base\""));
        let no_name = validate("x", r#"{"base":"dark"}"#, None);
        assert!(no_name.error.unwrap().contains("name"));
        let braces = validate(
            "x",
            r#"{"name":"X","base":"dark","tokens":{"--fg":"red} body {display:none"}}"#,
            None,
        );
        assert!(braces.error.unwrap().contains("{ or }"));
        let big = validate("x", &" ".repeat(MAX_JSON_BYTES + 1), None);
        assert!(big.error.unwrap().contains("limit"));
    }

    #[test]
    fn remote_urls_are_refused_data_urls_allowed() {
        assert!(remote_reference(
            "url('data:image/svg+xml;utf8,<svg xmlns=\"http://www.w3.org/2000/svg\"/>')"
        )
        .is_none());
        assert!(remote_reference("url('data:image/png;base64,AAA') no-repeat").is_none());
        assert!(remote_reference("url(https://evil.example/x.png)").is_some());
        assert!(remote_reference("URL( \"//evil.example/x.png\" )").is_some());
        assert!(remote_reference("url(/etc/passwd)").is_some());
        assert!(remote_reference("@import 'x.css';").is_some());
        assert!(remote_reference("image-set(\"https://x/y.png\" 1x)").is_some());
        assert!(remote_reference("/* see https://example.com */ color: red").is_none());
        let t = validate(
            "x",
            r#"{"name":"X","base":"dark","tokens":{"--chevron":"url(https://x.example/a.svg)"}}"#,
            None,
        );
        assert!(t.error.unwrap().contains("--chevron"));
        let css = validate(
            "x",
            r#"{"name":"X","base":"dark"}"#,
            Some("body { background: url(http://x/y.png) }"),
        );
        assert!(css.error.unwrap().contains("x.css"));
    }

    #[test]
    fn the_scaffold_is_a_valid_theme_with_every_token() {
        for base in ["dark", "light"] {
            let json = scaffold("My theme", base);
            let t = validate("my-theme", &json, None);
            assert_eq!(t.error, None, "{json}");
            assert!(t.warnings.is_empty(), "{:?}", t.warnings);
            assert_eq!(t.base, base);
            assert_eq!(t.tokens.len(), tokens().len());
            assert_eq!(
                t.tokens["--md-primary"],
                if base == "dark" { "#bcc2ff" } else { "#4c56a8" }
            );
        }
    }

    #[test]
    fn listing_a_folder() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join("ocean.json"),
            r##"{"name":"Ocean","base":"dark","tokens":{"--fg":"#fff"}}"##,
        )
        .unwrap();
        std::fs::write(dir.path().join("ocean.css"), ".sidebar { opacity: 0.9 }").unwrap();
        std::fs::write(dir.path().join("broken.json"), "{").unwrap();
        std::fs::write(
            dir.path().join("Dark.json"),
            r#"{"name":"D","base":"dark"}"#,
        )
        .unwrap();
        std::fs::write(dir.path().join("notes.txt"), "x").unwrap();
        let list = list_dir(dir.path(), None, "user");
        let ids: Vec<&str> = list.iter().map(|t| t.id.as_str()).collect();
        assert_eq!(ids, ["Dark", "broken", "ocean"]);
        assert!(list[0].error.as_deref().unwrap().contains("not a theme id"));
        assert!(list[1].error.is_some());
        assert_eq!(list[2].error, None);
        assert_eq!(list[2].css.as_deref(), Some(".sidebar { opacity: 0.9 }"));
        let from_mod = list_dir(dir.path(), Some("my-mod"), "mod:my-mod");
        assert!(from_mod
            .iter()
            .any(|t| t.id == "my-mod:ocean" && t.source == "mod:my-mod"));
    }

    #[test]
    fn reserved_ids() {
        assert!(valid_id("ocean-2"));
        assert!(!valid_id("dark"));
        assert!(!valid_id("system"));
        assert!(!valid_id("Ocean"));
        assert!(!valid_id("a.b"));
    }
}
