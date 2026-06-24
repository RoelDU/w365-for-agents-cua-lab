# KNOWLEDGE — Zava Mutual Claims Workstation

Reference data for the AI agent. **Upload as a Knowledge file**; do not paste
into Instructions. The agent retrieves from this on demand.

## Hero records

| Customer       | Phone            | Policy            | Type | Hero scenario             |
|----------------|------------------|-------------------|------|---------------------------|
| Jordan Smith   | (555) 123-4567   | POL-2024-008341   | AUTO | Rear-end collision        |
| Morgan Lee     | (555) 222-0198   | POL-2024-002210   | HOME | Burst supply-line water   |
| Dakota Quinn   | (555) 777-1212   | POL-2024-000777   | AUTO | Three round-dollar fraud  |

`Dakota Quinn` is the fraud-pattern subject — three liability claims
(`CLM-2024-007001..007003`) at suspiciously round `$5,000.00` reserves.

## Policy ID format

`POL-YYYY-NNNNNN` (regex: `^POL-\d{4}-\d{6}$`).
Premiums shown like `$1,284.00`. Effective/expiration use `MM/DD/YYYY`.

## Claim ID format

`CLM-YYYY-NNNNNN` (regex: `^CLM-\d{4}-\d{6}$`). On submit the app assigns the
next sequential ID for the current year.

## Status codes (status-bar / claim list)

| Code        | Meaning                                          |
|-------------|--------------------------------------------------|
| `OPEN-ASGN` | Open, adjuster assigned                          |
| `PEND-REVW` | Pending review (SIU or coverage)                 |
| `CLSD-PAID` | Closed — paid in full                            |
| `CLSD-DEN`  | Closed — denied                                  |
| `RSRV-INCR` | Reserve increased                                |
| `SUBR-OPEN` | Subrogation open                                 |
| `VOID`      | Voided (manager-only action)                     |
| `HOST: LINKED` / `HOST: RECONNECTING…` | Faux mainframe link state |
| `READY` / `BREAK` / `MEAL` / `TRAINING` / `OUTBOUND` / `TECH-ISSUE` | Aux codes |

## Coverage codes

* Auto: `COLL-500`, `COMP-250`, `LIAB-100/300`, `PD-50`, `MED-5`, `UM-100`
* Home: `DWELL-A`, `OTHER-B`, `PERS-C`, `LOU-D`, `PLIA-E`, `MEDP-F`
* Renters: `PERS-C`, `PLIA-E`, `LOU-D`
* Umbrella: `UMB-1M`

## FNOL wizard — five pages (in-window, no PropertySheet)

1. **Incident** — Loss Date `MM/DD/YYYY`, Time `HH:MM`, Loss Location free-text,
   Loss Type combobox (one of `COLLISION`, `THEFT`, `FIRE`, `WATER`, `WIND`,
   `LIABILITY`, `GLASS`, `VANDALISM`), Narrative (multiline; adjuster
   shorthand).
2. **Vehicles / Property** — list with Add / Remove. Add dialog: Year, Make,
   Model, VIN, Damage.
3. **Parties** — list with Add / Remove. Roles: `CLAIMANT`, `OTHER DRIVER`,
   `WITNESS`, `PASSENGER`. Fields: Name, Phone, Address.
4. **Coverage Application** — checkbox listview of the policy's coverages.
   Sum of checked deductibles is shown in the **Combined Deductible** field.
5. **Review & Submit** — read-only summary in a single edit. Primary button is
   `Submit Claim` (ID `IDC_FNOL_SUBMIT` = 7604). After submit, the claim ID
   appears in `IDC_FNOL_RESULT_CLAIMID` (7651), in the confirmation dialog
   (`IDC_CONFIRM_CLAIM_ID` = 5900), and on the clipboard — the agent reads it
   from the screen (there is no result file).

## Adjuster shorthand examples

```
CLMT REPORTS COLLISION AT INTRSXN OF 5TH & MAIN ON 04/12/1998 14:30. NO INJ.
POL VEH (1995 FORD TAURUS) DAMAGED RR BUMPER & TAILGATE. OTHER VEH
(1996 HONDA CIVIC) F&S WITH MINOR FRONT DAMAGE. ADJ ASSGN: ADJ-NA-0142.
RSRV SET: $4,200.00. SUBR-OPEN.
```

```
WATER DMG — BURST SUPPLY LINE UNDER KIT SINK. STANDING WATER OBSERVED.
MITIGATION CONTRACTOR ENGAGED. ADJ ASSGN: ADJ-NA-0207. RSRV SET: $8,500.00.
```

```
TP ALLEGES SLIP/FALL ON PREMISES. NO MED RECORDS PROVIDED. INVESTIGATION
OPEN. ADJ ASSGN: ADJ-WC-0419. RSRV SET: $5,000.00.
```

## Pre-shift aux codes (Ready Gate modal)

`BREAK`, `MEAL`, `TRAINING`, `OUTBOUND`, `TECH-ISSUE` — only relevant if the
operator selects *No*. With `--skip-ready-gate` or `--fast-auth` the modal is
skipped and `READY` is assumed.

## Intent → loss type mapping

| Intent (call-context)   | FNOL `loss_type` |
|-------------------------|------------------|
| `auto_collision`        | `COLLISION`      |
| `auto_theft`            | `THEFT`          |
| `auto_glass`            | `GLASS`          |
| `home_water`            | `WATER`          |
| `home_fire`             | `FIRE`           |
| `home_wind`             | `WIND`           |
| `liability`             | `LIABILITY`      |
| `fraud_investigation`   | `LIABILITY`      |
| `other` / unknown       | `COLLISION` (default; `OTHER` is not a real dropdown value — do not select it) |
