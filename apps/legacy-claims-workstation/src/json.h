/*
 * json.h - tiny, dependency-free JSON value extractor.
 *
 * The legacy app only needs to read a handful of flat string/number fields out
 * of the small prefill document the orchestrator writes, so this deliberately
 * avoids a full JSON parser. It locates a "key": value pair anywhere in the
 * document and decodes a JSON string (with standard escapes) or a number.
 */
#ifndef WGM_JSON_H
#define WGM_JSON_H

#include <stddef.h>

/* Find "key" and copy its string value into dst (always NUL-terminated).
 * Returns 1 if a string value was found, 0 otherwise. */
int wgm_json_get_string(const char *json, const char *key, char *dst, size_t cap);

/* Find "key" and parse its numeric value into *out. Returns 1 if found. */
int wgm_json_get_number(const char *json, const char *key, double *out);

#endif /* WGM_JSON_H */
