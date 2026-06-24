/*
 * csv.h - minimal RFC 4180 CSV parser. Returns rows of fields.
 */
#ifndef WGM_CSV_H
#define WGM_CSV_H

#include <stddef.h>

typedef struct WgmCsvRow {
    char **fields;
    int nfields;
} WgmCsvRow;

typedef struct WgmCsv {
    WgmCsvRow *rows;
    int nrows;
    char *buf;       /* owned allocation backing all field pointers */
} WgmCsv;

/* Parse buffer of length len. Caller must call wgm_csv_free. */
int wgm_csv_parse(const char *text, size_t len, WgmCsv *out);
void wgm_csv_free(WgmCsv *csv);

#endif /* WGM_CSV_H */
