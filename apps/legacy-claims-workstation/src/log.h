/*
 * log.h - append-only line logger to claims.log.
 */
#ifndef WGM_LOG_H
#define WGM_LOG_H

void wgm_log_init(void);
void wgm_log(const char *fmt, ...);
void wgm_log_audit(const char *event, const char *who, const char *details);

#endif /* WGM_LOG_H */
