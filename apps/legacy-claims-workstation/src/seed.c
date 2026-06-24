/*
 * seed.c - deterministic synthetic data generator.
 *
 * Uses an internal LCG seeded with a fixed constant so the same demo replays
 * identically every run. Three hero records are inserted up front:
 *   - Jordan Smith   (555) 123-4567  POL-2024-008341  AUTO COLLISION
 *   - Morgan Lee     (555) 222-0198  POL-2024-002210  HOME WATER
 *   - Fraud pattern  three round-dollar liability claims on POL-2024-000777
 */
#include "seed.h"
#include "util.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/* ---- Deterministic LCG (not a security RNG; do not rely on its statistics) ---- */
static unsigned long g_rng = 0x12345678UL;

static unsigned long lcg(void)
{
    g_rng = g_rng * 1103515245UL + 12345UL;
    return g_rng & 0x7fffffffUL;
}

static int randr(int lo, int hi)
{
    if (hi <= lo) return lo;
    return lo + (int)(lcg() % (unsigned long)(hi - lo + 1));
}

static const char *FIRST_NAMES[] = {
    "James","Mary","Robert","Patricia","Michael","Jennifer","William","Linda",
    "David","Elizabeth","Richard","Barbara","Joseph","Susan","Thomas","Jessica",
    "Charles","Sarah","Christopher","Karen","Daniel","Nancy","Matthew","Lisa",
    "Anthony","Betty","Donald","Helen","Mark","Sandra","Paul","Donna","Steven",
    "Carol","Andrew","Ruth","Kenneth","Sharon","George","Michelle","Joshua",
    "Laura","Kevin","Sarah","Brian","Kimberly","Edward","Deborah","Ronald",
    "Jessica","Timothy","Shirley","Jason","Cynthia","Jeffrey","Angela",
    "Ryan","Melissa","Gary","Brenda","Nicholas","Amy","Eric","Rebecca",
    "Jonathan","Virginia","Stephen","Kathleen","Larry","Pamela","Justin","Martha",
    "Scott","Debra","Brandon","Amanda","Frank","Stephanie","Benjamin","Carolyn",
    "Gregory","Christine","Samuel","Marie","Raymond","Janet","Patrick","Catherine",
    "Alexander","Frances","Jack","Ann","Dennis","Joyce","Jerry","Diane",
    "Tyler","Alice","Aaron","Julie","Henry","Heather","Adam","Teresa",
    "Douglas","Doris","Nathan","Gloria","Peter","Evelyn","Zachary","Cheryl"
};
#define FIRST_N (int)(sizeof FIRST_NAMES / sizeof FIRST_NAMES[0])

static const char *LAST_NAMES[] = {
    "Smith","Johnson","Williams","Brown","Jones","Garcia","Miller","Davis",
    "Rodriguez","Martinez","Hernandez","Lopez","Gonzalez","Wilson","Anderson",
    "Thomas","Taylor","Moore","Jackson","Martin","Lee","Perez","Thompson",
    "White","Harris","Sanchez","Clark","Ramirez","Lewis","Robinson","Walker",
    "Young","Allen","King","Wright","Scott","Torres","Nguyen","Hill","Flores",
    "Green","Adams","Nelson","Baker","Hall","Rivera","Campbell","Mitchell",
    "Carter","Roberts","Gomez","Phillips","Evans","Turner","Diaz","Parker",
    "Cruz","Edwards","Collins","Reyes","Stewart","Morris","Morales","Murphy",
    "Cook","Rogers","Gutierrez","Ortiz","Morgan","Cooper","Peterson","Bailey",
    "Reed","Kelly","Howard","Ramos","Kim","Cox","Ward","Richardson","Watson",
    "Brooks","Chavez","Wood","James","Bennett","Gray","Mendoza","Ruiz",
    "Hughes","Price","Alvarez","Castillo","Sanders","Patel","Myers","Long",
    "Ross","Foster","Jimenez"
};
#define LAST_N (int)(sizeof LAST_NAMES / sizeof LAST_NAMES[0])

static const char *STREETS[] = {
    "Maple Ave","Oak St","Pine Rd","Elm Dr","Cedar Ln","Hickory Way",
    "1st St","2nd Ave","3rd Blvd","Main St","Lakeview Dr","Sunset Blvd",
    "Hillcrest Ave","Riverside Dr","Park Pl","Highland Rd","Forest Ave",
    "Meadow Ln","Spring St","Washington Ave","Lincoln St","Jefferson Pl"
};
#define STREETS_N (int)(sizeof STREETS / sizeof STREETS[0])

