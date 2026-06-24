# Zava Mutual Claims Workstation — Makefile (MinGW-w64)
#
# Builds claims.exe in the project root. Compiles each .c in src/ and links
# with windres-processed resources from res/.

CC      ?= gcc
WINDRES ?= windres

CFLAGS_BASE = -std=c99 -O2 -Wall -Wextra -Wno-unused-parameter -Wno-format-truncation \
              -DUNICODE=0 -D_UNICODE=0 -D_WIN32_WINNT=0x0501 -DWINVER=0x0501

LDFLAGS_BASE = -mwindows -static -lcomctl32 -lcomdlg32 -lshell32 -lole32 -luuid -luser32 \
               -lgdi32 -ladvapi32 -lwinmm

SRC = src/main.c src/util.c src/log.c src/csv.c src/json.c src/data.c src/seed.c \
      src/handoff.c src/test.c src/setup.c src/ui_login.c src/ui_main.c src/ui_fnol.c

OBJ = $(SRC:.c=.o)
RES = res/claims.res

TARGET = claims.exe

all: $(TARGET)

$(TARGET): $(OBJ) $(RES)
	$(CC) -o $@ $(OBJ) $(RES) $(LDFLAGS_BASE)

%.o: %.c
	$(CC) $(CFLAGS_BASE) -Isrc -c $< -o $@

res/claims.res: res/claims.rc src/resource.h
	$(WINDRES) -O coff -I src -i res/claims.rc -o res/claims.res

clean:
	-del /Q src\*.o 2>nul || true
	-del /Q res\claims.res 2>nul || true
	-del /Q $(TARGET) 2>nul || true

.PHONY: all clean
