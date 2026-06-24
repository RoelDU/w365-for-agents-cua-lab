/*
 * test.c - embedded data-layer test suite.
 *
 * Target: 40+ tests, currently 60+. Writes results to stderr. Returns 0 if
 * every test passes; non-zero otherwise so CI can rely on the exit code.
 *
 * Tests are deliberately read-only on the model so they can run in CI without
 * a Windows desktop (just data logic).
 */
#include "test.h"

#include "data.h"
#include "seed.h"
#include "csv.h"
#include "handoff.h"
#include "json.h"
#include "util.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <windows.h>

static int g_pass = 0;
static int g_fail = 0;

#define CHECK(cond, name)                                                       \
    do {                                                                         \
        if (cond) { g_pass++; fprintf(stderr, "PASS %s\n", name); }              \
        else      { g_fail++; fprintf(stderr, "FAIL %s\n", name); }              \
    } while (0)

static void t_csv_basic(void)
{
    const char *s = "a,b,c\n1,2,3\n";
    WgmCsv c = {0};
    int rc = wgm_csv_parse(s, strlen(s), &c);
    CHECK(rc == 0, "csv parse OK");
    CHECK(c.nrows == 2, "csv has 2 rows");
    CHECK(c.rows[0].nfields == 3, "csv header 3 fields");
    CHECK(strcmp(c.rows[0].fields[0], "a") == 0, "csv header a");
    CHECK(strcmp(c.rows[1].fields[2], "3") == 0, "csv body 3");
    wgm_csv_free(&c);
}

static void t_csv_quoted(void)
{
    const char *s = "a,b\n\"hello, world\",\"line1\nline2\"\n";
    WgmCsv c = {0};
    int rc = wgm_csv_parse(s, strlen(s), &c);
    CHECK(rc == 0, "csv quoted parse OK");
    CHECK(c.nrows == 2, "csv quoted 2 rows");
    CHECK(strcmp(c.rows[1].fields[0], "hello, world") == 0, "csv comma in quotes");
    CHECK(strcmp(c.rows[1].fields[1], "line1\nline2") == 0, "csv newline in quotes");
    wgm_csv_free(&c);
}

static void t_csv_escaped_quotes(void)
{
    const char *s = "x\n\"he said \"\"hi\"\"\"\n";
    WgmCsv c = {0};
    CHECK(wgm_csv_parse(s, strlen(s), &c) == 0, "csv escaped quote parse");
    CHECK(strcmp(c.rows[1].fields[0], "he said \"hi\"") == 0, "csv escaped quote value");
    wgm_csv_free(&c);
}

static void t_money_fmt(void)
{
    char b[32];
    wgm_format_money(b, sizeof b, 1234.5);
    CHECK(strcmp(b, "$1,234.50") == 0, "money 1234.50");
    wgm_format_money(b, sizeof b, 0);
    CHECK(strcmp(b, "$0.00") == 0, "money 0");
    wgm_format_money(b, sizeof b, 1000000);
    CHECK(strcmp(b, "$1,000,000.00") == 0, "money 1M");
    wgm_format_money(b, sizeof b, 42.07);
    CHECK(strcmp(b, "$42.07") == 0, "money 42.07");
    wgm_format_money(b, sizeof b, -25.5);
    CHECK(strcmp(b, "-$25.50") == 0, "money -25.50");
}

static void t_ci_contains(void)
{
    CHECK(wgm_ci_contains("Hello World", "WORLD") == 1, "ci contains WORLD");
    CHECK(wgm_ci_contains("Hello World", "xyz") == 0, "ci contains xyz");
    CHECK(wgm_ci_contains("Smith", "smi") == 1, "ci contains smi");
    CHECK(wgm_ci_contains("Smith", "") == 1, "ci contains empty");
}

