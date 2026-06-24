/*
 * data.h - in-memory data model plus CSV load/save and search.
 *
 * Records are stored in flat arrays; lookups are linear which is fine for the
 * demo data set (~100 customers, ~140 policies, ~220 claims, ~900 activities).
 */
#ifndef WGM_DATA_H
#define WGM_DATA_H

#include <stddef.h>

typedef struct WgmCustomer {
    char id[16];
    char first[32];
    char last[32];
    char phone[20];     /* (NPA) NXX-XXXX */
    char addr[64];
    char city[40];
    char state[3];
    char zip[12];
    char dob[12];
    char email[80];
} WgmCustomer;

typedef struct WgmPolicy {
    char id[20];        /* POL-YYYY-NNNNNN */
    char customer_id[16];
    char type[16];      /* AUTO/HOME/RENTERS/UMBRELLA */
    char status[16];
    char effective[16]; /* MM/DD/YYYY */
    char expiration[16];
    double premium;
    char billing[16];   /* CURRENT/PAST DUE/PAID IN FULL */
    char agent[16];     /* C1001 */
    char field_office[16];
} WgmPolicy;

typedef struct WgmCoverage {
    char policy_id[20];
    char code[20];     /* COLL-500 etc */
    char descr[64];
    double limit;
    double deductible;
} WgmCoverage;

typedef struct WgmClaim {
    char id[20];        /* CLM-YYYY-NNNNNN */
    char policy_id[20];
    char customer_id[16];
    char loss_type[16];
    char status[16];    /* OPEN-ASGN/PEND-REVW/CLSD-PAID/CLSD-DEN/RSRV-INCR/SUBR-OPEN/VOID */
    char loss_date[16];
    char loss_time[8];
    char loss_location[80];
    char narrative[600];
    double reserve;
    char adjuster[16];
    char field_office[16];
    char opened_by[16];
    char opened_on[20];
    char modified_by[16];
    char modified_on[20];
    int suspicious;
} WgmClaim;

typedef struct WgmActivity {
    char claim_id[20];
    char ts[20];
    char who[16];
    char text[200];
} WgmActivity;

typedef struct WgmNote {
    char claim_id[20];
    char severity[12]; /* INFO/WARNING/CRITICAL */
    char ts[20];
    char who[16];
    char text[300];
} WgmNote;

typedef struct WgmModel {
    WgmCustomer *customers; int n_customers;
    WgmPolicy   *policies;  int n_policies;
    WgmCoverage *coverages; int n_coverages;
    WgmClaim    *claims;    int n_claims;
    WgmActivity *activities;int n_activities;
    WgmNote     *notes;     int n_notes;
} WgmModel;

/* Load the model from local data\\ folder; if CSVs missing, seed from RCDATA. */
int wgm_model_load(WgmModel *m);
void wgm_model_free(WgmModel *m);

/* Re-seed everything deterministically and write CSVs (and the embedded
 * representation if requested for diagnostics). */
int wgm_model_reset(WgmModel *m);

/* Save current state back to CSVs (used after submitting a new claim). */
int wgm_model_save(const WgmModel *m);

/* Search helpers: each fills caller-provided out[] with indices and returns count. */
int wgm_search_by_phone (const WgmModel *m, const char *phone,  int *out, int out_cap);
int wgm_search_by_policy(const WgmModel *m, const char *polnum, int *out, int out_cap);
int wgm_search_by_name  (const WgmModel *m, const char *name,   int *out, int out_cap);
int wgm_search_by_claim (const WgmModel *m, const char *claim,  int *out, int out_cap);

/* Returns a fresh claim id for the current year. Caller-supplied buffer. */
void wgm_make_claim_id(const WgmModel *m, char *dst, size_t cap);

/* Add a freshly-built claim to the model in memory (no IO). */
int wgm_model_add_claim(WgmModel *m, const WgmClaim *c);

/* Add a note. */
int wgm_model_add_note(WgmModel *m, const WgmNote *n);

/* Add an activity entry. */
int wgm_model_add_activity(WgmModel *m, const WgmActivity *a);

/* Lookup helpers: return -1 if not found. */
int wgm_find_customer_idx(const WgmModel *m, const char *customer_id);
int wgm_find_policy_idx (const WgmModel *m, const char *policy_id);
int wgm_find_claim_idx  (const WgmModel *m, const char *claim_id);

#endif /* WGM_DATA_H */
