# Runtime CUA region selection

The **Transfer to AI Agent** button opens a browser-direct Direct Line
conversation to a Copilot Studio "Computer Use" agent and streams the live
agent desktop into the workspace. That agent drives a **Windows 365 Cloud PC**
which runs in the geography of the agent's **Power Platform environment**.

Different deployers want different regions (a US team wants a US Cloud PC; an
APJ team wants Australia). So the region is resolved at **runtime** — it is not
baked into the JavaScript bundle — and can be switched with **no rebuild**.

## Where the region comes from

Resolution order, lowest to highest precedence:

1. **Build-time fallback** — `VITE_DIRECTLINE_TOKEN_URL` (optional). Lets a
   single-region build work even with no config file.
2. **Served `/region-config.json`** — the install/deploy-time region set and
   the default `activeRegion`. This is the recommended mechanism.
3. **`?region=<id>` URL override** — a per-session switch for demos/testing.

The resolved Direct Line token URL is held in the settings store
(`directLineTokenUrl`) and read by the Transfer button. A user's choice in
**Settings → CUA region** is persisted and re-validated against the served
config on the next load.

## `public/region-config.json`

```json
{
  "activeRegion": "au",
  "regions": [
    {
      "id": "au",
      "label": "Australia East",
      "directLineTokenUrl": "https://<au-env-host>/powervirtualagents/botsbyschema/<schema>/directline/token?api-version=2022-03-01-preview",
      "orchestratorUrl": "https://<your-handoff-func>.azurewebsites.net/api"
    },
    {
      "id": "us",
      "label": "US Central",
      "directLineTokenUrl": "https://<us-env-host>/powervirtualagents/botsbyschema/<schema>/directline/token?api-version=2022-03-01-preview"
    }
  ]
}
```

| Field | Required | Notes |
| --- | --- | --- |
| `id` | yes | Stable id used in config, the `?region=` param, and persisted selection. |
| `label` | no | Shown in the Settings picker (defaults to `id`). |
| `directLineTokenUrl` | yes | The agent's per-environment Direct Line token endpoint. |
| `orchestratorUrl` | no | Optional per-region handoff API base; falls back to the app default. |

Malformed entries (missing `id` or `directLineTokenUrl`) are dropped. If
`activeRegion` does not match any region, the first region is used.

## Finding a region's Direct Line token URL

In **Copilot Studio**, open the agent → **Channels** → **Web app**. The embed
code contains `.../bots/<schema>/webchat...`; the matching token endpoint is:

```
https://<env-host>/powervirtualagents/botsbyschema/<schema>/directline/token?api-version=2022-03-01-preview
```

`<env-host>` and `<schema>` are environment-specific — the schema prefix differs
per environment (e.g. `crcce_…` vs `cr492_…`), so copy them from that
environment's Web app channel rather than reusing another region's value.

## Switching regions

- **Change the default (no rebuild):** edit `activeRegion` in the deployed
  `/region-config.json` and redeploy just that file.
- **Per session:** append `?region=us` to the URL.
- **In the app:** **Settings → CUA region**.

## Adding a new region

When Computer Use becomes available in another geography, create the agent +
Cloud PC pool there, then add a `{ id, label, directLineTokenUrl }` entry to
`region-config.json`. No code change or rebuild is required.