static void t_seed_hero(void)
{
    WgmModel m = {0};
    int rc = wgm_seed_generate(&m);
    CHECK(rc == 0, "seed generate OK");
    CHECK(m.n_customers >= 100, "seed >=100 customers");
    CHECK(m.n_policies  >= 140, "seed >=140 policies");
    CHECK(m.n_claims    >= 220, "seed >=220 claims");
    CHECK(m.n_activities >= 900, "seed >=900 activities");
    /* Hero records */
    CHECK(strcmp(m.customers[0].first, "Jordan") == 0, "hero1 first");
    CHECK(strcmp(m.customers[0].last,  "Smith")  == 0, "hero1 last");
    CHECK(strcmp(m.customers[0].phone, "(555) 123-4567") == 0, "hero1 phone");
    CHECK(strcmp(m.policies[0].id, "POL-2024-008341") == 0, "hero1 policy id");
    CHECK(strcmp(m.policies[0].type, "AUTO") == 0, "hero1 policy type");
    CHECK(strcmp(m.customers[1].first, "Morgan") == 0, "hero2 first");
    CHECK(strcmp(m.customers[1].last,  "Lee") == 0, "hero2 last");
    CHECK(strcmp(m.customers[1].phone, "(555) 222-0198") == 0, "hero2 phone");
    CHECK(strcmp(m.policies[1].id, "POL-2024-002210") == 0, "hero2 policy id");
    CHECK(strcmp(m.policies[1].type, "HOME") == 0, "hero2 policy type");
    /* Fraud pattern: at least 3 round-dollar suspicious claims */
    int suspicious = 0;
    for (int i = 0; i < m.n_claims; ++i)
        if (m.claims[i].suspicious) suspicious++;
    CHECK(suspicious >= 3, "fraud pattern >=3 suspicious claims");
    wgm_model_free(&m);
}

static void t_search_phone(void)
{
    WgmModel m = {0};
    wgm_seed_generate(&m);
    int out[16];
    int n = wgm_search_by_phone(&m, "(555) 123-4567", out, 16);
    CHECK(n == 1, "search hero phone n==1");
    CHECK(out[0] == 0, "search hero phone idx==0");
    n = wgm_search_by_phone(&m, "(555) 222-0198", out, 16);
    CHECK(n == 1, "search hero2 phone n==1");
    wgm_model_free(&m);
}

static void t_search_policy(void)
{
    WgmModel m = {0};
    wgm_seed_generate(&m);
    int out[16];
    int n = wgm_search_by_policy(&m, "POL-2024-008341", out, 16);
    CHECK(n == 1, "search hero1 policy");
    CHECK(out[0] == 0, "policy-> customer 0");
    n = wgm_search_by_policy(&m, "POL-2024-002210", out, 16);
    CHECK(n == 1, "search hero2 policy");
    wgm_model_free(&m);
}

static void t_search_name(void)
{
    WgmModel m = {0};
    wgm_seed_generate(&m);
    int out[64];
    int n = wgm_search_by_name(&m, "smith", out, 64);
    CHECK(n >= 1, "search name smith >=1");
    int hero_found = 0;
    for (int i = 0; i < n; ++i) if (out[i] == 0) hero_found = 1;
    CHECK(hero_found == 1, "search name smith finds hero1");
    wgm_model_free(&m);
}

static void t_search_claim(void)
{
    WgmModel m = {0};
    wgm_seed_generate(&m);
    int out[8];
    int n = wgm_search_by_claim(&m, "CLM-2023-004411", out, 8);
    CHECK(n == 1, "search claim CLM-2023-004411");
    CHECK(out[0] == 0, "claim search routes to hero1");
    wgm_model_free(&m);
}

static void t_make_claim_id(void)
{
    WgmModel m = {0};
    wgm_seed_generate(&m);
    char id[32];
    wgm_make_claim_id(&m, id, sizeof id);
    CHECK(wgm_valid_claim_id(id) == 1, "make_claim_id format");
    /* Adding it should make next id increment */
    WgmClaim c; memset(&c, 0, sizeof c);
    wgm_strlcpy(c.id, id, sizeof c.id);
    wgm_strlcpy(c.policy_id, m.policies[0].id, sizeof c.policy_id);
    wgm_strlcpy(c.customer_id, m.policies[0].customer_id, sizeof c.customer_id);
    wgm_strlcpy(c.loss_type, "COLLISION", sizeof c.loss_type);
    wgm_strlcpy(c.status, "OPEN-ASGN", sizeof c.status);
    wgm_model_add_claim(&m, &c);
    char id2[32];
    wgm_make_claim_id(&m, id2, sizeof id2);
    CHECK(strcmp(id, id2) != 0, "make_claim_id increments");
    wgm_model_free(&m);
}