static const char *CITIES[][2] = {
    {"Springfield","IL"},{"Riverside","CA"},{"Portland","OR"},{"Albany","NY"},
    {"Aurora","CO"},{"Salem","OR"},{"Madison","WI"},{"Boise","ID"},
    {"Cheyenne","WY"},{"Tacoma","WA"},{"Boulder","CO"},{"Reno","NV"},
    {"Tucson","AZ"},{"Frederick","MD"},{"Augusta","ME"},{"Concord","NH"},
    {"Helena","MT"},{"Bismarck","ND"},{"Pierre","SD"},{"Lincoln","NE"},
    {"Topeka","KS"},{"Jefferson City","MO"},{"Frankfort","KY"},{"Nashville","TN"},
    {"Birmingham","AL"},{"Jackson","MS"},{"Baton Rouge","LA"},{"Little Rock","AR"},
    {"Oklahoma City","OK"},{"Austin","TX"},{"Santa Fe","NM"},{"Phoenix","AZ"},
    {"Sacramento","CA"},{"Carson City","NV"},{"Olympia","WA"},{"Juneau","AK"},
    {"Honolulu","HI"},{"Hartford","CT"},{"Providence","RI"},{"Montpelier","VT"},
    {"Trenton","NJ"},{"Dover","DE"},{"Charleston","WV"},{"Richmond","VA"},
    {"Raleigh","NC"},{"Columbia","SC"},{"Atlanta","GA"},{"Tallahassee","FL"},
    {"Lansing","MI"},{"Indianapolis","IN"},{"Columbus","OH"},{"Harrisburg","PA"},
    {"Annapolis","MD"},{"Des Moines","IA"},{"Saint Paul","MN"},{"Salt Lake City","UT"}
};
#define CITIES_N (int)(sizeof CITIES / sizeof CITIES[0])

static const char *LOSS_TYPES[]    = {"COLLISION","THEFT","FIRE","WATER","WIND","LIABILITY","GLASS","VANDALISM"};
static const char *POLICY_TYPES[]  = {"AUTO","HOME","RENTERS","UMBRELLA"};
static const char *AGENT_IDS[]     = {"C1001","C1002","C1003","M2001"};
static const char *ADJ_IDS[]       = {"ADJ-NA-0142","ADJ-NA-0207","ADJ-WC-0419","ADJ-SE-0033","ADJ-MW-0185","ADJ-NE-0721"};
static const char *FIELD_OFFICES[] = {"FO-WST-014","FO-EST-002","FO-MID-007","FO-SOU-021","FO-NWE-009"};
static const char *STATUSES[]      = {"OPEN-ASGN","PEND-REVW","CLSD-PAID","CLSD-DEN","RSRV-INCR","SUBR-OPEN"};
static const char *BILLING[]       = {"CURRENT","PAST DUE","PAID IN FULL"};

static void mkphone(char *buf, size_t cap, int npa, int nxx, int xxxx)
{
    _snprintf(buf, cap, "(%03d) %03d-%04d", npa, nxx, xxxx);
    buf[cap - 1] = '\0';
}

static void mkdate(char *buf, size_t cap, int yyyy, int mm, int dd)
{
    _snprintf(buf, cap, "%02d/%02d/%04d", mm, dd, yyyy);
    buf[cap - 1] = '\0';
}

static void mkts(char *buf, size_t cap, int yyyy, int mm, int dd, int hh, int mi, int ss)
{
    _snprintf(buf, cap, "%04d-%02d-%02dT%02d:%02d:%02dZ", yyyy, mm, dd, hh, mi, ss);
    buf[cap - 1] = '\0';
}

static int days_in_month(int year, int m)
{
    static const int d[] = {31,28,31,30,31,30,31,31,30,31,30,31};
    int v = d[m - 1];
    if (m == 2) {
        int leap = ((year % 4 == 0) && (year % 100 != 0)) || (year % 400 == 0);
        if (leap) v = 29;
    }
    return v;
}

static const char *pick_first(void)      { return FIRST_NAMES[randr(0, FIRST_N - 1)]; }
static const char *pick_last(void)       { return LAST_NAMES[randr(0, LAST_N - 1)];   }
static const char *pick_street(void)     { return STREETS[randr(0, STREETS_N - 1)];   }
static const char *pick_status(void)     { return STATUSES[randr(0, (int)(sizeof STATUSES / sizeof *STATUSES) - 1)]; }
static const char *pick_billing(void)    { return BILLING[randr(0, (int)(sizeof BILLING / sizeof *BILLING) - 1)]; }
static const char *pick_agent(void)      { return AGENT_IDS[randr(0, (int)(sizeof AGENT_IDS / sizeof *AGENT_IDS) - 1)]; }
static const char *pick_adj(void)        { return ADJ_IDS[randr(0, (int)(sizeof ADJ_IDS / sizeof *ADJ_IDS) - 1)]; }
static const char *pick_fo(void)         { return FIELD_OFFICES[randr(0, (int)(sizeof FIELD_OFFICES / sizeof *FIELD_OFFICES) - 1)]; }

