/*
 * data.c - model load/save and search.
 *
 * Persistence: tab-quoted RFC 4180 CSV under ZavaClaims\data\.
 * If the files are missing, we deterministically seed from seed.c and write
 * the CSVs so the next launch is fast and stable.
 */
#include "data.h"
#include "seed.h"
#include "csv.h"
#include "util.h"
#include "log.h"

#include <ctype.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <windows.h>

static const char *FN_CUSTOMERS  = "customers.csv";
static const char *FN_POLICIES   = "policies.csv";
static const char *FN_COVERAGES  = "coverages.csv";
static const char *FN_CLAIMS     = "claims.csv";
static const char *FN_ACTIVITIES = "activities.csv";
static const char *FN_NOTES      = "notes.csv";

static void path_for(char *dst, size_t cap, const char *file)
{
    char dir[MAX_PATH];
    wgm_data_dir(dir, sizeof dir);
    _snprintf(dst, cap, "%s\\%s", dir, file);
    dst[cap - 1] = '\0';
}

static void w_csv_escape(char *buf, size_t cap, const char *s)
{
    int needs = 0;
    for (const char *p = s; *p; ++p) {
        if (*p == ',' || *p == '"' || *p == '\r' || *p == '\n') { needs = 1; break; }
    }
    if (!needs) {
        wgm_strlcpy(buf, s, cap);
        return;
    }
    size_t out = 0;
    if (out + 1 < cap) buf[out++] = '"';
    for (const char *p = s; *p && out + 2 < cap; ++p) {
        if (*p == '"') { buf[out++] = '"'; }
        buf[out++] = *p;
    }
    if (out + 1 < cap) buf[out++] = '"';
    if (out < cap) buf[out] = '\0';
    buf[cap - 1] = '\0';
}

static void append_field(char **buf, size_t *cap, size_t *len, const char *raw, int last)
{
    char escaped[1024];
    w_csv_escape(escaped, sizeof escaped, raw);
    size_t need = strlen(escaped) + 2;
    if (*len + need + 1 > *cap) {
        size_t nc = (*cap == 0 ? 4096 : *cap * 2);
        while (nc < *len + need + 1) nc *= 2;
        char *p = (char *)realloc(*buf, nc);
        if (!p) return;
        *buf = p; *cap = nc;
    }
    memcpy(*buf + *len, escaped, strlen(escaped));
    *len += strlen(escaped);
    (*buf)[(*len)++] = (char)(last ? '\n' : ',');
    (*buf)[*len] = '\0';
}

static int write_csv(const char *file, const char *header,
                     int nrows, char *(*get_field)(int row, int col, void *ud, char *tmp), int ncols, void *ud)
{
    size_t cap = 4096, len = 0;
    char *buf = (char *)malloc(cap);
    if (!buf) return -1;
    buf[0] = '\0';
    /* header */
    memcpy(buf, header, strlen(header));
    len = strlen(header);
    if (len + 1 < cap) buf[len++] = '\n';
    buf[len] = '\0';
    char tmp[1024];
    for (int r = 0; r < nrows; ++r) {
        for (int c = 0; c < ncols; ++c) {
            tmp[0] = '\0';
            char *v = get_field(r, c, ud, tmp);
            append_field(&buf, &cap, &len, v ? v : "", c == ncols - 1);
        }
    }
    char path[MAX_PATH];
    path_for(path, sizeof path, file);
    int rc = wgm_atomic_write(path, buf, len);
    free(buf);
    return rc;
}

/* --- per-table accessors --- */
static char *cust_get(int r, int c, void *ud, char *tmp)
{
    const WgmModel *m = (const WgmModel *)ud;
    const WgmCustomer *x = &m->customers[r];
    switch (c) {
    case 0: return (char *)x->id;
    case 1: return (char *)x->first;
    case 2: return (char *)x->last;
    case 3: return (char *)x->phone;
    case 4: return (char *)x->addr;
    case 5: return (char *)x->city;
    case 6: return (char *)x->state;
    case 7: return (char *)x->zip;
    case 8: return (char *)x->dob;
    case 9: return (char *)x->email;
    }
    (void)tmp; return (char *)"";
}

static char *pol_get(int r, int c, void *ud, char *tmp)
{
    const WgmModel *m = (const WgmModel *)ud;
    const WgmPolicy *x = &m->policies[r];
    switch (c) {
    case 0: return (char *)x->id;
    case 1: return (char *)x->customer_id;
    case 2: return (char *)x->type;
    case 3: return (char *)x->status;
    case 4: return (char *)x->effective;
    case 5: return (char *)x->expiration;
    case 6: _snprintf(tmp, 64, "%.2f", x->premium); return tmp;
    case 7: return (char *)x->billing;
    case 8: return (char *)x->agent;
    case 9: return (char *)x->field_office;
    }
    return (char *)"";
}

