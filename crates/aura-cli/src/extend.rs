//! `aura mods …`, `aura themes …` and `aura guide`: what an agent needs to
//! make a mod or a theme for Aura on any machine, without this repository.

use anyhow::{bail, Context, Result};
use aura_core::themes;
use aura_rpc::client::RpcClient;
use clap::Subcommand;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};

pub const GUIDE_INDEX: &str = include_str!("../../../docs/agents/README.md");
pub const GUIDE_MODS: &str = include_str!("../../../docs/agents/creating-mods.md");
pub const GUIDE_THEMES: &str = include_str!("../../../docs/agents/creating-themes.md");

/// The mod API as one declaration file (packages/mod-sdk/gen-dts.mjs writes it).
const MOD_DTS: &str = include_str!("../../../packages/mod-sdk/types/aura-mod.d.ts");
const T_DAEMON: &str = include_str!("../templates/mod/daemon.js");
const T_UI: &str = include_str!("../templates/mod/ui.js");
const T_CSS: &str = include_str!("../templates/mod/ui.css");
const T_JSCONFIG: &str = include_str!("../templates/mod/jsconfig.json");

#[derive(Subcommand, Debug)]
pub enum ModsCmd {
    /// List installed mods and their state
    List,
    /// Make a new mod that needs no build step in <data dir>/mods/<id>
    New {
        /// Lowercase letters, digits and dashes
        id: String,
        /// Give it a UI half (ui.js, ui.css). With neither --ui nor --daemon, it gets both
        #[arg(long)]
        ui: bool,
        /// Give it a daemon half (daemon.js)
        #[arg(long)]
        daemon: bool,
        /// Display name (default: from the id)
        #[arg(long)]
        name: Option<String>,
        /// Overwrite the files of an existing mod folder
        #[arg(long)]
        force: bool,
    },
    /// Ask the open Aura window to show a mod's approval prompt. Only a click there approves it
    Approve { id: String },
    /// Turn a disabled mod back on (it starts if it is approved)
    Enable { id: String },
    /// Turn a mod off: it stops and stays off across restarts until enabled
    Disable { id: String },
    /// Re-read a mod's files and restart it
    Reload { id: String },
    /// Look for added and removed mod folders
    Rescan,
    /// Print a mod's log: its console output, errors, and its UI half's errors
    Logs {
        id: String,
        /// Keep printing new lines
        #[arg(short, long)]
        follow: bool,
    },
    /// Call a mod's daemon method (mod.<id>.<method>) and print the answer
    Call {
        id: String,
        method: String,
        /// Parameters as JSON (default {})
        params: Option<String>,
    },
}

#[derive(Subcommand, Debug)]
pub enum ThemesCmd {
    /// List the themes and whether they are valid
    List,
    /// Make a new theme in <data dir>/themes/<id>.json with every token
    New {
        /// Lowercase letters, digits and dashes
        id: String,
        /// The built-in theme it starts from
        #[arg(long, default_value = "dark", value_parser = ["dark", "light"])]
        base: String,
        /// Display name (default: from the id)
        #[arg(long)]
        name: Option<String>,
        /// Also make <id>.css for overrides tokens cannot express
        #[arg(long)]
        css: bool,
        /// Overwrite an existing theme
        #[arg(long)]
        force: bool,
    },
    /// Validate a theme (by id, or a path to its .json); exits 1 when it cannot be used
    Check { theme: String },
    /// Show a theme in Aura (dark, light, system or a theme id); kept across restarts. Exits 1 for a theme that cannot be used
    Use { id: String },
    /// Ask the open Aura window to show the approval prompt for a theme's CSS. Only a click there approves it
    Approve { id: String },
}

/// `aura guide [topic]`.
pub fn guide(topic: Option<&str>) -> Result<()> {
    let text = match topic {
        None => GUIDE_INDEX,
        Some("mods" | "mod") => GUIDE_MODS,
        Some("themes" | "theme") => GUIDE_THEMES,
        Some(other) => bail!("no guide {other:?}; there are: mods, themes"),
    };
    print!("{text}");
    Ok(())
}

/// "my-cool-mod" → "My cool mod".
fn name_from(id: &str) -> String {
    let words = id.replace('-', " ");
    let mut c = words.chars();
    match c.next() {
        Some(f) => f.to_uppercase().collect::<String>() + c.as_str(),
        None => String::new(),
    }
}

