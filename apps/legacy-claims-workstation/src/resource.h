/*
 * resource.h - stable resource IDs for the Zava Mutual Claims Workstation.
 *
 * Every interactive control referenced by the CUA must have an ID that does not
 * change between builds. Do not reorder values; only append.
 */
#ifndef WGM_RESOURCE_H
#define WGM_RESOURCE_H

/* ---------- Icons / Bitmaps ---------- */
#define IDI_APP                         100
#define IDB_TOOLBAR                     110
#define IDB_SPLASH                      111

/* ---------- Embedded RCDATA (seed CSVs) ---------- */
#define IDR_SEED_CUSTOMERS              200
#define IDR_SEED_POLICIES               201
#define IDR_SEED_COVERAGES              202
#define IDR_SEED_CLAIMS                 203
#define IDR_SEED_ACTIVITIES             204
#define IDR_SEED_NOTES                  205

/* ---------- Menus ---------- */
#define IDR_MAIN_MENU                   300
#define IDR_LIST_CONTEXT_MENU           301
#define IDR_CLAIMS_CONTEXT_MENU         302

/* Menu commands */
#define IDM_FILE_NEW_FNOL               1001
#define IDM_FILE_OPEN                   1002
#define IDM_FILE_SAVE                   1003
#define IDM_FILE_PRINT                  1004
#define IDM_FILE_EXIT                   1005
#define IDM_FILE_EXPORT                 1006

#define IDM_EDIT_CUT                    1101
#define IDM_EDIT_COPY                   1102
#define IDM_EDIT_PASTE                  1103
#define IDM_EDIT_FIND                   1104

#define IDM_VIEW_REFRESH                1201
#define IDM_VIEW_AUDIT                  1202

#define IDM_RECORDS_NEXT                1301
#define IDM_RECORDS_PREV                1302
#define IDM_RECORDS_GOTO                1303

#define IDM_REPORTS_DAILY               1401
#define IDM_REPORTS_OPEN_CLAIMS         1402
#define IDM_REPORTS_FRAUD               1403

#define IDM_TOOLS_OPTIONS               1501
#define IDM_TOOLS_HOSTLINK              1502
#define IDM_TOOLS_RESETDATA             1503

#define IDM_HELP_CONTENTS               1601
#define IDM_HELP_ABOUT                  1602

#define IDM_ACT_TRANSFER                1701
#define IDM_ACT_REASSIGN                1702
#define IDM_ACT_CLOSE                   1703
#define IDM_ACT_VOID                    1704
#define IDM_ACT_NEWFNOL                 1705
#define IDM_ACT_OPEN                    1706
#define IDM_ACT_NOTE                    1707
#define IDM_ACT_MARK_SUSPICIOUS         1708
#define IDM_ACT_PRINT                   1709
#define IDM_ACT_EXPORT                  1710
#define IDM_ACT_AUDIT                   1711

/* Accelerators */
#define IDR_ACCEL                       400

/* ---------- Dialogs ---------- */
#define IDD_SPLASH                      500
#define IDD_COMPLIANCE                  501
#define IDD_LOGIN                       502
#define IDD_STAGED_AUTH                 503
#define IDD_MOTD                        504
#define IDD_READY_GATE                  505
#define IDD_ABOUT                       506
#define IDD_CONFIRM_CLAIM               507
#define IDD_PIN_ROTATE                  508
#define IDD_IDLE_REAUTH                 509
#define IDD_ADD_NOTE                    510
#define IDD_ADD_VEHICLE                 511
#define IDD_ADD_PARTY                   512

/* ---------- Splash controls ---------- */
#define IDC_SPLASH_TEXT                 5000
#define IDC_SPLASH_PROGRESS             5001
#define IDC_SPLASH_BUILD                5002
#define IDC_SPLASH_FOOTER               5003

/* ---------- Compliance banner ---------- */
#define IDC_COMPLIANCE_TEXT             5100
#define IDC_COMPLIANCE_AGREE            5101

/* ---------- Login ---------- */
#define IDC_LOGIN_AGENT_ID              5200
#define IDC_LOGIN_PIN                   5201
#define IDC_LOGIN_WORKSTATION           5202
#define IDC_LOGIN_BRANCH                5203
#define IDC_LOGIN_CONNECT               5204
#define IDC_LOGIN_STATUS                5205
#define IDC_LOGIN_TITLE                 5206
#define IDC_LOGIN_SWITCH                5207

/* ---------- Staged auth ---------- */
#define IDC_AUTH_PROGRESS               5300
#define IDC_AUTH_LIST                   5301

/* ---------- MOTD ---------- */
#define IDC_MOTD_TEXT                   5400
#define IDC_MOTD_ACK                    5401

/* ---------- Ready gate ---------- */
#define IDC_READY_YES                   5500
#define IDC_READY_NO                    5501
#define IDC_READY_AUX                   5502
#define IDC_READY_QUESTION              5503

