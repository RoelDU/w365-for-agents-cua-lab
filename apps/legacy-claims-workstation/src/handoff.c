/* handoff.c - see handoff.h. */
#include "handoff.h"

#include "json.h"
#include "log.h"
#include "util.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <windows.h>

/* --------- CLI helper (mirrors main.c has_arg, kept local) --------- */
static int hf_arg(int argc, char **argv, const char *needle, const char **out_value)
{
    size_t nlen = strlen(needle);
    for (int i = 1; i < argc; ++i) {
        if (strncmp(argv[i], needle, nlen) == 0) {
            if (argv[i][nlen] == '=') { if (out_value) *out_value = argv[i] + nlen + 1; return 1; }
            if (argv[i][nlen] == '\0') { if (out_value) *out_value = NULL; return 1; }
        }
    }
    return 0;
}

/* --------- JSON string escaping for output values --------- */
static void json_escape(const char *src, char *dst, size_t cap)
{
    size_t i = 0;
    if (cap == 0) return;
    for (; src && *src; ++src) {
        unsigned char c = (unsigned char)*src;
        const char *rep = NULL;
        char buf[8];
        switch (c) {
            case '"':  rep = "\\\""; break;
            case '\\': rep = "\\\\"; break;
            case '\n': rep = "\\n";  break;
            case '\r': rep = "\\r";  break;
            case '\t': rep = "\\t";  break;
            case '\b': rep = "\\b";  break;
            case '\f': rep = "\\f";  break;
            default:
                if (c < 0x20) { sprintf(buf, "\\u%04x", c); rep = buf; }
                break;
        }
        if (rep) {
            for (const char *r = rep; *r; ++r) { if (i + 1 < cap) dst[i++] = *r; }
        } else {
            if (i + 1 < cap) dst[i++] = (char)c;
        }
    }
    dst[i] = '\0';
}

/* Ensure the directory that contains 'file_path' exists. */
static void ensure_parent_dir(const char *file_path)
{
    char dir[MAX_PATH];
    wgm_strlcpy(dir, file_path, sizeof dir);
    char *slash = NULL;
    for (char *p = dir; *p; ++p) if (*p == '\\' || *p == '/') slash = p;
    if (slash) { *slash = '\0'; wgm_ensure_dir(dir); }
}

static int write_json_file(const char *path, const char *json)
{
    if (!path || !*path) return -1;
    ensure_parent_dir(path);
    int rc = wgm_atomic_write(path, json, strlen(json));
    if (rc != 0) wgm_log("handoff: failed to write %s", path);
    return rc;
}

/* --------- configuration --------- */
void wgm_handoff_configure(WgmApp *app, int argc, char **argv)
{
    const char *v = NULL;
    char root[MAX_PATH];

    int have_dir     = hf_arg(argc, argv, "--handoff-dir", &v) && v;
    const char *dir  = have_dir ? v : NULL;

    if (dir) {
        wgm_strlcpy(root, dir, sizeof root);
    } else {
        const char *pd = getenv("ProgramData");
        if (!pd || !*pd) pd = "C:\\ProgramData";
        snprintf(root, sizeof root, "%s\\ZavaClaims\\handoff", pd);
    }

    /* Defaults derived from root, overridable by explicit flags. */
    snprintf(app->handoff_prefill_path, sizeof app->handoff_prefill_path, "%s\\in\\prefill.json", root);
    snprintf(app->handoff_ready_path,   sizeof app->handoff_ready_path,   "%s\\out\\ready.json",  root);
    snprintf(app->handoff_result_path,  sizeof app->handoff_result_path,  "%s\\out\\result.json", root);
    snprintf(app->handoff_error_path,   sizeof app->handoff_error_path,   "%s\\out\\error.json",  root);

    int have_prefill = hf_arg(argc, argv, "--prefill", &v) && v;
    if (have_prefill) wgm_strlcpy(app->handoff_prefill_path, v, sizeof app->handoff_prefill_path);

    int have_ready = hf_arg(argc, argv, "--ready-file", &v) && v;
    if (have_ready) wgm_strlcpy(app->handoff_ready_path, v, sizeof app->handoff_ready_path);

    int have_result = hf_arg(argc, argv, "--result", &v) && v;
    if (have_result) wgm_strlcpy(app->handoff_result_path, v, sizeof app->handoff_result_path);

    app->handoff_active = (have_dir || have_prefill || have_ready || have_result) ? 1 : 0;

    if (app->handoff_active)
        wgm_log("handoff active: prefill=%s ready=%s result=%s",
                app->handoff_prefill_path, app->handoff_ready_path, app->handoff_result_path);
}