/// A display name that is safe to put inside JS strings and CSS comments.
fn check_name(name: &str) -> Result<()> {
    if name.trim().is_empty() || name.chars().count() > 60 {
        bail!("the name must be 1 to 60 characters");
    }
    if name.contains(['"', '`', '\\', '$', '\n', '\r', '<', '>']) || name.contains("*/") {
        bail!("the name may not contain quotes, backticks, backslashes, $, < or >");
    }
    Ok(())
}

/// A template with `//#if daemon` / `//#if !daemon` … `//#endif` blocks resolved.
fn render(template: &str, id: &str, name: &str, daemon: bool) -> String {
    let mut out: Vec<&str> = vec![];
    let mut keep = true;
    for line in template.lines() {
        match line.trim() {
            "//#if daemon" => keep = daemon,
            "//#if !daemon" => keep = !daemon,
            "//#endif" => keep = true,
            _ if keep => out.push(line),
            _ => {}
        }
    }
    (out.join("\n") + "\n")
        .replace("{{ID}}", id)
        .replace("{{NAME}}", name)
}

fn manifest(id: &str, name: &str, ui: bool, daemon: bool) -> String {
    let s = |v: &str| serde_json::to_string(v).unwrap_or_default();
    let mut lines = vec![
        format!("  \"id\": {}", s(id)),
        format!("  \"name\": {}", s(name)),
        "  \"version\": \"0.1.0\"".to_string(),
        "  \"apiVersion\": 1".to_string(),
        format!(
            "  \"description\": {}",
            s("What this mod does, in one line.")
        ),
        "  \"author\": \"\"".to_string(),
    ];
    if daemon {
        lines.push("  \"daemon\": \"daemon.js\"".into());
    }
    if ui {
        lines.push("  \"ui\": \"ui.js\"".into());
        lines.push("  \"styles\": \"ui.css\"".into());
    }
    lines.push("  \"permissions\": {}".into());
    if daemon {
        lines.push(
            "  \"settings\": [\n    { \"key\": \"greeting\", \"type\": \"string\", \"label\": \"Greeting\", \"default\": \"Hello\" }\n  ]"
                .into(),
        );
    }
    format!("{{\n{}\n}}\n", lines.join(",\n"))
}

/// The files of a new no-build mod, relative to its folder.
pub fn mod_files(id: &str, name: &str, ui: bool, daemon: bool) -> Vec<(&'static str, String)> {
    let mut files = vec![("mod.json", manifest(id, name, ui, daemon))];
    if daemon {
        files.push(("daemon.js", render(T_DAEMON, id, name, daemon)));
    }
    if ui {
        files.push(("ui.js", render(T_UI, id, name, daemon)));
        files.push(("ui.css", render(T_CSS, id, name, daemon)));
    }
    files.push(("jsconfig.json", T_JSCONFIG.to_string()));
    files.push(("types/aura-mod.d.ts", MOD_DTS.to_string()));
    files
}

pub fn new_mod(
    data_dir: &Path,
    id: &str,
    ui: bool,
    daemon: bool,
    name: Option<String>,
    force: bool,
) -> Result<PathBuf> {
    if !aura_core_valid_mod_id(id) {
        bail!("{id:?} is not a mod id: use lowercase letters, digits and dashes, like my-mod");
    }
    let (ui, daemon) = if !ui && !daemon {
        (true, true)
    } else {
        (ui, daemon)
    };
    let name = name.unwrap_or_else(|| name_from(id));
    check_name(&name)?;
    let dir = data_dir.join("mods").join(id);
    if dir.exists() && !force {
        bail!(
            "{} exists already; pass --force to overwrite its files",
            dir.display()
        );
    }
    for (rel, text) in mod_files(id, &name, ui, daemon) {
        let path = dir.join(rel);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .with_context(|| format!("create {}", parent.display()))?;
        }
        std::fs::write(&path, text).with_context(|| format!("write {}", path.display()))?;
    }
    Ok(dir)
}

/// The same rule as aura-mods' `valid_id` (the CLI does not link the mod host).
fn aura_core_valid_mod_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && !id.starts_with('-')
        && id
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}

const THEME_CSS: &str = "/* Optional overrides for this theme, loaded after its tokens.
   Prefer tokens: they reach mods too, and survive Aura's updates.
   Only data: URLs may appear in url(); @import and links to the web are refused.
   Example:
   .sidebar { backdrop-filter: none; }
