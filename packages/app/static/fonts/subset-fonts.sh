#!/bin/bash
# subset-fonts.sh
# Usage: ./subset-fonts.sh [hanken|hanken-full|sans-flex|all]
# Requires: pip install fonttools brotli
#
# Subsets and converts fonts to woff2.
# Run from: packages/app/static/fonts/
#
# Note: For i18n, revisit the UNICODES range.

set -e

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

convert_font() {
  local input="$1"
  local output="$2"
  local filename
  filename=$(basename "$input")

  echo "Converting $filename..."

  uvx --from fonttools --with brotli pyftsubset "$input" \
    --output-file="$output" \
    --flavor=woff2 \
    --unicodes="*" \
    --layout-features="*"

  local original converted savings
  original=$(wc -c < "$input")
  converted=$(wc -c < "$output")
  savings=$(( (original - converted) * 100 / original ))
  echo "  $original → $converted bytes ($savings% smaller)"
}

subset_font() {
  local input="$1"
  local output="$2"
  local filename
  filename=$(basename "$input")

  echo "Subsetting $filename..."

  uvx --from fonttools --with brotli pyftsubset "$input" \
    --output-file="$output" \
    --flavor=woff2 \
    --unicodes="$UNICODES" \
    --layout-features="$LAYOUT_FEATURES" \
    --no-hinting \
    --desubroutinize

  local original subsetted savings
  original=$(wc -c < "$input")
  subsetted=$(wc -c < "$output")
  savings=$(( (original - subsetted) * 100 / original ))
  echo "  $original → $subsetted bytes ($savings% smaller)"
}

convert_hanken() {
  echo "--- Hanken Grotesk (full convert) ---"
  local dir="./hanken-grotesk"
  for ttf in "$dir"/HankenGrotesk-*.ttf; do
    local filename
    filename=$(basename "$ttf" .ttf)
    convert_font "$ttf" "$dir/${filename}.woff2"
  done
}

subset_hanken() {
  echo "--- Hanken Grotesk (subsetted) ---"
  local dir="./hanken-grotesk"
  for ttf in "$dir"/HankenGrotesk-*.ttf; do
    local filename
    filename=$(basename "$ttf" .ttf)
    subset_font "$ttf" "$dir/${filename}.woff2"
  done
}

subset_sans_flex() {
  echo "--- Google Sans Flex ---"
  local input_dir="./sans-flex/static"
  local output_dir="./sans-flex"
  mkdir -p "$output_dir"
  for ttf in "$input_dir"/GoogleSansFlex_9pt-*.ttf "$input_dir"/GoogleSansFlex_36pt-*.ttf; do
    local filename
    filename=$(basename "$ttf" .ttf)
    subset_font "$ttf" "$output_dir/${filename}.woff2"
  done
}

TARGET="${1:-all}"

case "$TARGET" in
  hanken)         subset_hanken ;;
  hanken-full)    convert_hanken ;;
  sans-flex)      subset_sans_flex ;;
  all)            subset_hanken; subset_sans_flex ;;
  *)              echo "Usage: $0 [hanken|hanken-full|sans-flex|all]"; exit 1 ;;
esac

echo "Done."