/* --------- prefill load --------- */
int wgm_handoff_load_prefill(WgmApp *app)
{
    char *buf = NULL;
    size_t len = 0;
    if (wgm_read_file(app->handoff_prefill_path, &buf, &len) != 0 || !buf) {
        wgm_log("handoff: prefill not readable: %s", app->handoff_prefill_path);
        return -1;
    }

    app->hf_request_id[0] = app->hf_policy_number[0] = app->hf_caller_phone[0] = '\0';
    app->hf_intent[0] = app->hf_summary[0] = '\0';

    wgm_json_get_string(buf, "request_id",    app->hf_request_id,    sizeof app->hf_request_id);
    wgm_json_get_string(buf, "policy_number", app->hf_policy_number, sizeof app->hf_policy_number);
    wgm_json_get_string(buf, "caller_phone",  app->hf_caller_phone,  sizeof app->hf_caller_phone);
    wgm_json_get_string(buf, "intent",        app->hf_intent,        sizeof app->hf_intent);
    wgm_json_get_string(buf, "summary",       app->hf_summary,       sizeof app->hf_summary);

    free(buf);

    /* request_id plus at least one selector are required. */
    if (app->hf_request_id[0] == '\0') return -2;
    if (app->hf_policy_number[0] == '\0' && app->hf_caller_phone[0] == '\0') return -2;
    return 0;
}

/* --------- matching --------- */
int wgm_handoff_match(const WgmModel *m, const char *policy_number,
                      const char *caller_phone, int *cust_idx, int *pol_idx)
{
    if (cust_idx) *cust_idx = -1;
    if (pol_idx)  *pol_idx  = -1;
    if (!m) return 0;

    /* Match by policy number first: exact, then case-insensitive substring. */
    if (policy_number && *policy_number) {
        for (int i = 0; i < m->n_policies; ++i) {
            if (strcmp(m->policies[i].id, policy_number) == 0) {
                if (pol_idx) *pol_idx = i;
                if (cust_idx) *cust_idx = wgm_find_customer_idx(m, m->policies[i].customer_id);
                return 1;
            }
        }
        for (int i = 0; i < m->n_policies; ++i) {
            if (wgm_ci_contains(m->policies[i].id, policy_number)) {
                if (pol_idx) *pol_idx = i;
                if (cust_idx) *cust_idx = wgm_find_customer_idx(m, m->policies[i].customer_id);
                return 1;
            }
        }
    }

    /* Fall back to caller phone -> customer, then their first policy. */
    if (caller_phone && *caller_phone) {
        for (int i = 0; i < m->n_customers; ++i) {
            if (wgm_ci_contains(m->customers[i].phone, caller_phone)) {
                if (cust_idx) *cust_idx = i;
                for (int j = 0; j < m->n_policies; ++j) {
                    if (strcmp(m->policies[j].customer_id, m->customers[i].id) == 0) {
                        if (pol_idx) *pol_idx = j;
                        break;
                    }
                }
                return 1;
            }
        }
    }

    return 0;
}

/* --------- JSON builders --------- */
int wgm_handoff_build_ready(char *buf, size_t cap, const char *request_id,
                            const char *window_title, const char *policy_number,
                            const char *customer_name, const char *iso_ts)
{
    char rid[128], wt[256], pn[128], cn[256];
    json_escape(request_id,   rid, sizeof rid);
    json_escape(window_title, wt,  sizeof wt);
    json_escape(policy_number, pn, sizeof pn);
    json_escape(customer_name, cn, sizeof cn);
    int n = snprintf(buf, cap,
        "{\n"
        "  \"request_id\": \"%s\",\n"
        "  \"status\": \"ready\",\n"
        "  \"window_title\": \"%s\",\n"
        "  \"matched_policy_number\": \"%s\",\n"
        "  \"matched_customer_name\": \"%s\",\n"
        "  \"timestamp\": \"%s\"\n"
        "}\n",
        rid, wt, pn, cn, iso_ts ? iso_ts : "");
    return (n < 0 || (size_t)n >= cap) ? 0 : n;
}