*/
";

pub fn new_theme(
    data_dir: &Path,
    id: &str,
    base: &str,
    name: Option<String>,
    css: bool,
    force: bool,
) -> Result<PathBuf> {
    if !themes::valid_id(id) {
        bail!("{id:?} is not a theme id: use lowercase letters, digits and dashes (dark, light and system are taken)");
    }
    let name = name.unwrap_or_else(|| name_from(id));
    if name.trim().is_empty() || name.chars().count() > 80 {
        bail!("the name must be 1 to 80 characters");
    }
    let dir = data_dir.join("themes");
    std::fs::create_dir_all(&dir).with_context(|| format!("create {}", dir.display()))?;
    let path = dir.join(format!("{id}.json"));
    if path.exists() && !force {
        bail!(
            "{} exists already; pass --force to overwrite it",
            path.display()
        );
    }
    std::fs::write(&path, themes::scaffold(&name, base))
        .with_context(|| format!("write {}", path.display()))?;
    if css {
        let css_path = path.with_extension("css");
        if !css_path.exists() || force {
            std::fs::write(&css_path, THEME_CSS)?;
        }
    }
    Ok(path)
}

/// A theme by path or id: `<id>`, or `<mod id>:<name>` for a user mod's theme.
pub fn find_theme(data_dir: &Path, theme: &str) -> Result<themes::Theme> {
    if looks_like_path(theme) {
        return check_path(theme);
    }
    check_id(theme)?;
    let as_path = Path::new(theme);
    if theme.ends_with(".json") && as_path.is_file() {
        let stem = as_path
            .file_stem()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_default();
        let mut t = themes::load(as_path, &stem, "user");
        if !themes::valid_id(&stem) && t.error.is_none() {
            t.error = Some(format!("the file name {stem:?} is not a theme id: use lowercase letters, digits and dashes"));
        }
        return Ok(t);
    }
    let (dir, prefix, stem) = match theme.split_once(':') {
        Some((m, name)) => (data_dir.join("mods").join(m).join("themes"), Some(m), name),
        None => (data_dir.join("themes"), None, theme),
    };
    let path = dir.join(format!("{stem}.json"));
    if !path.is_file() {
        bail!(
            "no theme {theme}: {} does not exist (`aura themes list` shows the themes)",
            path.display()
        );
    }
    let source = prefix
        .map(|m| format!("mod:{m}"))
        .unwrap_or_else(|| "user".into());
    let id = prefix
        .map(|m| format!("{m}:{stem}"))
        .unwrap_or_else(|| stem.to_string());
    Ok(themes::load(&path, &id, &source))
}

/// Whether `aura themes check` was given a file rather than an id.
fn looks_like_path(arg: &str) -> bool {
    arg.contains('/') || arg.contains('\\') || arg.ends_with(".json")
}

/// A theme file named by path, checked on disk without the daemon.
fn check_path(arg: &str) -> Result<themes::Theme> {
    let given = Path::new(arg);
    let path = match std::fs::canonicalize(given) {
        Ok(p) => p,
        Err(_) => bail!("no such file: {arg}"),
    };
    if path.extension().is_none_or(|x| x != "json") {
        bail!("{arg} is not a theme: a theme is a .json file");
    }
    let stem = path
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_default();
    let mut t = themes::load(&path, &stem, "user");
    if !themes::valid_id(&stem) && t.error.is_none() {
        t.error = Some(format!(
            "the file name {stem:?} is not a theme id: use lowercase letters, digits and dashes (dark, light and system are taken)"
        ));
        t.tokens.clear();
        t.css = None;
    }
    Ok(t)
}

/// The same id rule discovery uses (`<mod id>:<name>` for a mod's theme).
fn check_id(id: &str) -> Result<()> {
    if themes::RESERVED_IDS.contains(&id) {
        bail!("{id} is a built-in theme, not a file; there is nothing to check");
    }
    let stem = id.split_once(':').map(|(_, n)| n).unwrap_or(id);
    if !themes::valid_id(stem) {
        bail!("{id:?} is not a theme id: use lowercase letters, digits and dashes (`aura themes list` shows the themes)");
    }
    Ok(())
}

