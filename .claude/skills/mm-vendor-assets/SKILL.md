---
name: mm-vendor-assets
description: Vendor third-party icons, fonts, or JS libraries into a MagicMirror module so the mirror works offline with no CDN dependency. Use whenever adding artwork or code you didn't write to mounts/modules — downloading the files, verifying them, recording the version, and handling licenses. Make sure to use this whenever vendoring anything, even small icon sets, rather than hand-rolling checks each time.
---

Downloaded files must be verified, versioned, and licensed — a bad download
fails silently at runtime (an error page saved as `.svg` renders as broken
content with no console error worth trusting).

## Steps

1. **Check the license first.** Only vendor assets the license allows you to
   redistribute. Copy the license text into the same folder as the assets
   (e.g. `icons/LICENSE`, `vendor/LICENSE`) and commit it alongside them —
   MIT/BSD/Apache all require the notice to travel with the files.

2. **Download and verify content, not just HTTP status.** A 200 can still be
   an error page. Check each file before committing:
   - SVG must start with `<svg`; JS must parse (`node --check`); fonts must
     have plausible sizes (a 14-byte "font" is a 404 body).
   - Reject anything that fails; never commit it "temporarily".

3. **Pin and record the version.** Note the exact upstream version in the
   commit message and in a comment where the assets are referenced
   (e.g. `pinned at v3.0.0-next.10`). No auto-updates — stale vendored
   copies are a known tradeoff, stated up front.

4. **Confirm the format fits the consumer.**
   - JS for `getScripts()` must expose a global (UMD); ESM-only builds
     won't load that way — check `dist/` and pin a line that still ships UMD.
   - SVGs used via `currentColor` can be tinted in code; baked-color SVGs
     cannot — know which you have before designing around it.
   - Sanity-check geometry: absurd viewBox dimensions mean template
     scaffolding (guides, multi-weight sheets) that must be cropped first.

5. **Keep secrets and proprietary files out.** API keys never go in vendored
   files — inject at runtime from the environment (see `mm-config` secrets).
   Anything not licensed for redistribution goes in a gitignored local-only
   folder, never in a commit.
