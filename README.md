# SplitPDF

Split a big scanned PDF into separate, renamed files. Runs entirely in the browser: your PDF is never uploaded.

## For the person using it

1. Open the app address in **Microsoft Edge**.
2. Click **Install as app** (top right) or Edge menu > Apps > Install this site as an app. It then lives on the desktop and Start menu and works offline.
3. Drag the scanned PDF onto the window (from an Outlook email or File Explorer), or press **Open PDF**.
4. Click through the pages. At the last page of each document press **Split after this page** (or press Enter).
5. Type a name for each document in the right-hand panel.
6. Press **Save all**, choose a folder. Done. The original PDF is never changed, and existing files are never overwritten.

Shortcuts: Enter = split after this page, arrow keys = change page, Ctrl+Z = undo.

## For the person maintaining it

Plain static site, no build step. Edit files, push to `main`, and GitHub Pages publishes them.

| File | Purpose |
|---|---|
| `index.html`, `style.css` | The single screen and warm dark theme |
| `app.js` | UI, preview, split marks, saving |
| `core.js` | Pure logic (page ranges, file name cleaning, PDF page copying) |
| `sw.js`, `manifest.webmanifest` | Offline use and installability |
| `vendor/` | pdf.js (preview) and pdf-lib (splitting), bundled so nothing loads from the internet |

Pages are copied into new files without recompressing, so image quality and file size are preserved.

Requires Microsoft Edge or Google Chrome (they can save straight to a chosen folder).
