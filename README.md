# MS GSM WAV Support for Gmail and Google Drive

This extension targets Gmail and Google Drive specifically. It intercepts Google-hosted audio attachment and preview requests, sniffs the returned bytes for RIFF/WAV data, decodes `WAVE_FORMAT_GSM610` (`0x0031`) to PCM WAV, and feeds the page a browser-playable result before the native media stack rejects the file.

## Scope

- Injects only on `mail.google.com` and `drive.google.com`.
- Probes actual response bytes instead of relying on `.wav` filenames.
- Intercepts:
  - `audio.src` and `source.src`
  - `new Audio(url)`
  - Google page `fetch(...)`
  - Google page `XMLHttpRequest`

## Build

- `.\build-chrome.ps1`
- `.\build-firefox.ps1`

Then load:

- Chrome: `dist/chrome`
- Firefox: `dist/firefox/manifest.json`