static char *cov_get(int r, int c, void *ud, char *tmp)
{
    const WgmModel *m = (const WgmModel *)ud;
    const WgmCoverage *x = &m->coverages[r];
    switch (c) {
    case 0: return (char *)x->policy_id;
    case 1: return (char *)x->code;
    case 2: return (char *)x->descr;
    case 3: _snprintf(tmp, 64, "%.2f", x->limit); return tmp;
    case 4: _snprintf(tmp, 64, "%.2f", x->deductible); return tmp;
    }
    return (char *)"";
}

static char *clm_get(int r, int c, void *ud, char *tmp)
{
    const WgmModel *m = (const WgmModel *)ud;
    const WgmClaim *x = &m->claims[r];
    switch (c) {
    case 0: return (char *)x->id;
    case 1: return (char *)x->policy_id;
    case 2: return (char *)x->customer_id;
    case 3: return (char *)x->loss_type;
    case 4: return (char *)x->status;
    case 5: return (char *)x->loss_date;
    case 6: return (char *)x->loss_time;
    case 7: return (char *)x->loss_location;
    case 8: return (char *)x->narrative;
    case 9: _snprintf(tmp, 64, "%.2f", x->reserve); return tmp;
    case 10: return (char *)x->adjuster;
    case 11: return (char *)x->field_office;
    case 12: return (char *)x->opened_by;
    case 13: return (char *)x->opened_on;
    case 14: return (char *)x->modified_by;
    case 15: return (char *)x->modified_on;
    case 16: _snprintf(tmp, 32, "%d", x->suspicious); return tmp;
    }
    return (char *)"";
}

static char *act_get(int r, int c, void *ud, char *tmp)
{
    (void)tmp;
    const WgmModel *m = (const WgmModel *)ud;
    const WgmActivity *x = &m->activities[r];
    switch (c) {
    case 0: return (char *)x->claim_id;
    case 1: return (char *)x->ts;
    case 2: return (char *)x->who;
    case 3: return (char *)x->text;
    }
    return (char *)"";
}

static char *note_get(int r, int c, void *ud, char *tmp)
{
    (void)tmp;
    const WgmModel *m = (const WgmModel *)ud;
    const WgmNote *x = &m->notes[r];
    switch (c) {
    case 0: return (char *)x->claim_id;
    case 1: return (char *)x->severity;
    case 2: return (char *)x->ts;
    case 3: return (char *)x->who;
    case 4: return (char *)x->text;
    }
    return (char *)"";
}

int wgm_model_save(const WgmModel *m)
{
    if (!m) return -1;
    int rc = 0;
    rc |= write_csv(FN_CUSTOMERS,
        "id,first_name,last_name,phone,address,city,state,zip,dob,email",
        m->n_customers, cust_get, 10, (void *)m);
    rc |= write_csv(FN_POLICIES,
        "id,customer_id,type,status,effective,expiration,premium,billing,agent,field_office",
        m->n_policies, pol_get, 10, (void *)m);
    rc |= write_csv(FN_COVERAGES,
        "policy_id,code,descr,limit,deductible",
        m->n_coverages, cov_get, 5, (void *)m);
    rc |= write_csv(FN_CLAIMS,
        "id,policy_id,customer_id,loss_type,status,loss_date,loss_time,loss_location,narrative,reserve,adjuster,field_office,opened_by,opened_on,modified_by,modified_on,suspicious",
        m->n_claims, clm_get, 17, (void *)m);
    rc |= write_csv(FN_ACTIVITIES,
        "claim_id,ts,who,text",
        m->n_activities, act_get, 4, (void *)m);
    rc |= write_csv(FN_NOTES,
        "claim_id,severity,ts,who,text",
        m->n_notes, note_get, 5, (void *)m);
    return rc;
}

static int read_csv_into(const char *file, WgmCsv *out)
{
    char path[MAX_PATH];
    path_for(path, sizeof path, file);
    char *buf = NULL; size_t len = 0;
    if (wgm_read_file(path, &buf, &len) != 0)
        return -1;
    int rc = wgm_csv_parse(buf, len, out);
    free(buf);
    return rc;
}

static const char *cell(const WgmCsvRow *r, int i)
{
    if (i < 0 || i >= r->nfields) return "";
    return r->fields[i] ? r->fields[i] : "";
}

