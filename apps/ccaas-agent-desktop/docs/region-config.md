# Runtime region and handoff endpoint selection

The Zava app reads `public/region-config.json` at runtime. This lets an installer point the same build at their own handoff service and Copilot Studio environment without editing source code.

## Resolution order

1. Build-time fallback values from `.env.local`.
2. Served `/region-config.json`.
3. URL overrides such as `?region=<id>` or `?cuaRunBaseUrl=<url>` for a test session.

## Example

```json
{
  "activeRegion": "primary",
  "regions": [
    {
      "id": "primary",
      "label": "Primary",
      "cuaRunBaseUrl": "https://<function-app>.azurewebsites.net/api",
      "orchestratorUrl": "https://<function-app>.azurewebsites.net/api",
      "directLineTokenUrl": "https://<env-host>.environment.api.powerplatform.com/powervirtualagents/botsbyschema/<schema>/directline/token?api-version=2022-03-01-preview"
    }
  ]
}
```

| Field | Required | Notes |
| --- | --- | --- |
| `id` | yes | Stable region key. Must match the Function app `CUA_REGION` for MCS runs. |
| `label` | yes | Human label in the app. |
| `cuaRunBaseUrl` | yes for MCS | Function `/api` base for `/api/cua-run`. |
| `orchestratorUrl` | yes for Foundry | Function `/api` base for `/api/foundry-claims`. |
| `directLineTokenUrl` | optional | Kept for in-app stream compatibility. It is not the supported MCS trigger path. |

If only one region is available, include only one region. Do not add extra labels that point to the same service; that makes troubleshooting harder.

## Related setup

The ordered install guide explains how to create the Function app settings and the matching Zava config: [`..\..\..\docs\install\07-handoff-and-zava.md`](../../../docs/install/07-handoff-and-zava.md).
