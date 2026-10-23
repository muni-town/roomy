/**
 * Normalize container MIME types to browser-compatible equivalents.
 *
 * QuickTime (.mov) and 3GPP containers are ISO Base Media File Format —
 * structurally identical to MP4. Browsers can demux and decode H.264/AAC
 * inside them but reject the non-MP4 MIME on both the `<source type>` hint
 * and the PDS-stored content-type. Normalizing at upload + display ensures
 * consistency.
 */
export function normalizeMimeType(mimeType: string): string {
  if (
    mimeType === "video/quicktime" ||
    mimeType === "video/x-quicktime" ||
    mimeType === "video/3gpp" ||
    mimeType === "video/3gpp2"
  ) {
    return "video/mp4";
  }
  return mimeType;
}
