# ACCESSIBILITY — Tab order and stable control IDs

This document tells a Computer Use Agent (CUA) author exactly which controls
to target and in what order. Every interactive control has a stable numeric
resource ID defined in [`src/resource.h`](src/resource.h). **IDs are
guaranteed stable across builds**; renaming would be a breaking change for
the CUA selector reference.

## Window classes

| Class            | Purpose                                                |
|------------------|--------------------------------------------------------|
| `WgmMainWindow`  | Main application window (one per process).             |
| `WgmPaneWindow`  | Tab page host (one per tab).                           |
| `#32770`         | Standard Win32 dialog (compliance, MOTD, ready gate, login, confirm, etc.) |

Main window title: `Zava Mutual — Claims Workstation v1.0`
(em-dash U+2014).

## Primary-path tab order

1. Login dialog — `IDC_LOGIN_AGENT_ID` (5200) → `IDC_LOGIN_PIN` (5201) →
   `IDC_LOGIN_WORKSTATION` (5202) → `IDC_LOGIN_BRANCH` (5203) →
   `IDC_LOGIN_CONNECT` (5204) [DEFAULT].
2. Main window after login: search radios (7000–7003) →
   `IDC_SEARCH_INPUT` (7010) → `IDC_SEARCH_BUTTON` (7011) [DEFAULT] →
   `IDC_SEARCH_CLEAR` (7012) → `IDC_SEARCH_RESULTS` (7013) → tab control
   (7100) → tab page content.
3. FNOL pane: `IDC_FNOL_NEXT` (7602) [DEFAULT, advancing] →
   `IDC_FNOL_BACK` (7601) → `IDC_FNOL_CANCEL` (7603); per-step controls
   listed below.

## Stable IDs — complete reference

### Splash / Compliance / Login

| ID                          | Value | Notes                                 |
|-----------------------------|-------|---------------------------------------|
| `IDC_SPLASH_TEXT`           | 5000  | Static                                |
| `IDC_SPLASH_PROGRESS`       | 5001  | Progress bar                          |
| `IDC_SPLASH_BUILD`          | 5002  | Build label                           |
| `IDC_SPLASH_FOOTER`         | 5003  | "Demonstration build…"                |
| `IDC_COMPLIANCE_TEXT`       | 5100  | Disclaimer body                       |
| `IDC_COMPLIANCE_AGREE`      | 5101  | **I Agree** button [DEFAULT]          |
| `IDC_LOGIN_AGENT_ID`        | 5200  | Edit                                  |
| `IDC_LOGIN_PIN`             | 5201  | Edit (ES_PASSWORD ES_NUMBER)          |
| `IDC_LOGIN_WORKSTATION`     | 5202  | Edit (ES_READONLY) — pre-filled       |
| `IDC_LOGIN_BRANCH`          | 5203  | Combobox                              |
| `IDC_LOGIN_CONNECT`         | 5204  | Button [DEFAULT]                      |
| `IDC_LOGIN_STATUS`          | 5205  | Status label                          |

### MOTD / Ready gate / About / Confirm-claim

| ID                          | Value |
|-----------------------------|-------|
| `IDC_AUTH_LIST`             | 5301  |
| `IDC_MOTD_TEXT`             | 5400  |
| `IDC_MOTD_ACK`              | 5401  |
| `IDC_READY_YES`             | 5500  |
| `IDC_READY_NO`              | 5501  |
| `IDC_READY_AUX`             | 5502  |
| `IDC_READY_QUESTION`        | 5503  |
| `IDC_IDLE_PIN`              | 5600  |
| `IDC_IDLE_RESUME`           | 5601  |
| `IDC_IDLE_SIGNOFF`          | 5602  |
| `IDC_ABOUT_TEXT`            | 5800  |
| `IDC_CONFIRM_CLAIM_ID`      | 5900  |
| `IDC_CONFIRM_COPY`          | 5901  |
| `IDC_CONFIRM_OK`            | 5902  |