/* ---------- Idle re-auth ---------- */
#define IDC_IDLE_PIN                    5600
#define IDC_IDLE_RESUME                 5601
#define IDC_IDLE_SIGNOFF                5602

/* ---------- PIN rotation ---------- */
#define IDC_PIN_OLD                     5700
#define IDC_PIN_NEW                     5701
#define IDC_PIN_CONFIRM                 5702

/* ---------- About / Confirm-claim ---------- */
#define IDC_ABOUT_TEXT                  5800
#define IDC_CONFIRM_CLAIM_ID            5900
#define IDC_CONFIRM_COPY                5901
#define IDC_CONFIRM_OK                  5902

/* ---------- Add Note / Vehicle / Party dialogs ---------- */
#define IDC_NOTE_SEVERITY               6000
#define IDC_NOTE_TEXT                   6001
#define IDC_VEH_YEAR                    6100
#define IDC_VEH_MAKE                    6101
#define IDC_VEH_MODEL                   6102
#define IDC_VEH_VIN                     6103
#define IDC_VEH_DAMAGE                  6104
#define IDC_PARTY_ROLE                  6200
#define IDC_PARTY_NAME                  6201
#define IDC_PARTY_PHONE                 6202
#define IDC_PARTY_ADDR                  6203

/* ---------- Main window child controls ---------- */
#define IDC_SEARCH_RADIO_PHONE          7000
#define IDC_SEARCH_RADIO_POLICY         7001
#define IDC_SEARCH_RADIO_NAME           7002
#define IDC_SEARCH_RADIO_CLAIM          7003
#define IDC_SEARCH_INPUT                7010
#define IDC_SEARCH_BUTTON               7011
#define IDC_SEARCH_CLEAR                7012
#define IDC_SEARCH_RESULTS              7013
#define IDC_SEARCH_LABEL                7014

#define IDC_DETAIL_TABS                 7100
#define IDC_STATUS_BAR                  7101
#define IDC_TOOLBAR                     7102

/* Policy tab */
#define IDC_POL_NUMBER                  7200
#define IDC_POL_INSURED                 7201
#define IDC_POL_PHONE                   7202
#define IDC_POL_ADDRESS                 7203
#define IDC_POL_TYPE                    7204
#define IDC_POL_EFFECTIVE               7205
#define IDC_POL_EXPIRATION              7206
#define IDC_POL_PREMIUM                 7207
#define IDC_POL_BILLING                 7208
#define IDC_POL_AGENT                   7209
#define IDC_POL_FOOTER                  7210
#define IDC_POL_STATUS                  7211

/* Coverage tab */
#define IDC_COV_TREE                    7300
#define IDC_COV_FOOTER                  7301
#define IDC_COV_DETAIL                  7302

/* Claims tab */
#define IDC_CLM_LIST                    7400
#define IDC_CLM_DETAIL                  7401
#define IDC_CLM_FOOTER                  7402
#define IDC_CLM_REASSIGN                7403
#define IDC_CLM_CLOSE                   7404
#define IDC_CLM_VOID                    7405
#define IDC_CLM_TRANSFER                7406

/* Notes tab */
#define IDC_NOTES_LIST                  7500
#define IDC_NOTES_ADD                   7501
#define IDC_NOTES_FOOTER                7502

/* FNOL wizard (single panel, paged) */
#define IDC_FNOL_STEPLABEL              7600
#define IDC_FNOL_BACK                   7601
#define IDC_FNOL_NEXT                   7602
#define IDC_FNOL_CANCEL                 7603
#define IDC_FNOL_SUBMIT                 7604

/* FNOL Step 1: Incident */
#define IDC_FNOL_LOSS_DATE              7610
#define IDC_FNOL_LOSS_TIME              7611
#define IDC_FNOL_LOSS_LOCATION          7612
#define IDC_FNOL_LOSS_TYPE              7613
#define IDC_FNOL_NARRATIVE              7614

/* FNOL Step 2: Vehicles/Property */
#define IDC_FNOL_VEH_LIST               7620
#define IDC_FNOL_VEH_ADD                7621
#define IDC_FNOL_VEH_REMOVE             7622

/* FNOL Step 3: Parties */
#define IDC_FNOL_PARTY_LIST             7630
#define IDC_FNOL_PARTY_ADD              7631
#define IDC_FNOL_PARTY_REMOVE           7632

/* FNOL Step 4: Coverage Application */
#define IDC_FNOL_COV_LIST               7640
#define IDC_FNOL_COV_DEDUCTIBLE         7641

/* FNOL Step 5: Review & Submit */
#define IDC_FNOL_REVIEW_TEXT            7650
#define IDC_FNOL_RESULT_CLAIMID         7651
#define IDC_FNOL_RESULT_LABEL           7652

#endif /* WGM_RESOURCE_H */