static void compose_address(WgmCustomer *c)
{
    int num = randr(100, 9998);
    const char *st = pick_street();
    int ci = randr(0, CITIES_N - 1);
    _snprintf(c->addr, sizeof c->addr, "%d %s", num, st);
    wgm_strlcpy(c->city, CITIES[ci][0], sizeof c->city);
    wgm_strlcpy(c->state, CITIES[ci][1], sizeof c->state);
    _snprintf(c->zip, sizeof c->zip, "%05d", randr(10000, 99950));
}

static void seed_customer(WgmCustomer *c, int idx)
{
    _snprintf(c->id, sizeof c->id, "CUST-%06d", 1000 + idx);
    wgm_strlcpy(c->first, pick_first(), sizeof c->first);
    wgm_strlcpy(c->last,  pick_last(),  sizeof c->last);
    int npa = randr(201, 989);
    if (npa == 555) npa = 556;
    mkphone(c->phone, sizeof c->phone, npa, randr(200, 989), randr(0, 9999));
    compose_address(c);
    mkdate(c->dob, sizeof c->dob, randr(1942, 1992), randr(1, 12), randr(1, 28));
    _snprintf(c->email, sizeof c->email, "%s.%s@example.com", c->first, c->last);
    for (char *p = c->email; *p; ++p)
        if (*p >= 'A' && *p <= 'Z') *p += 32;
}

static double bounded_premium(const char *type)
{
    if (strcmp(type, "AUTO") == 0)     return 120.0 * randr(8, 28);
    if (strcmp(type, "HOME") == 0)     return 180.0 * randr(8, 30);
    if (strcmp(type, "RENTERS") == 0)  return 30.0  * randr(6, 18);
    return 90.0 * randr(8, 24);
}

static void seed_policy(WgmPolicy *p, const WgmCustomer *cust, int idx)
{
    _snprintf(p->id, sizeof p->id, "POL-2024-%06d", 1000 + idx);
    wgm_strlcpy(p->customer_id, cust->id, sizeof p->customer_id);
    wgm_strlcpy(p->type, POLICY_TYPES[randr(0, 3)], sizeof p->type);
    wgm_strlcpy(p->status, "ACTIVE", sizeof p->status);
    mkdate(p->effective,  sizeof p->effective,  2024, 1, 1);
    mkdate(p->expiration, sizeof p->expiration, 2024, 12, 31);
    p->premium = bounded_premium(p->type);
    wgm_strlcpy(p->billing, pick_billing(), sizeof p->billing);
    wgm_strlcpy(p->agent, pick_agent(), sizeof p->agent);
    wgm_strlcpy(p->field_office, pick_fo(), sizeof p->field_office);
}

