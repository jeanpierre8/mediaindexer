Fichiers préparés pour l'updater Tauri v1.

À faire avant le prochain build/release :
1. Générer la clé updater :
   npm run tauri signer generate -- -w $HOME/.tauri/media-indexer.key
2. Coller la clé publique dans src-tauri/tauri.conf.json (champ tauri.updater.pubkey)
3. Créer les secrets GitHub Actions :
   - TAURI_PRIVATE_KEY
   - TAURI_KEY_PASSWORD
4. Bumper la version dans src-tauri/tauri.conf.json et src-tauri/Cargo.toml
5. Pousser un tag Git, par ex. :
   git tag v1.0.2
   git push origin v1.0.2
