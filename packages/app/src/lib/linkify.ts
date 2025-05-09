import linkifyit from "linkify-it";
// Adds common tlds (dns institute ranking + common atproto apps) to fuzzy detection. default list already includes country zones and:
// * - biz|com|edu|gov|net|org|pro|web|xxx|aero|asia|coop|info|museum|name|shop|рф
const TLDS = [
  "xyz",
  "io",
  "biz",
  "online",
  "club",
  "site",
  "live",
  "tech",
  "space",
  "website",
  "life",
  "supply",
  "app",
  "fun",
  "social",
  "dev",
  "lol",
  "blue",
];
export const linkify = new linkifyit().tlds(TLDS, true);
