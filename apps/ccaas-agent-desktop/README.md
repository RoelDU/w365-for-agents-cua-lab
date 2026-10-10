# Zava Contact Center — Agent Workspace

This is the browser app used by the human presenter. It signs in with Microsoft Entra ID, simulates a contact-centre call, and lets the presenter transfer the claim to either supported AI path:

- **Claims Automation Agent (Copilot Studio)**, through the handoff service `/api/cua-run` Dataverse trigger path.
- **Claims Automation Agent (Foundry)**, through the handoff service `/api/foundry-claims` relay path.

The app is hosted on Azure Static Web Apps for the install guide, but it can still be run locally for development.

## Install guide

Use the repository guide first: [`..\..\docs\install\README.md`](../../docs/install/README.md).

## Local development

```powershell
npm install
npm run dev
# http://localhost:5173
```

## Runtime config

Do not hard-code tenant values into source. Copy and fill these git-ignored files:

```powershell
Copy-Item .\public\region-config.sample.json .\public\region-config.json
Copy-Item .\public\entra-config.sample.json .\public\entra-config.json
```

`region-config.json` points the app to the handoff service base URL for both MCS (`cuaRunBaseUrl`) and Foundry (`orchestratorUrl`). `entra-config.json` contains the Zava SPA app registration tenant, client ID, and site-root redirect URI.

Build-time `.env.local` overrides are for local development only. The deployed app should use the runtime JSON files so an installer can change tenant settings without rebuilding.

## Useful commands

| Command | Purpose |
| --- | --- |
| `npm run dev` | Start Vite locally. |
| `npm run build` | Type-check and build. |
| `npm test` | Run app tests. |
| `npm run lint` | Run linting. |

## Related docs

- [`public\region-config.sample.json`](public/region-config.sample.json)
- [`public\entra-config.sample.json`](public/entra-config.sample.json)
- [`docs\auth.md`](docs/auth.md)
- [`docs\region-config.md`](docs/region-config.md)
- [Top-level README](../../README.md)
