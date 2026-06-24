/*
 * handoff.h - Agent365 / orchestrator file-drop handoff support.
 *
 * When launched with --prefill / --handoff-dir / --ready-file / --result the app
 * consumes a prefill document written by the orchestrator, primes the matching
 * customer/policy in the UI, and writes ready/result/error JSON files that the
 * orchestrator polls. See INTEGRATION.md for the authoritative contract.
 */
#ifndef WGM_HANDOFF_H
#define WGM_HANDOFF_H

#include <stddef.h>
#include "app.h"
#include "data.h"

/* Resolve handoff paths from CLI flags and set app->handoff_active. */
void wgm_handoff_configure(WgmApp *app, int argc, char **argv);

/* Read+parse the prefill into the app->hf_* fields.
 * Returns 0 OK, -1 if the file could not be read, -2 if required fields missing. */
int wgm_handoff_load_prefill(WgmApp *app);

/* UI-free match by policy number (preferred) then caller phone.
 * Fills *cust_idx and *pol_idx (either may be -1). Returns 1 if a customer
 * was matched, 0 otherwise. */
int wgm_handoff_match(const WgmModel *m, const char *policy_number,
                      const char *caller_phone, int *cust_idx, int *pol_idx);

/* Pure JSON builders (headless-testable). Return the number of bytes written
 * (excluding the NUL), or 0 on overflow. */
int wgm_handoff_build_ready(char *buf, size_t cap, const char *request_id,
                            const char *window_title, const char *policy_number,
                            const char *customer_name, const char *iso_ts);
int wgm_handoff_build_result(char *buf, size_t cap, const char *request_id,
                             const char *claim_id, const char *policy_number,
                             const char *agent_id, double reserve_amount,
                             const char *iso_ts);
int wgm_handoff_build_error(char *buf, size_t cap, const char *request_id,
                            const char *error_code, const char *message,
                            const char *iso_ts);

/* Match + prime the UI + write ready.json (or error POLICY_NOT_FOUND). */
int wgm_handoff_prime_and_ready(WgmApp *app);

/* Write result.json after a successful submit. */
int wgm_handoff_write_result(WgmApp *app);

/* Write error.json with the given code/message. */
int wgm_handoff_write_error(WgmApp *app, const char *code, const char *message);

#endif /* WGM_HANDOFF_H */