static int load_customers(WgmModel *m)
{
    WgmCsv c = {0};
    if (read_csv_into(FN_CUSTOMERS, &c) != 0) return -1;
    if (c.nrows < 1) { wgm_csv_free(&c); return -1; }
    m->n_customers = c.nrows - 1;
    m->customers = (WgmCustomer *)calloc((size_t)m->n_customers, sizeof(WgmCustomer));
    for (int i = 0; i < m->n_customers; ++i) {
        const WgmCsvRow *r = &c.rows[i + 1];
        WgmCustomer *x = &m->customers[i];
        wgm_strlcpy(x->id,    cell(r, 0), sizeof x->id);
        wgm_strlcpy(x->first, cell(r, 1), sizeof x->first);
        wgm_strlcpy(x->last,  cell(r, 2), sizeof x->last);
        wgm_strlcpy(x->phone, cell(r, 3), sizeof x->phone);
        wgm_strlcpy(x->addr,  cell(r, 4), sizeof x->addr);
        wgm_strlcpy(x->city,  cell(r, 5), sizeof x->city);
        wgm_strlcpy(x->state, cell(r, 6), sizeof x->state);
        wgm_strlcpy(x->zip,   cell(r, 7), sizeof x->zip);
        wgm_strlcpy(x->dob,   cell(r, 8), sizeof x->dob);
        wgm_strlcpy(x->email, cell(r, 9), sizeof x->email);
    }
    wgm_csv_free(&c);
    return 0;
}

static int load_policies(WgmModel *m)
{
    WgmCsv c = {0};
    if (read_csv_into(FN_POLICIES, &c) != 0) return -1;
    if (c.nrows < 1) { wgm_csv_free(&c); return -1; }
    m->n_policies = c.nrows - 1;
    m->policies = (WgmPolicy *)calloc((size_t)m->n_policies, sizeof(WgmPolicy));
    for (int i = 0; i < m->n_policies; ++i) {
        const WgmCsvRow *r = &c.rows[i + 1];
        WgmPolicy *x = &m->policies[i];
        wgm_strlcpy(x->id,          cell(r, 0), sizeof x->id);
        wgm_strlcpy(x->customer_id, cell(r, 1), sizeof x->customer_id);
        wgm_strlcpy(x->type,        cell(r, 2), sizeof x->type);
        wgm_strlcpy(x->status,      cell(r, 3), sizeof x->status);
        wgm_strlcpy(x->effective,   cell(r, 4), sizeof x->effective);
        wgm_strlcpy(x->expiration,  cell(r, 5), sizeof x->expiration);
        x->premium = atof(cell(r, 6));
        wgm_strlcpy(x->billing,     cell(r, 7), sizeof x->billing);
        wgm_strlcpy(x->agent,       cell(r, 8), sizeof x->agent);
        wgm_strlcpy(x->field_office,cell(r, 9), sizeof x->field_office);
    }
    wgm_csv_free(&c);
    return 0;
}

static int load_coverages(WgmModel *m)
{
    WgmCsv c = {0};
    if (read_csv_into(FN_COVERAGES, &c) != 0) return -1;
    if (c.nrows < 1) { wgm_csv_free(&c); return -1; }
    m->n_coverages = c.nrows - 1;
    m->coverages = (WgmCoverage *)calloc((size_t)m->n_coverages, sizeof(WgmCoverage));
    for (int i = 0; i < m->n_coverages; ++i) {
        const WgmCsvRow *r = &c.rows[i + 1];
        WgmCoverage *x = &m->coverages[i];
        wgm_strlcpy(x->policy_id, cell(r, 0), sizeof x->policy_id);
        wgm_strlcpy(x->code,      cell(r, 1), sizeof x->code);
        wgm_strlcpy(x->descr,     cell(r, 2), sizeof x->descr);
        x->limit      = atof(cell(r, 3));
        x->deductible = atof(cell(r, 4));
    }
    wgm_csv_free(&c);
    return 0;
}