static void seed_coverages_for(WgmModel *m, const WgmPolicy *p)
{
    /* Simple per-policy coverages keyed by type. */
    struct { const char *code; const char *descr; double lim; double ded; } cov_auto[] = {
        {"COLL-500",  "Collision Coverage",         50000, 500},
        {"COMP-250",  "Comprehensive",              50000, 250},
        {"LIAB-100/300","Bodily Injury Liability",  300000,   0},
        {"PD-50",     "Property Damage Liability",  50000,    0},
        {"MED-5",     "Medical Payments",            5000,    0},
        {"UM-100",    "Uninsured Motorist",        100000,    0}
    };
    struct { const char *code; const char *descr; double lim; double ded; } cov_home[] = {
        {"DWELL-A",   "Coverage A - Dwelling",     249000, 1000},
        {"OTHER-B",   "Coverage B - Other Structs", 24900, 1000},
        {"PERS-C",    "Coverage C - Personal Property", 124500, 1000},
        {"LOU-D",     "Coverage D - Loss of Use",   49800,    0},
        {"PLIA-E",    "Coverage E - Personal Liab",300000,    0},
        {"MEDP-F",    "Coverage F - Medical Pmts",   5000,    0}
    };
    struct { const char *code; const char *descr; double lim; double ded; } cov_rent[] = {
        {"PERS-C",    "Personal Property",          30000,  500},
        {"PLIA-E",    "Personal Liability",        100000,    0},
        {"LOU-D",     "Loss of Use",                 5000,    0}
    };
    struct { const char *code; const char *descr; double lim; double ded; } cov_umb[] = {
        {"UMB-1M",    "Umbrella Liability",       1000000,    0}
    };

    if (strcmp(p->type, "AUTO") == 0) {
        int n = (int)(sizeof cov_auto / sizeof *cov_auto);
        for (int i = 0; i < n; ++i) {
            WgmCoverage c; memset(&c, 0, sizeof c);
            wgm_strlcpy(c.policy_id, p->id, sizeof c.policy_id);
            wgm_strlcpy(c.code, cov_auto[i].code, sizeof c.code);
            wgm_strlcpy(c.descr, cov_auto[i].descr, sizeof c.descr);
            c.limit = cov_auto[i].lim; c.deductible = cov_auto[i].ded;
            m->coverages = (WgmCoverage *)realloc(m->coverages, (size_t)(m->n_coverages + 1) * sizeof(WgmCoverage));
            m->coverages[m->n_coverages++] = c;
        }
    } else if (strcmp(p->type, "HOME") == 0) {
        int n = (int)(sizeof cov_home / sizeof *cov_home);
        for (int i = 0; i < n; ++i) {
            WgmCoverage c; memset(&c, 0, sizeof c);
            wgm_strlcpy(c.policy_id, p->id, sizeof c.policy_id);
            wgm_strlcpy(c.code, cov_home[i].code, sizeof c.code);
            wgm_strlcpy(c.descr, cov_home[i].descr, sizeof c.descr);
            c.limit = cov_home[i].lim; c.deductible = cov_home[i].ded;
            m->coverages = (WgmCoverage *)realloc(m->coverages, (size_t)(m->n_coverages + 1) * sizeof(WgmCoverage));
            m->coverages[m->n_coverages++] = c;
        }
    } else if (strcmp(p->type, "RENTERS") == 0) {
        int n = (int)(sizeof cov_rent / sizeof *cov_rent);
        for (int i = 0; i < n; ++i) {
            WgmCoverage c; memset(&c, 0, sizeof c);
            wgm_strlcpy(c.policy_id, p->id, sizeof c.policy_id);
            wgm_strlcpy(c.code, cov_rent[i].code, sizeof c.code);
            wgm_strlcpy(c.descr, cov_rent[i].descr, sizeof c.descr);
            c.limit = cov_rent[i].lim; c.deductible = cov_rent[i].ded;
            m->coverages = (WgmCoverage *)realloc(m->coverages, (size_t)(m->n_coverages + 1) * sizeof(WgmCoverage));
            m->coverages[m->n_coverages++] = c;
        }
    } else {
        int n = (int)(sizeof cov_umb / sizeof *cov_umb);
        for (int i = 0; i < n; ++i) {
            WgmCoverage c; memset(&c, 0, sizeof c);
            wgm_strlcpy(c.policy_id, p->id, sizeof c.policy_id);
            wgm_strlcpy(c.code, cov_umb[i].code, sizeof c.code);
            wgm_strlcpy(c.descr, cov_umb[i].descr, sizeof c.descr);
            c.limit = cov_umb[i].lim; c.deductible = cov_umb[i].ded;
            m->coverages = (WgmCoverage *)realloc(m->coverages, (size_t)(m->n_coverages + 1) * sizeof(WgmCoverage));
            m->coverages[m->n_coverages++] = c;
        }
    }
}

static void narrative_for(char *dst, size_t cap, const char *loss, double reserve, const char *adj)
{
    char money[32];
    wgm_format_money(money, sizeof money, reserve);
    if (strcmp(loss, "COLLISION") == 0) {
        _snprintf(dst, cap,
            "CLMT REPORTS COLLISION AT INTRSXN. NO INJ REPORTED. POL VEH DAMAGED "
            "RR BUMPER & TAILGATE. OTHER VEH F&S WITH MINOR FRONT DAMAGE. "
            "NO POLICE RPT FILED. ADJ ASSGN: %s. RSRV SET: %s. SUBR-OPEN.",
            adj, money);
    } else if (strcmp(loss, "THEFT") == 0) {
        _snprintf(dst, cap,
            "CLMT REPORTS VEH STOLEN FROM RES DRIVEWAY OVERNIGHT. POLICE RPT "
            "FILED. VIN REC. ADJ ASSGN: %s. RSRV SET: %s.",
            adj, money);
    } else if (strcmp(loss, "FIRE") == 0) {
        _snprintf(dst, cap,
            "DWELLING FIRE - KITCHEN ORIGIN. FD RESPONDED. STRUCT DAMAGE TO "
            "KIT/DR. NO INJ. ADJ ASSGN: %s. RSRV SET: %s.",
            adj, money);
    } else if (strcmp(loss, "WATER") == 0) {
        _snprintf(dst, cap,
            "WATER DMG - BURST SUPPLY LINE UNDER KIT SINK. STANDING WATER "
            "OBSERVED. MITIGATION CONTRACTOR ENGAGED. ADJ ASSGN: %s. "
            "RSRV SET: %s.",
            adj, money);
    } else if (strcmp(loss, "WIND") == 0) {
        _snprintf(dst, cap,
            "WIND EVENT - ROOF SHINGLES DISLODGED. INTERIOR LEAK FOLLOWED. "
            "TARPED PENDING REPAIR. ADJ ASSGN: %s. RSRV SET: %s.",
            adj, money);
    } else if (strcmp(loss, "LIABILITY") == 0) {
        _snprintf(dst, cap,
            "TP ALLEGES SLIP/FALL ON PREMISES. NO MED RECORDS PROVIDED. "
            "INVESTIGATION OPEN. ADJ ASSGN: %s. RSRV SET: %s.",
            adj, money);
    } else if (strcmp(loss, "GLASS") == 0) {
        _snprintf(dst, cap,
            "WINDSHIELD CHIP/CRACK - REPAIRABLE PER VENDOR. APPT SCHEDULED. "
            "ADJ ASSGN: %s. RSRV SET: %s.",
            adj, money);
    } else {
        _snprintf(dst, cap,
            "GENERIC LOSS RPT - DETAILS PENDING. ADJ ASSGN: %s. RSRV SET: %s.",
            adj, money);
    }
    dst[cap - 1] = '\0';
}

