/*
 * util.h - common helpers: paths, time, atomic file writes, string utils.
 */
#ifndef WGM_UTIL_H
#define WGM_UTIL_H

#include <windows.h>
#include <stddef.h>

/* Returns 0 on success. dst must have at least MAX_PATH chars. */
int wgm_data_dir(char *dst, size_t cap);
int wgm_log_dir(char *dst, size_t cap);

/* Make sure dir exists (creates each segment as needed). Returns 0 on success. */
int wgm_ensure_dir(const char *path);

/* Atomic write: writes to path.tmp then renames to path. Returns 0 on success. */
int wgm_atomic_write(const char *path, const void *data, size_t len);

/* Read entire file into a freshly malloc'd buffer (caller frees). Returns 0 OK. */
int wgm_read_file(const char *path, char **out_buf, size_t *out_len);

/* ISO 8601 UTC timestamp like 2025-01-01T12:00:00Z. buf >= 24 chars. */
void wgm_iso8601_utc(char *buf, size_t cap);

/* Year as 4-digit string, current local time. */
int wgm_current_year(void);

/* Returns nonzero if path is writable (creates+removes a probe file). */
int wgm_dir_writable(const char *dir);

/* Safe strncpy that always NUL-terminates. */
void wgm_strlcpy(char *dst, const char *src, size_t cap);

/* Case-insensitive substring search; returns 1 if needle is in hay. */
int wgm_ci_contains(const char *hay, const char *needle);

/* Strip surrounding whitespace in place; returns the pointer. */
char *wgm_trim(char *s);

/* Format dollars as $1,234.56 into buf. */
void wgm_format_money(char *buf, size_t cap, double amount);

/* Read the persisted last-used agent ID into dst (cap >= 16). Returns 0 on
 * success, -1 if the file is missing or unreadable. */
int wgm_read_last_agent(char *dst, size_t cap);

/* Persist the agent ID atomically. Returns 0 on success. */
int wgm_write_last_agent(const char *agent_id);

/* Validate claim id CLM-YYYY-NNNNNN. Returns 1 if valid. */
int wgm_valid_claim_id(const char *id);

#endif /* WGM_UTIL_H */