static int load_claims(WgmModel *m)
{
    WgmCsv c = {0};
    if (read_csv_into(FN_CLAIMS, &c) != 0) return -1;
    if (c.nrows < 1) { wgm_csv_free(&c); return -1; }
    m->n_claims = c.nrows - 1;
    m->claims = (WgmClaim *)calloc((size_t)m->n_claims, sizeof(WgmClaim));
    for (int i = 0; i < m->n_claims; ++i) {
        const WgmCsvRow *r = &c.rows[i + 1];
        WgmClaim *x = &m->claims[i];
        wgm_strlcpy(x->id,            cell(r, 0),  sizeof x->id);
        wgm_strlcpy(x->policy_id,     cell(r, 1),  sizeof x->policy_id);
        wgm_strlcpy(x->customer_id,   cell(r, 2),  sizeof x->customer_id);
        wgm_strlcpy(x->loss_type,     cell(r, 3),  sizeof x->loss_type);
        wgm_strlcpy(x->status,        cell(r, 4),  sizeof x->status);
        wgm_strlcpy(x->loss_date,     cell(r, 5),  sizeof x->loss_date);
        wgm_strlcpy(x->loss_time,     cell(r, 6),  sizeof x->loss_time);
        wgm_strlcpy(x->loss_location, cell(r, 7),  sizeof x->loss_location);
        wgm_strlcpy(x->narrative,     cell(r, 8),  sizeof x->narrative);
        x->reserve = atof(cell(r, 9));
        wgm_strlcpy(x->adjuster,      cell(r, 10), sizeof x->adjuster);
        wgm_strlcpy(x->field_office,  cell(r, 11), sizeof x->field_office);
        wgm_strlcpy(x->opened_by,     cell(r, 12), sizeof x->opened_by);
        wgm_strlcpy(x->opened_on,     cell(r, 13), sizeof x->opened_on);
        wgm_strlcpy(x->modified_by,   cell(r, 14), sizeof x->modified_by);
        wgm_strlcpy(x->modified_on,   cell(r, 15), sizeof x->modified_on);
        x->suspicious = atoi(cell(r, 16));
    }
    wgm_csv_free(&c);
    return 0;
}

static int load_activities(WgmModel *m)
{
    WgmCsv c = {0};
    if (read_csv_into(FN_ACTIVITIES, &c) != 0) return -1;
    if (c.nrows < 1) { wgm_csv_free(&c); return -1; }
    m->n_activities = c.nrows - 1;
    m->activities = (WgmActivity *)calloc((size_t)m->n_activities, sizeof(WgmActivity));
    for (int i = 0; i < m->n_activities; ++i) {
        const WgmCsvRow *r = &c.rows[i + 1];
        WgmActivity *x = &m->activities[i];
        wgm_strlcpy(x->claim_id, cell(r, 0), sizeof x->claim_id);
        wgm_strlcpy(x->ts,       cell(r, 1), sizeof x->ts);
        wgm_strlcpy(x->who,      cell(r, 2), sizeof x->who);
        wgm_strlcpy(x->text,     cell(r, 3), sizeof x->text);
    }
    wgm_csv_free(&c);
    return 0;
}

static int load_notes(WgmModel *m)
{
    WgmCsv c = {0};
    if (read_csv_into(FN_NOTES, &c) != 0) return -1;
    if (c.nrows < 1) { wgm_csv_free(&c); return -1; }
    m->n_notes = c.nrows - 1;
    m->notes = (WgmNote *)calloc((size_t)m->n_notes, sizeof(WgmNote));
    for (int i = 0; i < m->n_notes; ++i) {
        const WgmCsvRow *r = &c.rows[i + 1];
        WgmNote *x = &m->notes[i];
        wgm_strlcpy(x->claim_id, cell(r, 0), sizeof x->claim_id);
        wgm_strlcpy(x->severity, cell(r, 1), sizeof x->severity);
        wgm_strlcpy(x->ts,       cell(r, 2), sizeof x->ts);
        wgm_strlcpy(x->who,      cell(r, 3), sizeof x->who);
        wgm_strlcpy(x->text,     cell(r, 4), sizeof x->text);
    }
    wgm_csv_free(&c);
    return 0;
}

int wgm_model_load(WgmModel *m)
{
    memset(m, 0, sizeof *m);
    int loaded = 0;
    loaded |= (load_customers(m)  == 0);
    loaded |= (load_policies(m)   == 0);
    loaded |= (load_coverages(m)  == 0);
    loaded |= (load_claims(m)     == 0);
    loaded |= (load_activities(m) == 0);
    loaded |= (load_notes(m)      == 0);
    /* If anything is missing, fall back to a fresh seed and persist. */
    if (m->n_customers == 0 || m->n_policies == 0 || m->n_claims == 0) {
        wgm_model_free(m);
        wgm_seed_generate(m);
        wgm_model_save(m);
        wgm_log("data: reseeded (no local data found)");
    } else {
        (void)loaded;
        wgm_log("data: loaded customers=%d policies=%d claims=%d activities=%d notes=%d",
                m->n_customers, m->n_policies, m->n_claims, m->n_activities, m->n_notes);
    }
    return 0;
}

int wgm_model_reset(WgmModel *m)
{
    wgm_model_free(m);
    wgm_seed_generate(m);
    int rc = wgm_model_save(m);
    wgm_log("data: reset complete (rc=%d)", rc);
    return rc;
}

