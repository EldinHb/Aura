# Extending Aura: guides for coding agents

Aura is a desktop app that runs coding agents. A user can extend it in two
ways, and you can do both for them from a terminal, on any machine where Aura
is installed, without Aura's source code and without rebuilding anything:

| You want to | Make a | Start with | Full guide |
| --- | --- | --- | --- |
| Add a feature: a sidebar panel, an inspector section, a command, a background job, a tool for orchestrators | **mod** | `aura mods new <id>` | `aura guide mods` |
| Change how Aura looks: colours, fonts, spacing, corner radii | **theme** | `aura themes new <id>` | `aura guide themes` |

Both live in Aura's data folder (`~/.aura` unless `AURA_DATA_DIR` says
otherwise) and take effect while Aura runs: save a file and Aura reloads it.

The `aura` command ships inside the app. If `aura` is not on `PATH`, call it
by its full path:

| OS | Where `aura` is |
| --- | --- |
| macOS | `/Applications/Aura.app/Contents/MacOS/aura` |
| Windows | `aura.exe` next to `Aura.exe` in the install folder (by default `%LOCALAPPDATA%\Aura`) |
| Linux (.deb) | `/usr/bin/aura` |
| Linux (AppImage) | inside the image only; ask the user to install the .deb, or work with the files directly (every step below that edits files works without `aura`) |

Commands at a glance:

```
aura guide mods                 how to write a mod (read this before writing one)
aura guide themes               how to write a theme, with every token
aura mods new <id>              scaffold a mod that needs no build step
aura mods list                  installed mods and their state
aura mods approve <id>          show a mod's approval prompt in Aura (only the user's click approves)
aura mods enable|disable <id>   turn a mod on or off (off stays off across restarts)
aura mods logs <id> -f          follow a mod's log (console output and errors)
aura mods call <id> <method>    call a mod's daemon method
aura themes new <id>            scaffold a theme with every token
aura themes check <id>          validate a theme
aura themes use <id>            show a theme in Aura, kept across restarts
aura themes approve <id>        show the approval prompt for a theme's CSS
```
