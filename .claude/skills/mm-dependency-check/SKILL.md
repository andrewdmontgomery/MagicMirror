---
name: mm-dependency-check
description: Audit which modules depend on a MagicMirror module before removing, disabling, or changing what it broadcasts. Use before deleting any entry from mounts/config/config.js (especially positionless or hiddenOnStartup ones — invisible does not mean inert), before renaming a module, and before changing a notification name or payload shape. Skipping this silently breaks consumers with no container-log error.
---

A module with no `position` still runs its `node_helper` and still
broadcasts notifications — e.g. a positionless hourly-forecast instance was
a rain-watcher's only data feed, and deleting it left the rain map
permanently hidden with zero errors in `docker compose logs`.

## Steps

1. Find every reference to the module by name (covers `targetModule`-style
   config wiring and `MM.getModules()` lookups):
   ```
   grep -r "<ModuleName>" mounts/config mounts/modules
   ```

2. Map its notification traffic. In the module's own files, list what it
   sends (`sendNotification(`, `sendSocketNotification(`) and what it
   handles (`notificationReceived(`, `socketNotificationReceived(`). Then
   find the other ends:
   ```
   grep -rn "sendNotification\|notificationReceived" mounts/modules/<Name>/
   grep -rln "<NOTIFICATION_NAME>" mounts/modules/
   ```
   Do both directions: who consumes what this module sends, and who
   produces what this module consumes.

3. Check `config.js` for entries that only make sense with this module
   present (watchers, targets, `hiddenOnStartup` modules that something
   must unhide).

4. Report clearly, before making the change:
   - **Producers lost**: notifications that will stop being sent, and
     which consumers go silent (name each consumer and what the user
     will see — e.g. "rain map stays hidden").
   - **Replacement feed**: whether another instance broadcasts a
     compatible payload (same notification name *and* the fields the
     consumer actually reads — e.g. a rain-watcher needing a non-empty
     `hourlyArray` with `precipitationProbability`/`precipitationAmount`,
     which current/forecast instances don't carry).
   - **Safe to remove**: only if no consumers exist, or the consumer is
     being removed/rewired in the same change.

Do not rely on container logs to catch a missed dependency — frontend
notification traffic (`Log.log`, `notificationReceived`) only appears in
the browser console, so a severed feed restarts cleanly and fails silently.
