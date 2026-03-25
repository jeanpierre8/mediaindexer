// src-tauri/src/main.rs
// Lance le backend Python (backend.py) au démarrage de l'app Tauri
// et l'arrête proprement à la fermeture.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::process::{Child, Command};
use std::sync::Mutex;
use tauri::Manager;

struct BackendProcess(Mutex<Option<Child>>);

fn main() {
    tauri::Builder::default()
        .manage(BackendProcess(Mutex::new(None)))
        .setup(|app| {
            // Lance backend.py au démarrage
            let resource_path = app.path_resolver()
                .resolve_resource("../backend.py")
                .expect("backend.py introuvable");

            let child = Command::new("pythonw")
                .arg(resource_path)
                .spawn()
                .expect("Impossible de lancer backend.py");

            *app.state::<BackendProcess>().0.lock().unwrap() = Some(child);
            Ok(())
        })
        .on_window_event(|event| {
            if let tauri::WindowEvent::Destroyed = event.event() {
                // Arrête le backend Python à la fermeture
                if let Ok(mut guard) = event.window().app_handle()
                    .state::<BackendProcess>().0.lock()
                {
                    if let Some(mut child) = guard.take() {
                        let _ = child.kill();
                    }
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("Erreur Tauri");
}