static void seed_claim(WgmModel *m, const WgmPolicy *p, int idx, const char *loss_override)
{
    WgmClaim c; memset(&c, 0, sizeof c);
    int yr = 1998 + randr(0, 26); /* 1998..2024 */
    _snprintf(c.id, sizeof c.id, "CLM-%04d-%06d", yr, 100 + idx);
    wgm_strlcpy(c.policy_id,  p->id,          sizeof c.policy_id);
    wgm_strlcpy(c.customer_id, p->customer_id, sizeof c.customer_id);
    wgm_strlcpy(c.loss_type, loss_override ? loss_override : LOSS_TYPES[randr(0, (int)(sizeof LOSS_TYPES / sizeof *LOSS_TYPES) - 1)], sizeof c.loss_type);
    wgm_strlcpy(c.status, pick_status(), sizeof c.status);
    int mm = randr(1, 12);
    int dd = randr(1, days_in_month(yr, mm));
    mkdate(c.loss_date, sizeof c.loss_date, yr, mm, dd);
    _snprintf(c.loss_time, sizeof c.loss_time, "%02d:%02d", randr(0,23), randr(0,59));
    _snprintf(c.loss_location, sizeof c.loss_location, "%d %s", randr(100,9998), pick_street());
    c.reserve = (double)randr(8, 800) * 25.0; /* $200 - $20,000 */
    wgm_strlcpy(c.adjuster, pick_adj(), sizeof c.adjuster);
    wgm_strlcpy(c.field_office, p->field_office, sizeof c.field_office);
    wgm_strlcpy(c.opened_by, pick_agent(), sizeof c.opened_by);
    mkts(c.opened_on, sizeof c.opened_on, yr, mm, dd, randr(8, 17), randr(0,59), randr(0,59));
    wgm_strlcpy(c.modified_by, c.opened_by, sizeof c.modified_by);
    wgm_strlcpy(c.modified_on, c.opened_on, sizeof c.modified_on);
    narrative_for(c.narrative, sizeof c.narrative, c.loss_type, c.reserve, c.adjuster);
    m->claims = (WgmClaim *)realloc(m->claims, (size_t)(m->n_claims + 1) * sizeof(WgmClaim));
    m->claims[m->n_claims++] = c;
}

static void seed_activity(WgmModel *m, const WgmClaim *c, const char *text)
{
    WgmActivity a; memset(&a, 0, sizeof a);
    wgm_strlcpy(a.claim_id, c->id, sizeof a.claim_id);
    wgm_strlcpy(a.who, c->opened_by, sizeof a.who);
    wgm_strlcpy(a.ts, c->opened_on, sizeof a.ts);
    wgm_strlcpy(a.text, text, sizeof a.text);
    m->activities = (WgmActivity *)realloc(m->activities, (size_t)(m->n_activities + 1) * sizeof(WgmActivity));
    m->activities[m->n_activities++] = a;
}

