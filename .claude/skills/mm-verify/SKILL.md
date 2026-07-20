---
name: mm-verify
description: Restart the MagicMirror container and check its logs for startup errors after editing config.js or a module. Use after any change to mounts/config or mounts/modules, since MagicMirror does not hot-reload.
---

MagicMirror does not pick up changes to `config.js` or module files without a
restart. Use this after any edit under `mounts/config/` or `mounts/modules/`.

## Steps

1. Restart the container:
   ```
   docker compose restart magicmirror
   ```
   If the change added/removed a volume mount in `docker-compose.yml` itself
   (e.g. a new module), use `docker compose up -d` instead — `restart` alone
   won't pick up compose file changes.

2. Give it a moment to boot, then check the logs:
   ```
   sleep 6 && docker compose logs --tail=50 magicmirror
   ```

3. Look specifically for:
   - `[ERROR]` lines
   - "Checking config file ... " followed by anything other than "doesn't
     contain syntax errors"
   - "Checking modules structure configuration ..." followed by anything
     other than "doesn't contain errors"
   - Any module helper failing to load (`Module helper loaded: <name>` should
     appear for every custom module, including MMM-WindCompass)

4. Report clearly:
   - **Pass**: config parsed cleanly, all module helpers loaded, no
     `[ERROR]` lines — safe to check `http://localhost:8080` visually.
   - **Fail**: quote the specific error line(s) verbatim, don't just say
     "there were errors."

Do not skip step 3 — a container can restart "successfully" (exit code 0,
`docker compose restart` reports no failure) while the actual MagicMirror
process inside it failed to parse config or load a module, which only shows
up in the logs.