/// `aura themes check`: a path is checked on disk; an id is looked up the way
/// Aura finds themes (through the daemon when one runs, so mods' themes and
/// CSS approval count), else on disk.
pub async fn themes_check(data_dir: &Path, theme: &str, as_json: bool) -> Result<bool> {
    let t = if looks_like_path(theme) {
        check_path(theme)?
    } else {
        check_id(theme)?;
        match RpcClient::connect_from_dir(data_dir).await {
            Ok(c) => {
                let v = c.call("themes.get", json!({"id": theme})).await?;
                serde_json::from_value::<WireTheme>(v)?.into()
            }
            Err(_) => find_theme(data_dir, theme)?,
        }
    };
    print_check(&t, as_json)
}

/// A theme as the daemon sends it.
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct WireTheme {
    id: String,
    name: String,
    #[serde(default)]
    author: Option<String>,
    base: String,
    #[serde(default)]
    tokens: std::collections::BTreeMap<String, String>,
    #[serde(default)]
    css: Option<String>,
    #[serde(default)]
    path: String,
    #[serde(default)]
    source: String,
    #[serde(default)]
    warnings: Vec<String>,
    #[serde(default)]
    error: Option<String>,
    #[serde(default)]
    approval: Option<String>,
    #[serde(default)]
    css_bytes: Option<usize>,
}

impl From<WireTheme> for themes::Theme {
    fn from(w: WireTheme) -> Self {
        themes::Theme {
            id: w.id,
            name: w.name,
            author: w.author,
            base: w.base,
            tokens: w.tokens,
            css: w.css,
            path: w.path,
            source: w.source,
            warnings: w.warnings,
            error: w.error,
            approval: w.approval,
            css_bytes: w.css_bytes,
        }
    }
}

/// Exit code 1 when the theme cannot be used.
pub fn print_check(t: &themes::Theme, as_json: bool) -> Result<bool> {
    if as_json {
        println!("{}", serde_json::to_string_pretty(t)?);
        return Ok(t.error.is_none());
    }
    match &t.error {
        Some(e) => println!("✗ {} ({}) cannot be used: {e}", t.id, t.path),
        None => println!(
            "✓ {} \"{}\": base {}, {} token{}{}",
            t.id,
            t.name,
            t.base,
            t.tokens.len(),
            if t.tokens.len() == 1 { "" } else { "s" },
            if t.css.is_some() { ", with CSS" } else { "" }
        ),
    }
    for w in &t.warnings {
        println!("  warning: {w}");
    }
    if t.approval.as_deref() == Some("needs_approval") {
        println!(
            "  its CSS ({} bytes) waits for approval in Aura: `aura themes approve {}` shows the prompt; meanwhile only its tokens apply",
            t.css_bytes.unwrap_or(0),
            t.id
        );
    }
    Ok(t.error.is_none())
}

fn print_themes(list: &[themes::Theme], dir: &str) {
    println!(
        "{:<24} {:<24} {:<6} {:<14} STATUS",
        "ID", "NAME", "BASE", "SOURCE"
    );
    for t in list {
        let status = match (&t.error, t.warnings.len()) {
            (Some(e), _) => format!("invalid: {e}"),
            (None, _) if t.approval.as_deref() == Some("needs_approval") => {
                "ok; its CSS waits for approval".into()
            }
            (None, 0) => "ok".into(),
            (None, n) => format!("ok, {n} warning{}", if n == 1 { "" } else { "s" }),
        };
        println!(
            "{:<24} {:<24} {:<6} {:<14} {status}",
            t.id,
            crate::truncate(&t.name, 24),
            t.base,
            t.source
        );
    }
    if list.is_empty() {
        println!("(no themes yet; make one with `aura themes new <id>`)");
    }
    println!("\nThemes folder: {dir}");
}

/// The commands that work without a daemon. `None` when the command needs one.
pub fn offline(data_dir: &Path, cmd: &crate::Cmd) -> Option<Result<()>> {
    use crate::Cmd;
    Some(match cmd {
        Cmd::Guide { topic } => guide(topic.as_deref()),
        Cmd::Themes {
            cmd: ThemesCmd::New { id, base, name, css, force },
        } => new_theme(data_dir, id, base, name.clone(), *css, *force).map(|path| {
            println!("Created {}", path.display());
            if *css {
                println!("        {}", path.with_extension("css").display());
            }
            println!("\nNext:");
            println!("  edit the token values (delete the ones you keep as they are)");
            println!("  aura themes check {id}    validate it");
            println!("  aura themes use {id}      show it in the open Aura windows (or Settings › General › Theme)");
            println!("Saved changes apply at once. Reference: aura guide themes");
        }),
        _ => return None,
    })
}

