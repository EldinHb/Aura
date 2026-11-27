#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // A copy of this executable runs the Windows installer for an update
    // (see update_helper); it never starts the app.
    if let Some(code) = aura_desktop_lib::update_helper::run_if_requested() {
        std::process::exit(code);
    }
    aura_desktop_lib::run()
}