int wgm_seed_generate(WgmModel *m)
{
    memset(m, 0, sizeof *m);
    g_rng = 0x12345678UL;

    /* -------- HERO RECORDS (must exist exactly) -------- */
    /* 1. Jordan Smith - auto collision */
    m->customers = (WgmCustomer *)calloc(1, sizeof(WgmCustomer));
    m->n_customers = 1;
    WgmCustomer *cs = &m->customers[0];
    wgm_strlcpy(cs->id, "CUST-000001", sizeof cs->id);
    wgm_strlcpy(cs->first, "Jordan", sizeof cs->first);
    wgm_strlcpy(cs->last,  "Smith",  sizeof cs->last);
    wgm_strlcpy(cs->phone, "(555) 123-4567", sizeof cs->phone);
    wgm_strlcpy(cs->addr,  "412 Maple Ave",  sizeof cs->addr);
    wgm_strlcpy(cs->city,  "Springfield",    sizeof cs->city);
    wgm_strlcpy(cs->state, "IL",             sizeof cs->state);
    wgm_strlcpy(cs->zip,   "62704",          sizeof cs->zip);
    wgm_strlcpy(cs->dob,   "06/14/1981",     sizeof cs->dob);
    wgm_strlcpy(cs->email, "jordan.smith@example.com", sizeof cs->email);

    /* 2. Morgan Lee - home water */
    m->customers = (WgmCustomer *)realloc(m->customers, 2 * sizeof(WgmCustomer));
    m->n_customers = 2;
    WgmCustomer *cs2 = &m->customers[1];
    memset(cs2, 0, sizeof *cs2);
    wgm_strlcpy(cs2->id, "CUST-000002", sizeof cs2->id);
    wgm_strlcpy(cs2->first, "Morgan", sizeof cs2->first);
    wgm_strlcpy(cs2->last,  "Lee",    sizeof cs2->last);
    wgm_strlcpy(cs2->phone, "(555) 222-0198", sizeof cs2->phone);
    wgm_strlcpy(cs2->addr,  "88 Oak St",      sizeof cs2->addr);
    wgm_strlcpy(cs2->city,  "Madison",        sizeof cs2->city);
    wgm_strlcpy(cs2->state, "WI",             sizeof cs2->state);
    wgm_strlcpy(cs2->zip,   "53703",          sizeof cs2->zip);
    wgm_strlcpy(cs2->dob,   "11/02/1977",     sizeof cs2->dob);
    wgm_strlcpy(cs2->email, "morgan.lee@example.com", sizeof cs2->email);

    /* 3. Fraud-pattern subject */
    m->customers = (WgmCustomer *)realloc(m->customers, 3 * sizeof(WgmCustomer));
    m->n_customers = 3;
    WgmCustomer *cs3 = &m->customers[2];
    memset(cs3, 0, sizeof *cs3);
    wgm_strlcpy(cs3->id, "CUST-000003", sizeof cs3->id);
    wgm_strlcpy(cs3->first, "Dakota", sizeof cs3->first);
    wgm_strlcpy(cs3->last,  "Quinn",  sizeof cs3->last);
    wgm_strlcpy(cs3->phone, "(555) 777-1212", sizeof cs3->phone);
    wgm_strlcpy(cs3->addr,  "1 Pine Rd",      sizeof cs3->addr);
    wgm_strlcpy(cs3->city,  "Phoenix",        sizeof cs3->city);
    wgm_strlcpy(cs3->state, "AZ",             sizeof cs3->state);
    wgm_strlcpy(cs3->zip,   "85003",          sizeof cs3->zip);
    wgm_strlcpy(cs3->dob,   "03/22/1969",     sizeof cs3->dob);
    wgm_strlcpy(cs3->email, "dakota.quinn@example.com", sizeof cs3->email);

    /* Hero policies */
    m->policies = (WgmPolicy *)calloc(3, sizeof(WgmPolicy));
    m->n_policies = 3;
    WgmPolicy *p1 = &m->policies[0];
    wgm_strlcpy(p1->id, "POL-2024-008341", sizeof p1->id);
    wgm_strlcpy(p1->customer_id, "CUST-000001", sizeof p1->customer_id);
    wgm_strlcpy(p1->type, "AUTO", sizeof p1->type);
    wgm_strlcpy(p1->status, "ACTIVE", sizeof p1->status);
    wgm_strlcpy(p1->effective, "01/01/2024", sizeof p1->effective);
    wgm_strlcpy(p1->expiration, "12/31/2024", sizeof p1->expiration);
    p1->premium = 1284.00;
    wgm_strlcpy(p1->billing, "CURRENT", sizeof p1->billing);
    wgm_strlcpy(p1->agent, "C1001", sizeof p1->agent);
    wgm_strlcpy(p1->field_office, "FO-WST-014", sizeof p1->field_office);

    WgmPolicy *p2 = &m->policies[1];
    wgm_strlcpy(p2->id, "POL-2024-002210", sizeof p2->id);
    wgm_strlcpy(p2->customer_id, "CUST-000002", sizeof p2->customer_id);
    wgm_strlcpy(p2->type, "HOME", sizeof p2->type);
    wgm_strlcpy(p2->status, "ACTIVE", sizeof p2->status);
    wgm_strlcpy(p2->effective, "01/01/2024", sizeof p2->effective);
    wgm_strlcpy(p2->expiration, "12/31/2024", sizeof p2->expiration);
    p2->premium = 1980.00;
    wgm_strlcpy(p2->billing, "PAID IN FULL", sizeof p2->billing);
    wgm_strlcpy(p2->agent, "C1002", sizeof p2->agent);
    wgm_strlcpy(p2->field_office, "FO-MID-007", sizeof p2->field_office);

    WgmPolicy *p3 = &m->policies[2];
    wgm_strlcpy(p3->id, "POL-2024-000777", sizeof p3->id);
    wgm_strlcpy(p3->customer_id, "CUST-000003", sizeof p3->customer_id);
    wgm_strlcpy(p3->type, "AUTO", sizeof p3->type);
    wgm_strlcpy(p3->status, "ACTIVE", sizeof p3->status);
    wgm_strlcpy(p3->effective, "01/01/2024", sizeof p3->effective);
    wgm_strlcpy(p3->expiration, "12/31/2024", sizeof p3->expiration);
    p3->premium = 1100.00;
    wgm_strlcpy(p3->billing, "PAST DUE", sizeof p3->billing);
    wgm_strlcpy(p3->agent, "C1003", sizeof p3->agent);
    wgm_strlcpy(p3->field_office, "FO-SOU-021", sizeof p3->field_office);

    /* Coverages for the three hero policies */
    seed_coverages_for(m, p1);
    seed_coverages_for(m, p2);
    seed_coverages_for(m, p3);

    /* Prior claim on Jordan's policy so the Claims tab isn't empty for the hero */
    {
        WgmClaim c; memset(&c, 0, sizeof c);
        wgm_strlcpy(c.id, "CLM-2023-004411", sizeof c.id);
        wgm_strlcpy(c.policy_id, p1->id, sizeof c.policy_id);
        wgm_strlcpy(c.customer_id, p1->customer_id, sizeof c.customer_id);
        wgm_strlcpy(c.loss_type, "GLASS", sizeof c.loss_type);
        wgm_strlcpy(c.status, "CLSD-PAID", sizeof c.status);
        wgm_strlcpy(c.loss_date, "08/14/2023", sizeof c.loss_date);
        wgm_strlcpy(c.loss_time, "09:12", sizeof c.loss_time);
        wgm_strlcpy(c.loss_location, "I-55 NB MM 99", sizeof c.loss_location);
        c.reserve = 425.00;
        wgm_strlcpy(c.adjuster, "ADJ-NA-0142", sizeof c.adjuster);
        wgm_strlcpy(c.field_office, "FO-WST-014", sizeof c.field_office);
        wgm_strlcpy(c.opened_by, "C1001", sizeof c.opened_by);
        wgm_strlcpy(c.opened_on, "2023-08-14T13:45:12Z", sizeof c.opened_on);
        wgm_strlcpy(c.modified_by, "C1001", sizeof c.modified_by);
        wgm_strlcpy(c.modified_on, "2023-08-19T10:00:01Z", sizeof c.modified_on);
        narrative_for(c.narrative, sizeof c.narrative, "GLASS", 425.00, "ADJ-NA-0142");
        m->claims = (WgmClaim *)realloc(m->claims, (size_t)(m->n_claims + 1) * sizeof(WgmClaim));
        m->claims[m->n_claims++] = c;

        seed_activity(m, &c, "OPENED. INTAKE BY C1001. ADJ ASSGN ADJ-NA-0142.");
        seed_activity(m, &c, "GLASS VENDOR DISPATCHED 08/15. REPAIR COMPLETED 08/18.");
        seed_activity(m, &c, "RESERVE PAID. STATUS CLSD-PAID.");
    }

    /* Three suspicious round-dollar liability claims on POL-2024-000777 */
    static const char *FRAUD_LOCS[] = {
        "100 Pine Rd Lobby",
        "200 Pine Rd Stairwell",
        "300 Pine Rd Parking"
    };
    static const double FRAUD_AMTS[] = { 5000.00, 5000.00, 5000.00 };
    static const char *FRAUD_DATES[] = { "02/04/2024", "02/22/2024", "03/15/2024" };
    static const char *FRAUD_IDS[]   = {
        "CLM-2024-007001","CLM-2024-007002","CLM-2024-007003"
    };
    for (int i = 0; i < 3; ++i) {
        WgmClaim c; memset(&c, 0, sizeof c);
        wgm_strlcpy(c.id, FRAUD_IDS[i], sizeof c.id);
        wgm_strlcpy(c.policy_id, p3->id, sizeof c.policy_id);
        wgm_strlcpy(c.customer_id, p3->customer_id, sizeof c.customer_id);
        wgm_strlcpy(c.loss_type, "LIABILITY", sizeof c.loss_type);
        wgm_strlcpy(c.status, "PEND-REVW", sizeof c.status);
        wgm_strlcpy(c.loss_date, FRAUD_DATES[i], sizeof c.loss_date);
        wgm_strlcpy(c.loss_time, "12:00", sizeof c.loss_time);
        wgm_strlcpy(c.loss_location, FRAUD_LOCS[i], sizeof c.loss_location);
        c.reserve = FRAUD_AMTS[i];
        c.suspicious = 1;
        wgm_strlcpy(c.adjuster, "ADJ-WC-0419", sizeof c.adjuster);
        wgm_strlcpy(c.field_office, "FO-SOU-021", sizeof c.field_office);
        wgm_strlcpy(c.opened_by, "C1003", sizeof c.opened_by);
        wgm_strlcpy(c.opened_on, "2024-03-20T16:00:00Z", sizeof c.opened_on);
        wgm_strlcpy(c.modified_by, "M2001", sizeof c.modified_by);
        wgm_strlcpy(c.modified_on, "2024-04-02T11:11:11Z", sizeof c.modified_on);
        _snprintf(c.narrative, sizeof c.narrative,
            "TP ALLEGES SLIP/FALL AT %s. ROUND-DOLLAR LOSS RSRV $5,000.00. "
            "PATTERN FLAGGED. SIU REVIEW PEND. ADJ ASSGN: ADJ-WC-0419.",
            FRAUD_LOCS[i]);
        m->claims = (WgmClaim *)realloc(m->claims, (size_t)(m->n_claims + 1) * sizeof(WgmClaim));
        m->claims[m->n_claims++] = c;

        seed_activity(m, &c, "OPENED PEND-REVW. SIU NOTIFIED.");
        seed_activity(m, &c, "PATTERN MATCHED PRIOR ROUND-DOLLAR FILING.");

        WgmNote nt; memset(&nt, 0, sizeof nt);
        wgm_strlcpy(nt.claim_id, c.id, sizeof nt.claim_id);
        wgm_strlcpy(nt.severity, "CRITICAL", sizeof nt.severity);
        wgm_strlcpy(nt.who, "M2001", sizeof nt.who);
        wgm_strlcpy(nt.ts, c.modified_on, sizeof nt.ts);
        wgm_strlcpy(nt.text, "ROUND-DOLLAR PATTERN; ESCALATE SIU.", sizeof nt.text);
        m->notes = (WgmNote *)realloc(m->notes, (size_t)(m->n_notes + 1) * sizeof(WgmNote));
        m->notes[m->n_notes++] = nt;
    }

    /* -------- BULK GENERATION -------- */
    /* Bring customer count up to 100 (3 hero + 97 generated). */
    int target_customers = 100;
    int start_cust = m->n_customers;
    m->customers = (WgmCustomer *)realloc(m->customers,
                                          (size_t)target_customers * sizeof(WgmCustomer));
    for (int i = start_cust; i < target_customers; ++i) {
        memset(&m->customers[i], 0, sizeof(WgmCustomer));
        seed_customer(&m->customers[i], i);
    }
    m->n_customers = target_customers;

    /* Bring policies to 140 (3 hero + 137 new). */
    int target_policies = 140;
    int start_pol = m->n_policies;
    m->policies = (WgmPolicy *)realloc(m->policies,
                                       (size_t)target_policies * sizeof(WgmPolicy));
    for (int i = start_pol; i < target_policies; ++i) {
        memset(&m->policies[i], 0, sizeof(WgmPolicy));
        WgmCustomer *cust = &m->customers[i % m->n_customers];
        seed_policy(&m->policies[i], cust, i);
        seed_coverages_for(m, &m->policies[i]);
    }
    m->n_policies = target_policies;

    /* Bring claims to ~220 (4 hero/seeded + ~216). */
    int target_claims = 220;
    int existing = m->n_claims;
    for (int i = existing; i < target_claims; ++i) {
        WgmPolicy *p = &m->policies[i % m->n_policies];
        seed_claim(m, p, i, NULL);
        seed_activity(m, &m->claims[m->n_claims - 1], "OPENED. INTAKE BY AGENT.");
        seed_activity(m, &m->claims[m->n_claims - 1], "ADJ ASSGN.");
        if ((i % 4) == 0)
            seed_activity(m, &m->claims[m->n_claims - 1], "RESERVE SET.");
        if ((i % 5) == 0)
            seed_activity(m, &m->claims[m->n_claims - 1], "STATUS UPDATED.");
    }

    /* Ensure ~900 activities total by padding generic entries. */
    while (m->n_activities < 900 && m->n_claims > 0) {
        const WgmClaim *c = &m->claims[m->n_activities % m->n_claims];
        seed_activity(m, c, "RTN STATUS PING.");
    }

    return 0;
}