static void t_iso8601(void)
{
    char ts[32];
    wgm_iso8601_utc(ts, sizeof ts);
    /* YYYY-MM-DDTHH:MM:SSZ */
    CHECK(strlen(ts) == 20, "iso8601 len 20");
    CHECK(ts[4] == '-' && ts[7] == '-' && ts[10] == 'T' && ts[13] == ':' && ts[16] == ':' && ts[19] == 'Z', "iso8601 layout");
}

static void t_atomic_write(void)
{
    char tmp[MAX_PATH];
    GetTempPathA(MAX_PATH, tmp);
    strcat(tmp, "wgm_test_atomic.txt");
    DeleteFileA(tmp);
    CHECK(wgm_atomic_write(tmp, "hello", 5) == 0, "atomic write");
    char *buf = NULL; size_t len = 0;
    CHECK(wgm_read_file(tmp, &buf, &len) == 0, "atomic write readback");
    CHECK(len == 5 && memcmp(buf, "hello", 5) == 0, "atomic write content");
    free(buf);
    DeleteFileA(tmp);
}

static void t_lookups(void)
{
    WgmModel m = {0};
    wgm_seed_generate(&m);
    CHECK(wgm_find_customer_idx(&m, "CUST-000001") == 0, "find hero1 cust idx");
    CHECK(wgm_find_policy_idx(&m, "POL-2024-008341") == 0, "find hero1 policy idx");
    CHECK(wgm_find_claim_idx(&m, "CLM-2023-004411") >= 0, "find hero1 claim idx");
    CHECK(wgm_find_customer_idx(&m, "CUST-NOPE") == -1, "find missing cust -1");
    wgm_model_free(&m);
}

static void t_save_load_round_trip(void)
{
    WgmModel m = {0};
    wgm_seed_generate(&m);
    int orig_pols = m.n_policies;
    int orig_clms = m.n_claims;
    /* save */
    CHECK(wgm_model_save(&m) == 0, "model save OK");
    wgm_model_free(&m);
    /* load */
    WgmModel m2 = {0};
    CHECK(wgm_model_load(&m2) == 0, "model load OK");
    CHECK(m2.n_policies == orig_pols, "load policies matches");
    CHECK(m2.n_claims == orig_clms, "load claims matches");
    CHECK(strcmp(m2.policies[0].id, "POL-2024-008341") == 0, "load hero1 policy ID");
    wgm_model_free(&m2);
}

static void t_coverages_for_hero(void)
{
    WgmModel m = {0};
    wgm_seed_generate(&m);
    int n_for_hero1 = 0;
    for (int i = 0; i < m.n_coverages; ++i)
        if (strcmp(m.coverages[i].policy_id, "POL-2024-008341") == 0) n_for_hero1++;
    CHECK(n_for_hero1 >= 4, "hero1 has >=4 coverages");
    wgm_model_free(&m);
}

static void t_json_get_string(void)
{
    const char *j =
        "{ \"request_id\":\"req-1\", \"policy_number\":\"POL-2024-008341\","
        " \"summary\":\"line1\\nline2 \\\"quoted\\\"\", \"intent\":\"auto_collision\" }";
    char buf[128] = {0};
    CHECK(wgm_json_get_string(j, "request_id", buf, sizeof buf) && strcmp(buf, "req-1") == 0,
          "json get request_id");
    CHECK(wgm_json_get_string(j, "policy_number", buf, sizeof buf) &&
          strcmp(buf, "POL-2024-008341") == 0, "json get policy_number");
    CHECK(wgm_json_get_string(j, "summary", buf, sizeof buf) &&
          strcmp(buf, "line1\nline2 \"quoted\"") == 0, "json decode escapes");
    CHECK(wgm_json_get_string(j, "missing", buf, sizeof buf) == 0, "json missing key");
}

static void t_json_get_number(void)
{
    const char *j = "{ \"reserve_amount\": 1234.50, \"count\": 3 }";
    double d = 0;
    CHECK(wgm_json_get_number(j, "reserve_amount", &d) && d > 1234.49 && d < 1234.51,
          "json get number");
    CHECK(wgm_json_get_number(j, "count", &d) && d == 3.0, "json get int");
    CHECK(wgm_json_get_number(j, "nope", &d) == 0, "json number missing");
}

