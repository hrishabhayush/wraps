# Wraps website

Static HTML, CSS, and JavaScript. Serve this directory with any static host; no build step or dependencies are needed.

Local preview from the repository root:

```sh
python3 -m http.server 4173 --bind 127.0.0.1 --directory website
```

Open http://127.0.0.1:4173.

The hero uses the original four desktop scenes from the Wraps Figma file. It crossfades every second on a four-second loop, pauses when the tab is hidden, and starts paused for reduced-motion users. The preview button pauses or resumes playback. If JavaScript or an image fails, the connected screen remains a static fallback.

The demo buttons link to the demo's GitHub instructions until a public demo URL is available. The app and documentation links point to their directories on main.

Fonts are served locally; their licenses are in `assets/fonts/`. App screenshots are interface concepts with illustrative rates. The page preserves the prototype and VPN integration status from the approved design.

The public IP checker lives at `ip-check/`. It queries IPinfo directly from the visitor’s browser, stores only their chosen baseline IP in local storage, and does not require an API key. An IP change is a comparison aid, not proof of VPN routing or leak protection.

Production is served by GitHub Pages from the root of `gh-pages`. Publish the contents of `website/` to that branch; the website source remains on `website`.
