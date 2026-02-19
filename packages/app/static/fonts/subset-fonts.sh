#!/bin/bash
# subset-fonts.sh
# Usage: ./subset-fonts.sh
# Requires: pip install fonttools brotli
# 
# This is what was used to reduce filesize for Google Sans Flex fonts. Need to revisit for i18n
# Requires putting the input files in a 'static' subdirectory

set -e

INPUT_DIR="./static"
OUTPUT_DIR="./subset"

# Latin + Latin Extended + common symbols/punctuation
# Mirrors what Google Fonts ships for latin + latin-ext
UNICODES="\
U+0000-00FF,\
U+0100-017F,\
U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,\
U+2000-206F,\
U+2070-209F,\
U+20A0-20CF,\
U+2100-214F,\
U+2190-21FF,\
U+2200-22FF,\
U+2074,U+20AC,U+2122,U+2212,U+2215,\
U+FEFF,U+FFFD"

LAYOUT_FEATURES="kern,liga,clig,calt,ccmp,locl,mark,mkmk"

mkdir -p "$OUTPUT_DIR"

for ttf in "$INPUT_DIR"/GoogleSansFlex_9pt-*.ttf "$INPUT_DIR"/GoogleSansFlex_36pt-*.ttf; do
  filename=$(basename "$ttf" .ttf)
  output="$OUTPUT_DIR/${filename}.woff2"

  echo "Subsetting $filename..."

  pyftsubset "$ttf" \
    --output-file="$output" \
    --flavor=woff2 \
    --unicodes="$UNICODES" \
    --layout-features="$LAYOUT_FEATURES" \
    --no-hinting \
    --desubroutinize

  original=$(wc -c < "$ttf")
  subsetted=$(wc -c < "$output")
  savings=$(( (original - subsetted) * 100 / original ))
  echo "  $original → $subsetted bytes ($savings% smaller)"
done

echo "Done. Subsetted fonts in $OUTPUT_DIR"