### Main window

| ID                          | Value | Notes                                    |
|-----------------------------|-------|------------------------------------------|
| `IDC_SEARCH_RADIO_PHONE`    | 7000  |                                          |
| `IDC_SEARCH_RADIO_POLICY`   | 7001  |                                          |
| `IDC_SEARCH_RADIO_NAME`     | 7002  |                                          |
| `IDC_SEARCH_RADIO_CLAIM`    | 7003  |                                          |
| `IDC_SEARCH_INPUT`          | 7010  |                                          |
| `IDC_SEARCH_BUTTON`         | 7011  | Default                                  |
| `IDC_SEARCH_CLEAR`          | 7012  |                                          |
| `IDC_SEARCH_RESULTS`        | 7013  | Listview (REPORT)                        |
| `IDC_DETAIL_TABS`           | 7100  | Tab control                              |
| `IDC_STATUS_BAR`            | 7101  | Status bar                               |

### Policy tab (IDs 7200–7211)

| ID                          | Value | Notes                                    |
|-----------------------------|-------|------------------------------------------|
| `IDC_POL_NUMBER`            | 7200  | Edit (ES_READONLY)                       |
| `IDC_POL_INSURED`           | 7201  |                                          |
| `IDC_POL_PHONE`             | 7202  |                                          |
| `IDC_POL_ADDRESS`           | 7203  |                                          |
| `IDC_POL_TYPE`              | 7204  |                                          |
| `IDC_POL_EFFECTIVE`         | 7205  |                                          |
| `IDC_POL_EXPIRATION`        | 7206  |                                          |
| `IDC_POL_PREMIUM`           | 7207  |                                          |
| `IDC_POL_BILLING`           | 7208  |                                          |
| `IDC_POL_AGENT`             | 7209  |                                          |
| `IDC_POL_FOOTER`            | 7210  |                                          |
| `IDC_POL_STATUS`            | 7211  |                                          |

### Coverage tab

| ID                          | Value | Notes                                    |
|-----------------------------|-------|------------------------------------------|
| `IDC_COV_TREE`              | 7300  | TreeView                                 |
| `IDC_COV_DETAIL`            | 7302  | Edit (read-only, multiline)              |
| `IDC_COV_FOOTER`            | 7301  |                                          |

### Claims tab

| ID                          | Value | Notes                                    |
|-----------------------------|-------|------------------------------------------|
| `IDC_CLM_LIST`              | 7400  | Listview                                 |
| `IDC_CLM_FOOTER`            | 7402  |                                          |
| `IDC_CLM_REASSIGN`          | 7403  | Greyed in v1.0                           |
| `IDC_CLM_CLOSE`             | 7404  | Greyed in v1.0                           |
| `IDC_CLM_TRANSFER`          | 7406  | Greyed in v1.0                           |
| `IDC_CLM_VOID`              | 7405  | Greyed in v1.0                           |

### Notes tab

| ID                          | Value |
|-----------------------------|-------|
| `IDC_NOTES_LIST`            | 7500  |
| `IDC_NOTES_ADD`             | 7501  |
| `IDC_NOTES_FOOTER`          | 7502  |

### FNOL wizard pane (single-window, no PropertySheet)