/// Commands that work without a daemon but use one when it runs (they never start one).
pub async fn early(data_dir: &Path, cmd: &crate::Cmd, as_json: bool) -> Option<Result<()>> {
    use crate::Cmd;
    Some(match cmd {
        Cmd::Mods {
            cmd:
                ModsCmd::New {
                    id,
                    ui,
                    daemon,
                    name,
                    force,
                },
        } => match new_mod(data_dir, id, *ui, *daemon, name.clone(), *force) {
            Err(e) => Err(e),
            Ok(dir) => {
                // A running Aura lists it now, instead of when its watcher fires.
                if let Ok(c) = RpcClient::connect_from_dir(data_dir).await {
                    let _ = c.call("mods.discover", json!({})).await;
                }
                print_new_mod(&dir, id, *ui, *daemon);
                Ok(())
            }
        },
        Cmd::Themes {
            cmd: ThemesCmd::Check { theme },
        } => match themes_check(data_dir, theme, as_json).await {
            Ok(true) => Ok(()),
            Ok(false) => std::process::exit(1),
            Err(e) => Err(e),
        },
        Cmd::Themes {
            cmd: ThemesCmd::List,
        } => themes_list(data_dir, as_json).await,
        _ => return None,
    })
}

fn print_new_mod(dir: &Path, id: &str, ui: bool, daemon: bool) {
    let mut files: Vec<String> = std::fs::read_dir(dir)
        .map(|r| {
            r.filter_map(|e| e.ok())
                .map(|e| e.file_name().to_string_lossy().to_string())
                .collect()
        })
        .unwrap_or_default();
    files.sort();
    println!("Created {}\n  {}\n", dir.display(), files.join("  "));
    println!("Next:");
    let mut steps = vec![
        (
            format!("aura mods approve {id}"),
            "Aura's window shows the approval prompt; the user clicks Approve",
        ),
        (
            format!("aura mods logs {id} -f"),
            "follow its log while you work",
        ),
    ];
    if daemon || !ui {
        steps.push((
            format!("aura mods call {id} hello '{{\"name\":\"Ada\"}}'"),
            "try the daemon half",
        ));
    }
    let width = steps.iter().map(|(c, _)| c.len()).max().unwrap_or(0);
    for (cmd, what) in steps {
        println!("  {cmd:<width$}  {what}");
    }
    println!("Aura reloads a half when you save one of its files.");
    println!(
        "Reference: aura guide mods · types: {}",
        dir.join("types/aura-mod.d.ts").display()
    );
}

/// `aura themes list`: from the daemon when one runs (it knows the mods' themes), else from disk.
pub async fn themes_list(data_dir: &Path, as_json: bool) -> Result<()> {
    let (list, dir) = match RpcClient::connect_from_dir(data_dir).await {
        Ok(c) => match c.call("themes.list", json!({})).await {
            Ok(v) => {
                let dir = v["dir"].as_str().unwrap_or_default().to_string();
                (
                    serde_json::from_value::<Vec<Value>>(v["themes"].clone()).unwrap_or_default(),
                    dir,
                )
            }
            Err(_) => local_themes(data_dir),
        },
        Err(_) => local_themes(data_dir),
    };
    if as_json {
        println!("{}", serde_json::to_string_pretty(&list)?);
        return Ok(());
    }
    let parsed: Vec<themes::Theme> = list
        .iter()
        .filter_map(|v| {
            serde_json::from_value::<WireTheme>(v.clone())
                .ok()
                .map(Into::into)
        })
        .collect();
    print_themes(&parsed, &dir);
    Ok(())
}

fn local_themes(data_dir: &Path) -> (Vec<Value>, String) {
    let dir = data_dir.join("themes");
    let list = themes::list_dir(&dir, None, "user")
        .into_iter()
        .filter_map(|t| serde_json::to_value(t).ok())
        .collect();
    (list, dir.to_string_lossy().to_string())
}

