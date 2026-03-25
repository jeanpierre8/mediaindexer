# Media Indexer — Guide d'installation Tauri

## Structure du projet

```
mediaindexer/
├── src/                    ← Interface web (HTML/CSS/JS)
│   ├── index.html
│   ├── style.css
│   └── main.js
├── src-tauri/              ← Config Tauri + Rust
│   ├── src/main.rs
│   ├── Cargo.toml
│   └── tauri.conf.json
├── backend.py              ← API Python (FastAPI)
└── package.json
```

---

## Étape 1 — Prérequis (une seule fois)

### Python + libs
```
pip install fastapi uvicorn watchdog pdfplumber requests pillow openpyxl
```

### Node.js
Télécharge et installe : https://nodejs.org (version LTS)

### Rust
```
# Ouvre PowerShell et lance :
winget install Rustlang.Rustup
# Puis :
rustup update
```

### Tauri CLI
```
npm install -g @tauri-apps/cli
```

---

## Étape 2 — Tester le backend seul

Avant de compiler, teste que le backend fonctionne :

```
cd C:\mediaindexer
python backend.py
```

Ouvre http://localhost:8765/status dans ton navigateur.
Tu dois voir : `{"message":"Prêt.","nouveau_fichier":false,"nouveau_disque":null}`

---

## Étape 3 — Tester l'UI seul

Avec le backend qui tourne, ouvre simplement `src/index.html` dans Chrome.
L'interface doit s'afficher et se connecter au backend.

---

## Étape 4 — Installer les dépendances Node

```
cd C:\mediaindexer
npm install
```

---

## Étape 5 — Mode développement (fenêtre live)

```
npm run dev
# ou :
npx tauri dev
```

Cela ouvre une vraie fenêtre desktop avec rechargement automatique.

---

## Étape 6 — Compiler le .exe final

```
npm run build
# ou :
npx tauri build
```

Le .exe se trouve dans :
```
src-tauri\target\release\media-indexer.exe
```

L'installeur Windows (.msi) est dans :
```
src-tauri\target\release\bundle\msi\
```

---

## Démarrage automatique avec Windows

Place un raccourci vers `media-indexer.exe` dans :
```
C:\Users\TonNom\AppData\Roaming\Microsoft\Windows\Start Menu\Programs\Startup
```

Ou via le Planificateur de tâches Windows pour un contrôle plus fin.

---

## Problèmes courants

**"pythonw introuvable" au lancement**
→ Dans `src-tauri/src/main.rs`, remplace `"pythonw"` par le chemin complet :
```rust
Command::new("C:\\Users\\Jean-Pierre\\AppData\\Local\\Programs\\Python\\Python312\\pythonw.exe")
```

**Port 8765 déjà utilisé**
→ Change `PORT = 8765` dans `backend.py` et `"http://localhost:8765/**"` dans `tauri.conf.json` et `src/main.js`

**Erreur Rust à la compilation**
→ Lance `rustup update` et réessaie.
