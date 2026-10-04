# My Debt Tracker 🎀

Personal debt tracker PWA with Supabase cloud sync.

## Folders
| Path | What it is |
|---|---|
| `pwa/` | The app Netlify serves: `index.html`, `config.js`, `mdt-sync.js`, `sw.js`, `manifest.json`, `icons/` |
| `supabase/migrations/` | Database schema (already applied to the Debt Tracker Supabase project — do not re-run unless setting up a new project) |
| `supabase/PLAN.md`, `supabase/TESTING.md` | Schema plan and manual test checklist |
| `scripts/write-config.mjs` | Optional: writes `pwa/config.js` from env vars at deploy |
| `netlify.toml` | Tells Netlify to publish `pwa/` |

## Deploy
Netlify → Add new site → Import from GitHub → this repo. `netlify.toml` sets the publish folder to `pwa`; no build command or env vars are required.

## Tests
Open the deployed app with `?test=1` and check the browser console (calculation, sync mapping and sync scenario tests).

## Security
`pwa/config.js` contains only the Supabase **publishable** key. Never commit a secret or service-role key.
