/*
 * csv.c - RFC 4180 CSV parser with double-quoted fields.
 *
 * The parser mutates a copy of the input buffer in place: each field is a
 * NUL-terminated substring within that buffer; rows store pointer arrays.
 */
#include "csv.h"

#include <stdlib.h>
#include <string.h>

static int push_field(WgmCsvRow *row, int *cap, char *field)
{
    if (row->nfields >= *cap) {
        int nc = (*cap == 0) ? 8 : (*cap * 2);
        char **p = (char **)realloc(row->fields, (size_t)nc * sizeof(char *));
        if (!p) return -1;
        row->fields = p;
        *cap = nc;
    }
    row->fields[row->nfields++] = field;
    return 0;
}

static int push_row(WgmCsv *csv, int *cap, WgmCsvRow row)
{
    if (csv->nrows >= *cap) {
        int nc = (*cap == 0) ? 16 : (*cap * 2);
        WgmCsvRow *p = (WgmCsvRow *)realloc(csv->rows, (size_t)nc * sizeof(WgmCsvRow));
        if (!p) return -1;
        csv->rows = p;
        *cap = nc;
    }
    csv->rows[csv->nrows++] = row;
    return 0;
}

int wgm_csv_parse(const char *text, size_t len, WgmCsv *out)
{
    memset(out, 0, sizeof *out);
    out->buf = (char *)malloc(len + 1);
    if (!out->buf) return -1;
    memcpy(out->buf, text, len);
    out->buf[len] = '\0';

    int row_cap = 0;
    WgmCsvRow row = {0};
    int field_cap = 0;

    char *p = out->buf;
    char *end = out->buf + len;
    char *fstart = p;
    int in_quotes = 0;
    char *wptr = p; /* write pointer for in-place unescape */
    fstart = wptr;

    while (p < end) {
        char c = *p;
        if (in_quotes) {
            if (c == '"') {
                if (p + 1 < end && p[1] == '"') {
                    *wptr++ = '"';
                    p += 2;
                    continue;
                }
                in_quotes = 0;
                p++;
                continue;
            }
            *wptr++ = c;
            p++;
        } else {
            if (c == '"' && wptr == fstart) {
                in_quotes = 1;
                p++;
                continue;
            }
            if (c == ',') {
                *wptr = '\0';
                if (push_field(&row, &field_cap, fstart) != 0) goto fail;
                p++;
                wptr++;
                fstart = wptr;
                continue;
            }
            if (c == '\r' || c == '\n') {
                *wptr = '\0';
                if (push_field(&row, &field_cap, fstart) != 0) goto fail;
                if (push_row(out, &row_cap, row) != 0) goto fail;
                row.fields = NULL;
                row.nfields = 0;
                field_cap = 0;
                /* Swallow CRLF */
                if (c == '\r' && p + 1 < end && p[1] == '\n')
                    p++;
                p++;
                wptr++;
                fstart = wptr;
                continue;
            }
            *wptr++ = c;
            p++;
        }
    }
    /* Final field/row if no trailing newline */
    if (wptr != fstart || row.nfields > 0) {
        *wptr = '\0';
        if (push_field(&row, &field_cap, fstart) != 0) goto fail;
        if (push_row(out, &row_cap, row) != 0) goto fail;
    } else {
        free(row.fields);
    }
    return 0;

fail:
    free(row.fields);
    wgm_csv_free(out);
    return -1;
}

void wgm_csv_free(WgmCsv *csv)
{
    if (!csv) return;
    for (int i = 0; i < csv->nrows; ++i)
        free(csv->rows[i].fields);
    free(csv->rows);
    free(csv->buf);
    memset(csv, 0, sizeof *csv);
}
