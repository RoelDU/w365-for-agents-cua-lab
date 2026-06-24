/* json.c - see json.h. */
#include "json.h"

#include <ctype.h>
#include <stdlib.h>
#include <string.h>

static const char *skip_ws(const char *p)
{
    while (*p == ' ' || *p == '\t' || *p == '\n' || *p == '\r') p++;
    return p;
}

/* Return a pointer just past the ':' of the "key": pair, or NULL. */
static const char *find_key(const char *json, const char *key)
{
    size_t klen = strlen(key);
    const char *p = json;
    while ((p = strchr(p, '"')) != NULL) {
        const char *ks = p + 1;
        if (strncmp(ks, key, klen) == 0 && ks[klen] == '"') {
            const char *after = skip_ws(ks + klen + 1);
            if (*after == ':') return after + 1;
        }
        p = ks; /* advance past this opening quote and keep scanning */
    }
    return NULL;
}

int wgm_json_get_string(const char *json, const char *key, char *dst, size_t cap)
{
    if (!json || !key || !dst || cap == 0) return 0;
    dst[0] = '\0';

    const char *p = find_key(json, key);
    if (!p) return 0;
    p = skip_ws(p);
    if (*p != '"') return 0;
    p++;

    size_t i = 0;
    while (*p && *p != '"') {
        char c = *p++;
        if (c == '\\' && *p) {
            char e = *p++;
            switch (e) {
                case 'n': c = '\n'; break;
                case 't': c = '\t'; break;
                case 'r': c = '\r'; break;
                case 'b': c = '\b'; break;
                case 'f': c = '\f'; break;
                case '/': c = '/';  break;
                case '"': c = '"';  break;
                case '\\': c = '\\'; break;
                case 'u': {
                    if (isxdigit((unsigned char)p[0]) && isxdigit((unsigned char)p[1]) &&
                        isxdigit((unsigned char)p[2]) && isxdigit((unsigned char)p[3])) {
                        char hex[5] = { p[0], p[1], p[2], p[3], 0 };
                        unsigned int cp = (unsigned int)strtoul(hex, NULL, 16);
                        p += 4;
                        c = (cp < 0x80) ? (char)cp : '?';
                    } else {
                        c = '?';
                    }
                    break;
                }
                default: c = e; break;
            }
        }
        if (i + 1 < cap) dst[i++] = c;
    }
    dst[i] = '\0';
    return 1;
}

int wgm_json_get_number(const char *json, const char *key, double *out)
{
    if (!json || !key) return 0;
    const char *p = find_key(json, key);
    if (!p) return 0;
    p = skip_ws(p);
    char *end = NULL;
    double v = strtod(p, &end);
    if (end == p) return 0;
    if (out) *out = v;
    return 1;
}
