/*
 * seed.h - deterministic seed-data generation.
 *
 * The seed generator does not read any embedded RCDATA. Hero records are
 * inserted first to guarantee they exist exactly; bulk records follow with a
 * fixed PRNG seed for reproducibility.
 */
#ifndef WGM_SEED_H
#define WGM_SEED_H

#include "data.h"

int wgm_seed_generate(WgmModel *m);

#endif /* WGM_SEED_H */