| ID                          | Value | Notes                                    |
|-----------------------------|-------|------------------------------------------|
| `IDC_FNOL_STEPLABEL`        | 7600  | "Step N of 5 — …"                        |
| `IDC_FNOL_BACK`             | 7601  |                                          |
| `IDC_FNOL_NEXT`             | 7602  | Default                                  |
| `IDC_FNOL_CANCEL`           | 7603  |                                          |
| `IDC_FNOL_SUBMIT`           | 7604  | Only visible on Step 5                   |
| Step 1                      |       |                                          |
| `IDC_FNOL_LOSS_DATE`        | 7610  |                                          |
| `IDC_FNOL_LOSS_TIME`        | 7611  |                                          |
| `IDC_FNOL_LOSS_LOCATION`    | 7612  |                                          |
| `IDC_FNOL_LOSS_TYPE`        | 7613  | Combobox                                 |
| `IDC_FNOL_NARRATIVE`        | 7614  | Multiline edit                           |
| Step 2                      |       |                                          |
| `IDC_FNOL_VEH_LIST`         | 7620  | Listview                                 |
| `IDC_FNOL_VEH_ADD`          | 7621  |                                          |
| `IDC_FNOL_VEH_REMOVE`       | 7622  |                                          |
| Step 3                      |       |                                          |
| `IDC_FNOL_PARTY_LIST`       | 7630  | Listview                                 |
| `IDC_FNOL_PARTY_ADD`        | 7631  |                                          |
| `IDC_FNOL_PARTY_REMOVE`     | 7632  |                                          |
| Step 4                      |       |                                          |
| `IDC_FNOL_COV_LIST`         | 7640  | Listview (LVS_EX_CHECKBOXES)             |
| `IDC_FNOL_COV_DEDUCTIBLE`   | 7641  | Edit (ES_READONLY)                       |
| Step 5                      |       |                                          |
| `IDC_FNOL_REVIEW_TEXT`      | 7650  | Multiline edit (ES_READONLY)             |
| `IDC_FNOL_RESULT_LABEL`     | 7652  |                                          |
| `IDC_FNOL_RESULT_CLAIMID`   | 7651  | **Headline output** after submit         |

### Add-note / Add-vehicle / Add-party dialogs

| ID                          | Value |
|-----------------------------|-------|
| `IDC_NOTE_SEVERITY`         | 6000  |
| `IDC_NOTE_TEXT`             | 6001  |
| `IDC_VEH_YEAR`              | 6100  |
| `IDC_VEH_MAKE`              | 6101  |
| `IDC_VEH_MODEL`             | 6102  |
| `IDC_VEH_VIN`               | 6103  |
| `IDC_VEH_DAMAGE`            | 6104  |
| `IDC_PARTY_ROLE`            | 6200  |
| `IDC_PARTY_NAME`            | 6201  |
| `IDC_PARTY_PHONE`           | 6202  |
| `IDC_PARTY_ADDR`            | 6203  |

## Keyboard accelerators

| Shortcut       | Action                            |
|----------------|-----------------------------------|
| `Ctrl+F`       | Focus search input                |
| `Alt+S`        | Focus search input (alias)        |
| `Alt+N`        | New FNOL (switch to tab)          |
| `Alt+R`        | Refresh view                      |
| `F5`           | Refresh view                      |

The primary demo path is keyboard-navigable: login → search → open policy →
start FNOL → next/previous pages → submit.

## MSAA roles (default, via standard controls)

Because the app uses only standard Win32 / Common Controls and ships with no
custom UIA provider, MSAA roles fall back to the OS defaults:

| Resource type    | MSAA role               |
|------------------|-------------------------|
| `EDIT`           | `ROLE_SYSTEM_TEXT`      |
| `BUTTON`         | `ROLE_SYSTEM_PUSHBUTTON`/`ROLE_SYSTEM_RADIOBUTTON` |
| `STATIC`         | `ROLE_SYSTEM_STATICTEXT` / `ROLE_SYSTEM_GROUPING` |
| `COMBOBOX`       | `ROLE_SYSTEM_COMBOBOX`  |
| `LISTVIEW`       | `ROLE_SYSTEM_LIST` + `ROLE_SYSTEM_LISTITEM`        |
| `TREEVIEW`       | `ROLE_SYSTEM_OUTLINE` + `ROLE_SYSTEM_OUTLINEITEM`  |
| `TABCONTROL`     | `ROLE_SYSTEM_PAGETABLIST` + `ROLE_SYSTEM_PAGETAB`  |