void wgm_model_free(WgmModel *m)
{
    if (!m) return;
    free(m->customers);
    free(m->policies);
    free(m->coverages);
    free(m->claims);
    free(m->activities);
    free(m->notes);
    memset(m, 0, sizeof *m);
}

/* ---- search ---- */
static void push(int *out, int *n, int cap, int v)
{
    if (*n < cap) out[(*n)++] = v;
}

int wgm_search_by_phone(const WgmModel *m, const char *phone, int *out, int out_cap)
{
    int n = 0;
    if (!phone || !*phone) return 0;
    for (int i = 0; i < m->n_customers; ++i) {
        if (wgm_ci_contains(m->customers[i].phone, phone))
            push(out, &n, out_cap, i);
    }
    return n;
}

int wgm_search_by_policy(const WgmModel *m, const char *polnum, int *out, int out_cap)
{
    int n = 0;
    if (!polnum || !*polnum) return 0;
    for (int i = 0; i < m->n_policies; ++i) {
        if (wgm_ci_contains(m->policies[i].id, polnum)) {
            int ci = wgm_find_customer_idx(m, m->policies[i].customer_id);
            if (ci >= 0) push(out, &n, out_cap, ci);
        }
    }
    return n;
}

int wgm_search_by_name(const WgmModel *m, const char *name, int *out, int out_cap)
{
    int n = 0;
    if (!name || !*name) return 0;
    for (int i = 0; i < m->n_customers; ++i) {
        if (wgm_ci_contains(m->customers[i].last,  name) ||
            wgm_ci_contains(m->customers[i].first, name))
            push(out, &n, out_cap, i);
    }
    return n;
}

int wgm_search_by_claim(const WgmModel *m, const char *claim, int *out, int out_cap)
{
    int n = 0;
    if (!claim || !*claim) return 0;
    for (int i = 0; i < m->n_claims; ++i) {
        if (wgm_ci_contains(m->claims[i].id, claim)) {
            int ci = wgm_find_customer_idx(m, m->claims[i].customer_id);
            if (ci >= 0) push(out, &n, out_cap, ci);
        }
    }
    return n;
}

int wgm_find_customer_idx(const WgmModel *m, const char *customer_id)
{
    for (int i = 0; i < m->n_customers; ++i)
        if (strcmp(m->customers[i].id, customer_id) == 0) return i;
    return -1;
}

int wgm_find_policy_idx(const WgmModel *m, const char *policy_id)
{
    for (int i = 0; i < m->n_policies; ++i)
        if (strcmp(m->policies[i].id, policy_id) == 0) return i;
    return -1;
}

int wgm_find_claim_idx(const WgmModel *m, const char *claim_id)
{
    for (int i = 0; i < m->n_claims; ++i)
        if (strcmp(m->claims[i].id, claim_id) == 0) return i;
    return -1;
}

void wgm_make_claim_id(const WgmModel *m, char *dst, size_t cap)
{
    int year = wgm_current_year();
    int max_seq = 0;
    char prefix[16];
    _snprintf(prefix, sizeof prefix, "CLM-%04d-", year);
    size_t pl = strlen(prefix);
    for (int i = 0; i < m->n_claims; ++i) {
        if (strncmp(m->claims[i].id, prefix, pl) == 0) {
            int seq = atoi(m->claims[i].id + pl);
            if (seq > max_seq) max_seq = seq;
        }
    }
    _snprintf(dst, cap, "%s%06d", prefix, max_seq + 1);
    dst[cap - 1] = '\0';
}

int wgm_model_add_claim(WgmModel *m, const WgmClaim *c)
{
    if (!m || !c) return -1;
    m->claims = (WgmClaim *)realloc(m->claims, (size_t)(m->n_claims + 1) * sizeof(WgmClaim));
    if (!m->claims) return -1;
    m->claims[m->n_claims++] = *c;
    return 0;
}

int wgm_model_add_note(WgmModel *m, const WgmNote *n)
{
    if (!m || !n) return -1;
    m->notes = (WgmNote *)realloc(m->notes, (size_t)(m->n_notes + 1) * sizeof(WgmNote));
    if (!m->notes) return -1;
    m->notes[m->n_notes++] = *n;
    return 0;
}

int wgm_model_add_activity(WgmModel *m, const WgmActivity *a)
{
    if (!m || !a) return -1;
    m->activities = (WgmActivity *)realloc(m->activities, (size_t)(m->n_activities + 1) * sizeof(WgmActivity));
    if (!m->activities) return -1;
    m->activities[m->n_activities++] = *a;
    return 0;
}