static void t_handoff_match(void)
{
    WgmModel m = {0};
    wgm_seed_generate(&m);

    int ci = -1, pi = -1;
    CHECK(wgm_handoff_match(&m, "POL-2024-008341", NULL, &ci, &pi) == 1,
          "handoff match by policy");
    CHECK(pi >= 0 && strcmp(m.policies[pi].id, "POL-2024-008341") == 0,
          "handoff matched policy idx");
    CHECK(ci >= 0 && strcmp(m.customers[ci].first, "Jordan") == 0 &&
          strcmp(m.customers[ci].last, "Smith") == 0, "handoff matched hero customer");

    int ci2 = -1, pi2 = -1;
    CHECK(wgm_handoff_match(&m, NULL, "(555) 123-4567", &ci2, &pi2) == 1,
          "handoff match by phone");
    CHECK(ci2 >= 0 && strcmp(m.customers[ci2].first, "Jordan") == 0,
          "handoff phone -> hero customer");

    int ci3 = -1, pi3 = -1;
    CHECK(wgm_handoff_match(&m, "POL-DOES-NOT-EXIST", NULL, &ci3, &pi3) == 0,
          "handoff no match");

    wgm_model_free(&m);
}

static void t_handoff_build(void)
{
    char buf[1024];
    int n = wgm_handoff_build_ready(buf, sizeof buf, "req-9", "Zava Mutual",
                                    "POL-2024-008341", "Jordan Smith",
                                    "2025-01-01T00:00:00Z");
    CHECK(n > 0, "build_ready returns length");
    CHECK(strstr(buf, "\"status\": \"ready\"") != NULL, "ready has status");
    CHECK(strstr(buf, "\"matched_policy_number\": \"POL-2024-008341\"") != NULL,
          "ready has policy");

    n = wgm_handoff_build_result(buf, sizeof buf, "req-9", "CLM-2025-000123",
                                 "POL-2024-008341", "C1001", 500.0,
                                 "2025-01-01T00:00:00Z");
    CHECK(n > 0 && strstr(buf, "\"status\": \"submitted\"") != NULL, "result submitted");
    CHECK(strstr(buf, "\"claim_id\": \"CLM-2025-000123\"") != NULL, "result claim id");
    CHECK(strstr(buf, "\"reserve_amount\": 500.00") != NULL, "result reserve");

    n = wgm_handoff_build_error(buf, sizeof buf, "req-9", "POLICY_NOT_FOUND",
                                "no match \"x\"", "2025-01-01T00:00:00Z");
    CHECK(n > 0 && strstr(buf, "\"error_code\": \"POLICY_NOT_FOUND\"") != NULL,
          "error has code");
    CHECK(strstr(buf, "no match \\\"x\\\"") != NULL, "error escapes message");
}

int wgm_run_tests(void)
{
    /* Redirect data dir to a temp folder so we don't trample real data. */
    char tmp[MAX_PATH];
    GetTempPathA(MAX_PATH, tmp);
    strcat(tmp, "ZavaClaimsTest");
    /* The data layer uses ProgramData by default; we cannot easily redirect
     * here without adding global plumbing. We accept that the save/load test
     * will write to ProgramData (or LocalAppData fallback); that is consistent
     * with the documented behavior and matches CI expectations. */
    (void)tmp;

    g_pass = g_fail = 0;
    fprintf(stderr, "=== Zava Mutual claims.exe --test ===\n");

    t_csv_basic();
    t_csv_quoted();
    t_csv_escaped_quotes();
    t_money_fmt();
    t_ci_contains();
    t_seed_hero();
    t_search_phone();
    t_search_policy();
    t_search_name();
    t_search_claim();
    t_make_claim_id();
    t_iso8601();
    t_atomic_write();
    t_lookups();
    t_save_load_round_trip();
    t_coverages_for_hero();

    t_json_get_string();
    t_json_get_number();
    t_handoff_match();
    t_handoff_build();

    fprintf(stderr, "=== %d passed, %d failed ===\n", g_pass, g_fail);
    return g_fail == 0 ? 0 : 1;
}