/// The commands that talk to the daemon.
pub async fn online(client: &RpcClient, cmd: crate::Cmd, as_json: bool) -> Result<()> {
    use crate::Cmd;
    match cmd {
        Cmd::Mods { cmd } => match cmd {
            ModsCmd::List => {
                let v = client.call("mods.list", json!({})).await?;
                if as_json {
                    println!("{}", serde_json::to_string_pretty(&v)?);
                    return Ok(());
                }
                println!(
                    "{:<20} {:<9} {:<8} {:<15} {:<10} DIR",
                    "ID", "VERSION", "SOURCE", "STATE", "HALVES"
                );
                for m in v.as_array().cloned().unwrap_or_default() {
                    let halves = [
                        ("ui", m["hasUi"].as_bool() == Some(true)),
                        ("daemon", m["hasDaemon"].as_bool() == Some(true)),
                    ]
                    .iter()
                    .filter(|(_, has)| *has)
                    .map(|(n, _)| *n)
                    .collect::<Vec<_>>()
                    .join("+");
                    println!(
                        "{:<20} {:<9} {:<8} {:<15} {:<10} {}",
                        m["id"].as_str().unwrap_or(""),
                        m["version"].as_str().unwrap_or("-"),
                        m["source"].as_str().unwrap_or("-"),
                        m["status"]["state"].as_str().unwrap_or(""),
                        if halves.is_empty() {
                            "-".into()
                        } else {
                            halves
                        },
                        m["dir"].as_str().unwrap_or("")
                    );
                    if let Some(e) = m["status"]["error"].as_str() {
                        println!("    error: {e}");
                    }
                    if let Some(e) = m["uiError"].as_str() {
                        println!("    ui error: {e}");
                    }
                    if let Some(e) = m["reloadError"].as_str() {
                        println!("    reload error: {e}");
                    }
                }
            }
            ModsCmd::Approve { id } => {
                client
                    .call("mods.request_approval", json!({"id": id}))
                    .await?;
                println!("Approve it in Aura: its window now shows the approval prompt for {id}, with what the mod may do.");
                println!("(If Aura is not open, the mod waits; Settings › Mods lists it.) Only a click there approves a mod.");
            }
            ModsCmd::Enable { id } => {
                client.call("mods.enable", json!({"id": id})).await?;
                print_state(client, &id).await?;
            }
            ModsCmd::Disable { id } => {
                client.call("mods.disable", json!({"id": id})).await?;
                print_state(client, &id).await?;
            }
            ModsCmd::Reload { id } => {
                let r = client.call("mods.reload", json!({"id": id})).await;
                print_state(client, &id).await?;
                r?;
            }
            ModsCmd::Rescan => {
                client.call("mods.rescan", json!({})).await?;
                println!("rescanned; `aura mods list` shows what was found");
            }
            ModsCmd::Logs { id, follow } => {
                // Followed by sequence number, so repeated lines are all shown.
                let mut after = 0u64;
                let mut first_round = true;
                loop {
                    let v = client
                        .call("mods.logs", json!({"id": id, "after": after}))
                        .await?;
                    if !first_round {
                        if let Some(first) = v["first"].as_u64() {
                            if first > after + 1 {
                                println!(
                                    "… {} lines rolled off the log before they were shown",
                                    first - after - 1
                                );
                            }
                        }
                    }
                    let lines = v["lines"].as_array().cloned().unwrap_or_default();
                    for l in &lines {
                        println!("{}", l["text"].as_str().unwrap_or(""));
                    }
                    if let Some(last) = lines
                        .last()
                        .and_then(|l| l["seq"].as_u64())
                        .or_else(|| v["last"].as_u64())
                    {
                        after = after.max(last);
                    }
                    if !follow {
                        if lines.is_empty() {
                            println!("(nothing logged yet)");
                        }
                        break;
                    }
                    first_round = false;
                    tokio::time::sleep(std::time::Duration::from_millis(700)).await;
                }
            }
            ModsCmd::Call { id, method, params } => {
                let params: Value = match params {
                    Some(p) => serde_json::from_str(&p)
                        .context("params must be JSON, like '{\"name\":\"Ada\"}'")?,
                    None => json!({}),
                };
                let v = client.call(&format!("mod.{id}.{method}"), params).await?;
                println!("{}", serde_json::to_string_pretty(&v)?);
            }
            ModsCmd::New { .. } => unreachable!("offline"),
        },
        Cmd::Themes { cmd } => match cmd {
            ThemesCmd::Use { id } => {
                client.call("themes.use", json!({"id": id})).await?;
                println!("Aura shows {id} now, in every window and after a restart.");
                if !themes::RESERVED_IDS.contains(&id.as_str()) {
                    if let Ok(t) = client.call("themes.get", json!({"id": id})).await {
                        if t["approval"] == "needs_approval" {
                            println!("Its CSS waits for approval: `aura themes approve {id}` shows the prompt in Aura; until then only its tokens apply.");
                        }
                    }
                }
            }
            ThemesCmd::Approve { id } => {
                client
                    .call("themes.request_approval", json!({"id": id}))
                    .await?;
                println!("Approve it in Aura: its window now shows the approval prompt for the CSS of {id}. Only a click there approves it.");
            }
            ThemesCmd::List | ThemesCmd::New { .. } | ThemesCmd::Check { .. } => {
                unreachable!("handled before")
            }
        },
        _ => unreachable!(),
    }
    Ok(())
}

