Remplace le fichier suivant dans ton projet Tauri :
src-tauri/icons/icon.ico

Puis relance avec un vrai rebuild natif :
- ferme complètement l'app
- relance `tauri dev`
- si l'icône Google reste dans Windows, fais un rebuild/bundle

Le tauri.conf.json pointe déjà vers :
icons/icon.ico