int wgm_handoff_build_result(char *buf, size_t cap, const char *request_id,
                             const char *claim_id, const char *policy_number,
                             const char *agent_id, double reserve_amount,
                             const char *iso_ts)
{
    char rid[128], cid[128], pn[128], aid[128];
    json_escape(request_id, rid, sizeof rid);
    json_escape(claim_id,   cid, sizeof cid);
    json_escape(policy_number, pn, sizeof pn);
    json_escape(agent_id,   aid, sizeof aid);
    int n = snprintf(buf, cap,
        "{\n"
        "  \"request_id\": \"%s\",\n"
        "  \"status\": \"submitted\",\n"
        "  \"claim_id\": \"%s\",\n"
        "  \"policy_number\": \"%s\",\n"
        "  \"agent_id\": \"%s\",\n"
        "  \"reserve_amount\": %.2f,\n"
        "  \"timestamp\": \"%s\"\n"
        "}\n",
        rid, cid, pn, aid, reserve_amount, iso_ts ? iso_ts : "");
    return (n < 0 || (size_t)n >= cap) ? 0 : n;
}

int wgm_handoff_build_error(char *buf, size_t cap, const char *request_id,
                            const char *error_code, const char *message,
                            const char *iso_ts)
{
    char rid[128], ec[128], msg[512];
    json_escape(request_id, rid, sizeof rid);
    json_escape(error_code, ec,  sizeof ec);
    json_escape(message,    msg, sizeof msg);
    int n = snprintf(buf, cap,
        "{\n"
        "  \"request_id\": \"%s\",\n"
        "  \"status\": \"error\",\n"
        "  \"error_code\": \"%s\",\n"
        "  \"message\": \"%s\",\n"
        "  \"timestamp\": \"%s\"\n"
        "}\n",
        rid, ec, msg, iso_ts ? iso_ts : "");
    return (n < 0 || (size_t)n >= cap) ? 0 : n;
}

/* --------- high-level orchestration --------- */
int wgm_handoff_prime_and_ready(WgmApp *app)
{
    int cust_idx = -1, pol_idx = -1;
    int matched = wgm_handoff_match(&app->model, app->hf_policy_number,
                                    app->hf_caller_phone, &cust_idx, &pol_idx);

    if (!matched || cust_idx < 0) {
        wgm_handoff_write_error(app, "POLICY_NOT_FOUND",
            "No customer or policy matched the prefill selectors.");
        return -1;
    }

    /* Remember what we matched for the ready/result documents. */
    if (pol_idx >= 0)
        wgm_strlcpy(app->hf_matched_policy, app->model.policies[pol_idx].id,
                    sizeof app->hf_matched_policy);
    else
        app->hf_matched_policy[0] = '\0';
    snprintf(app->hf_matched_customer, sizeof app->hf_matched_customer, "%s %s",
             app->model.customers[cust_idx].first, app->model.customers[cust_idx].last);

    /* Prime the UI: load the customer/policy and seed the FNOL wizard. */
    wgm_main_load_customer(app, cust_idx, pol_idx);
    if (app->hf_intent[0])
        wgm_fnol_set_loss_type(app, wgm_intent_to_loss_type(app->hf_intent));
    if (app->hf_summary[0])
        wgm_fnol_set_narrative(app, app->hf_summary);

    char ts[24];
    wgm_iso8601_utc(ts, sizeof ts);
    char json[1024];
    if (wgm_handoff_build_ready(json, sizeof json, app->hf_request_id, WGM_MAIN_TITLE,
                                app->hf_matched_policy, app->hf_matched_customer, ts) == 0)
        return -1;
    return write_json_file(app->handoff_ready_path, json);
}

int wgm_handoff_write_result(WgmApp *app)
{
    if (!app->handoff_active) return 0;

    char ts[24];
    wgm_iso8601_utc(ts, sizeof ts);
    char json[1024];
    if (wgm_handoff_build_result(json, sizeof json, app->hf_request_id,
                                 app->fnol.claim_id, app->hf_matched_policy,
                                 app->user.agent_id, app->fnol.total_deductible, ts) == 0)
        return -1;
    return write_json_file(app->handoff_result_path, json);
}

int wgm_handoff_write_error(WgmApp *app, const char *code, const char *message)
{
    char ts[24];
    wgm_iso8601_utc(ts, sizeof ts);
    char json[1024];
    if (wgm_handoff_build_error(json, sizeof json, app->hf_request_id,
                                code ? code : "UNKNOWN", message ? message : "", ts) == 0)
        return -1;
    return write_json_file(app->handoff_error_path, json);
}