async fn print_state(client: &RpcClient, id: &str) -> Result<()> {
    let v = client.call("mods.list", json!({})).await?;
    let m = v
        .as_array()
        .and_then(|a| a.iter().find(|m| m["id"] == id).cloned())
        .with_context(|| format!("no mod {id}; `aura mods list` shows the installed ones"))?;
    print!("{id}: {}", m["status"]["state"].as_str().unwrap_or("?"));
    if let Some(e) = m["status"]["error"].as_str() {
        print!(" ({e})");
    }
    println!();
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn templates_resolve_their_daemon_blocks() {
        let both = render(T_UI, "hi", "Hi", true);
        assert!(both.contains("ctx.rpc(\"hello\""));
        assert!(!both.contains("//#if"));
        assert!(!both.contains("{{ID}}") && !both.contains("{{NAME}}"));
        let ui_only = render(T_UI, "hi", "Hi", false);
        assert!(
            !ui_only.contains("ctx.rpc("),
            "a UI-only mod has no daemon half to call"
        );
        assert!(ui_only.contains("Hello from Hi"));
    }

    #[test]
    fn a_new_mod_is_a_valid_mod() {
        let tmp = tempfile::tempdir().unwrap();
        for (id, ui, daemon) in [
            ("both", false, false),
            ("only-ui", true, false),
            ("only-daemon", false, true),
        ] {
            let dir = new_mod(tmp.path(), id, ui, daemon, None, false).unwrap();
            let m: Value =
                serde_json::from_str(&std::fs::read_to_string(dir.join("mod.json")).unwrap())
                    .unwrap();
            assert_eq!(m["id"], id);
            assert_eq!(m["apiVersion"], 1);
            for entry in ["daemon", "ui", "styles"] {
                if let Some(rel) = m[entry].as_str() {
                    assert!(dir.join(rel).is_file(), "{id}: {rel}");
                }
            }
            assert_eq!(m["daemon"].is_string(), id != "only-ui");
            assert_eq!(m["ui"].is_string(), id != "only-daemon");
            assert!(dir.join("types/aura-mod.d.ts").is_file());
            assert!(dir.join("jsconfig.json").is_file());
        }
        assert!(
            new_mod(tmp.path(), "both", false, false, None, false).is_err(),
            "no silent overwrite"
        );
        assert!(new_mod(tmp.path(), "both", false, false, None, true).is_ok());
        assert!(new_mod(tmp.path(), "Bad", false, false, None, false).is_err());
        assert!(new_mod(tmp.path(), "x", false, false, Some("a\"b".into()), false).is_err());
    }

    /// The scaffold loads in a real mod host: approval first, then its RPC answers and its UI is served.
    #[tokio::test]
    async fn a_new_mod_runs_in_the_mod_host() {
        let tmp = tempfile::tempdir().unwrap();
        new_mod(tmp.path(), "hello-test", false, false, None, false).unwrap();
        let store: std::sync::Arc<dyn aura_core::Store> =
            std::sync::Arc::new(aura_core::MemoryStore::default());
        let manager = aura_core::Manager::new(store.clone(), vec![], None);
        let (tx, _rx) = tokio::sync::broadcast::channel(64);
        let host = aura_mods::ModHost::start(
            aura_mods::Config {
                dirs: vec![(aura_mods::ModSource::User, tmp.path().join("mods"))],
                data_dir: tmp.path().to_path_buf(),
            },
            manager,
            store,
            tx,
        )
        .await;
        let call = |m: &'static str, p: Value| {
            let host = host.clone();
            // As Aura's window, the only caller that may approve.
            async move { host.handle_as(m, &p, None, true).await.map(|v| v.unwrap()) }
        };
        let list = call("mods.list", json!({})).await.unwrap();
        assert_eq!(list[0]["status"]["state"], "needs_approval", "{list}");
        call("mods.approve", json!({"id": "hello-test"}))
            .await
            .unwrap();
        let list = call("mods.list", json!({})).await.unwrap();
        assert_eq!(list[0]["status"]["state"], "running", "{list}");
        let r = call("mod.hello-test.hello", json!({"name": "Ada"}))
            .await
            .unwrap();
        assert_eq!(r["message"], "Hello, Ada! (call 1)");
        assert_eq!(
            call("mod.hello-test.count", json!({})).await.unwrap(),
            json!(1)
        );
        let ui = call("mods.ui_source", json!({"id": "hello-test"}))
            .await
            .unwrap();
        assert!(ui["js"]
            .as_str()
            .unwrap()
            .contains("export default function activate(ctx)"));
        assert!(ui["css"].as_str().unwrap().contains(".mod-hello-test-body"));
        let logs = call("mods.logs", json!({"id": "hello-test"}))
            .await
            .unwrap();
        assert!(
            logs[0]
                .as_str()
                .unwrap()
                .contains("hello-test 0.1.0 started"),
            "{logs}"
        );
        host.shutdown().await;
    }

    #[test]
    fn a_new_theme_passes_its_own_check() {
        let tmp = tempfile::tempdir().unwrap();
        for base in ["dark", "light"] {
            let id = format!("my-{base}");
            new_theme(tmp.path(), &id, base, None, true, false).unwrap();
            let t = find_theme(tmp.path(), &id).unwrap();
            assert_eq!(t.error, None);
            assert!(t.warnings.is_empty(), "{:?}", t.warnings);
            assert_eq!(t.base, base);
            assert_eq!(t.name, format!("My {base}"));
            assert_eq!(t.tokens.len(), themes::tokens().len());
            assert!(t.css.is_some(), "the CSS stub is valid and kept");
        }
        assert!(new_theme(tmp.path(), "my-dark", "dark", None, false, false).is_err());
        assert!(new_theme(tmp.path(), "dark", "dark", None, false, false).is_err());
        let by_path = find_theme(
            tmp.path(),
            &tmp.path().join("themes/my-dark.json").to_string_lossy(),
        )
        .unwrap();
        assert_eq!(by_path.id, "my-dark");
        assert!(find_theme(tmp.path(), "nope").is_err());
    }

    #[test]
    fn theme_check_resolves_paths_and_ids_like_aura() {
        let err = find_theme(Path::new("/tmp"), "./nope.json")
            .unwrap_err()
            .to_string();
        assert_eq!(
            err, "no such file: ./nope.json",
            "a clean message, no mangled path"
        );
        let err = find_theme(Path::new("/tmp"), "dark")
            .unwrap_err()
            .to_string();
        assert!(err.contains("built-in theme"), "{err}");
        let err = find_theme(Path::new("/tmp"), "Bad Id")
            .unwrap_err()
            .to_string();
        assert!(err.contains("not a theme id"), "{err}");
        // A file named like a reserved id is not a theme Aura would list.
        let tmp = tempfile::tempdir().unwrap();
        let p = tmp.path().join("dark.json");
        std::fs::write(&p, r#"{"name":"D","base":"dark"}"#).unwrap();
        let t = find_theme(tmp.path(), &p.to_string_lossy()).unwrap();
        assert!(t.error.unwrap().contains("not a theme id"));
        // Relative paths resolve against the working folder.
        let cwd = std::env::current_dir().unwrap();
        std::fs::write(
            tmp.path().join("rel.json"),
            r#"{"name":"R","base":"light"}"#,
        )
        .unwrap();
        std::env::set_current_dir(tmp.path()).unwrap();
        let t = find_theme(tmp.path(), "./rel.json");
        std::env::set_current_dir(cwd).unwrap();
        assert_eq!(t.unwrap().error, None);
    }

    #[test]
    fn guides_are_embedded() {
        assert!(GUIDE_MODS.contains("aura mods new"));
        assert!(GUIDE_THEMES.contains(themes::REFERENCE_START));
        assert!(GUIDE_INDEX.contains("aura guide mods"));
    }
}
