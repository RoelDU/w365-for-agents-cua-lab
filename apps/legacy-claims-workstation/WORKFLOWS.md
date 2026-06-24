# WORKFLOWS — Six scripted demos for the Claims Workstation

Each workflow is a numbered click-by-click script with the exact field values
to type. Use them as the basis for live demos, automated CUA evaluations, and
manual smoke tests. The "Setup" step assumes you have run
`claims.exe --prepare-demo-data --reset-data` once.

---

## 1. Inbound call — Auto policy holder reports collision (full legacy auth)

**Goal:** showcase the legacy auth theatre, then file an FNOL for Jordan
Smith's auto policy.

**Setup:** start `claims.exe` with no flags so the full legacy auth flow runs.

```
.\claims.exe
```

**Steps**
1. Splash appears (~2 s). Wait for it to dismiss.
2. **Compliance** modal — click **I Agree**.
3. **Login** dialog — type Agent ID `C1001`, PIN `1234`, leave Workstation
   `T-1001`, Branch `WST-014`. Click **Connect**.
4. **Staged auth** dialog plays seven lines. Wait for *"HOST: LINKED."*.
5. **Message of the Day** — click **Acknowledge**.
6. **Ready Gate** — click **Yes — Ready**.
7. Main window appears. Status bar shows `READY` and `HOST: LINKED`.
8. In the left **Search** panel, leave radio at *Phone*. Type
   `(555) 123-4567` into `IDC_SEARCH_INPUT`, click **Search**.
9. The result row "Jordan Smith — CUST-000001" appears; double-click it.
10. Right-pane tabs populate. **Policy** tab shows `POL-2024-008341`.
11. Click the **New FNOL** tab.
12. **Step 1 — Incident**: Loss Date `04/12/2024`, Time `14:30`,
    Location `5th and Main, Springfield IL`, Loss Type `COLLISION`,
    Narrative:
    `CLMT REAR-ENDED AT INTRSXN OF 5TH & MAIN. NO INJ. POL VEH DRIVABLE.`
13. Click **Next** four times to reach **Review & Submit**.
14. Click **Submit Claim**.
15. Confirmation dialog shows the claim ID. Click **Copy to Clipboard**, then **OK**.

---

## 2. Inbound call — Homeowner reports water damage (escalated to Senior CSR)

**Setup:** start with fast-auth, log in as Senior CSR R. Davis (`PIN 3456`).

```
.\claims.exe --fast-auth --no-splash
```

**Steps**
1. Login dialog — Agent ID `C1003`, PIN `3456`. Click **Connect**.
2. Search by **Phone** for `(555) 222-0198`. Result: *Morgan Lee*.
3. Double-click to load `POL-2024-002210` (HOME).
4. New FNOL → Step 1: Loss Type `WATER`, Narrative:
   `WATER DMG — BURST SUPPLY LINE UNDER KIT SINK. STANDING WATER OBSERVED.`
5. Step 4: tick `DWELL-A` and `PERS-C` coverages.
6. Step 5: click **Submit Claim**.

---

## 3. Fraud investigation — Manager reviews suspicious pattern

**Setup:** log in as Claims Manager A. Morgan (`PIN 9999`).

**Steps**
1. Search by **Phone** for `(555) 777-1212`. Result: *Dakota Quinn*.
2. Click **Claims** tab — list shows three `PEND-REVW` liability claims
   (`CLM-2024-007001`, `…007002`, `…007003`), each with reserve `$5,000.00`.
3. From the menu bar choose **Reports → Fraud Pattern Report**.
4. The dialog enumerates the three round-dollar claims as a suspicious pattern.
5. Optionally use **Actions → Reassign Adjuster** to route to a different
   adjuster (e.g., `ADJ-WC-0419`).

---

## 4. Reassign adjuster on an open claim

**Steps**
1. Search by **Claim #** for `CLM-2023-004411`. Loads Jordan Smith.
2. **Claims** tab — select the row.
3. **Actions** menu → **Reassign Adjuster…** (greyed in the demo build —
   surfaces "Not implemented" `MessageBox` for realism in v1.0).
4. The audit log records the reassignment attempt.

> v1.0 surfaces this action as a notice for realism; in v1.1 it will write the
> new adjuster back to the claim row. The audit-log entry is real.

---

## 5. Add a CRITICAL note and transfer the claim

**Steps**
1. Search any claim (`CLM-2024-007001` works well).
2. Click **Notes** tab. Click **Add Note…**.
3. Severity: `CRITICAL`. Text: `ESCALATE SIU REVIEW PER MANAGER`.
   Click **OK**.
4. The note row appears in the list, timestamped, with author `C1001` (or
   whoever is logged in).
5. From **Actions → Transfer Claim…** — surfaces a "Not implemented" notice
   for realism in v1.0; the audit log records the attempt.

---

## 6. Reset and reseed for a fresh demo run

**Setup:** start as Claims Manager (`PIN 9999`).

**Steps**
1. Menu: **Actions → Reset All Data**.
2. Click **OK** on the confirmation `MessageBox`.
3. The model is regenerated deterministically (100 customers, 140 policies,
   220 claims, ~900 activity rows). Hero records stay identical.
4. Status bar `REC:` counter updates.

Alternative (headless): close the app, then run from a shell:
```
.\claims.exe --prepare-demo-data --reset-data
```
