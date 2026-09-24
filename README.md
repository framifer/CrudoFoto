# CrudoFoto — Descrizione dell'app (per sviluppatori e AI)

## Cos'è
CrudoFoto è una **fotocamera con effetti in tempo reale** in stile vintage.
Mostra l'anteprima della fotocamera dentro un guscio grafico che ricorda una
vecchia macchina fotografica e applica in diretta filtri che emulano pellicole
e fotocamere storiche. Permette di scattare foto e registrare video con
l'effetto già applicato.

Esistono due implementazioni parallele:
1. **App Android nativa** (Kotlin) — la versione principale, con effetti WebGL/OpenGL ES.
2. **PWA offline** (questa cartella) — versione web installabile, effetti in WebGL.

Questa cartella contiene la **PWA**.

## File della PWA
- `index.html` — struttura e stile (CSS) dell'interfaccia "corpo macchina".
- `app.js` — logica: accesso fotocamera (`getUserMedia`), rendering WebGL con
  gli shader degli effetti, selezione focale (crop/zoom), scatto foto (download
  PNG), registrazione video (`MediaRecorder` → WebM), suono click sintetico.
- `manifest.webmanifest` — metadati PWA (nome, icone, colori, display standalone).
- `sw.js` — service worker (cache-first) per il funzionamento **offline**.
- `icon-192.png`, `icon-512.png` — icone pixel-art (macchina fotografica).

## Come si esegue
La PWA richiede di essere servita via **HTTPS** (o `localhost`) perché
`getUserMedia` e i service worker non funzionano su `file://`.
Esempio: `python3 -m http.server 8080` e aprire `http://localhost:8080`.
Su telefono, aprire l'URL e "Aggiungi a schermata Home" per installarla.

## Funzioni (feature) attuali
- **13 effetti**, nell'ordine: Nativa (nessun filtro), Liquid Neon, Dream,
  Glitch, Kodachrome, Portra, Gold 200, Velvia, CineStill (con halation),
  Superia, Lomography, CanonPS, Iphone (2007).
- **5 lunghezze focali**: Nativa, 30, 35, 50, 85 mm (simulate con crop centrale;
  fattori di zoom in `FOCALS` dentro `app.js`).
- **Slider intensità** (0–100%): miscela l'effetto con l'immagine originale.
- **Griglia dei terzi** attivabile.
- **Suono di click** dell'otturatore (sintetico, attivabile/disattivabile).
- **Scatto foto** (PNG) e **registrazione video** (WebM).
- **Formato/anteprima** dentro un mirino incorniciato; display LCD con la focale.

## Architettura degli effetti
Ogni effetto è un **fragment shader GLSL ES 2.0**, definito nell'array
`EFFECTS` in `app.js` come stringa `body` che calcola una `vec3 col`. Il codice
comune (`HEAD`) fornisce `uTex` (frame fotocamera), `uTime`, `uIntensity`,
`vTex` e utility (`luma`, `rand`). Il risultato viene miscelato con l'originale
in base a `uIntensity`. Il **vertex shader** (`VERT`) applica lo zoom della
focale con un crop centrale delle coordinate texture.

Per **aggiungere un effetto**: inserire un nuovo oggetto `{ name, body }` in
`EFFECTS`; l'elenco dei pulsanti si genera automaticamente.

## Differenze note tra PWA e app Android
- **Flash/torcia**: sul web l'accensione della torcia hardware non è supportata
  in modo affidabile; nell'app Android sì (CameraX `enableTorch`), con lampo di
  ~2s per la foto e torcia continua durante il video.
- **Audio nel video**: la PWA registra solo video (il canvas); l'app Android
  registra anche l'audio del microfono (MediaCodec AAC + muxer).
- **Salvataggio**: la PWA scarica i file; l'app Android salva in galleria
  (MediaStore, cartelle Pictures/CrudoFoto e Movies/CrudoFoto).

## Vincoli e note importanti
- I suoni e le grafiche sono **originali**: NON usare asset (audio/immagini) di
  app di terze parti o materiale protetto da copyright.
- Le emulazioni di pellicola sono **interpretazioni artistiche** basate sulle
  caratteristiche note di ciascuna pellicola/fotocamera, non profili colore
  ufficiali.

## Idee di estensione
- Salvataggio foto nella galleria via File System Access API (dove supportata).
- Persistenza delle impostazioni (localStorage).
- Timer di autoscatto; livella; istogramma.
- Ulteriori effetti pellicola (aggiungere a `EFFECTS`).
