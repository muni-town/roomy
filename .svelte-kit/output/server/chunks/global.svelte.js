import "@automerge/automerge-repo-storage-indexeddb";
import "@atproto/api";
import "@automerge/automerge";
import "base32-encode";
import "base32-decode";
import "@atproto/oauth-client-browser";
import "@atproto/lexicon";
import "@jsr/roomy-chat__router/client";
import "typescript-event-target";
import "tweetnacl";
import "underscore";
function b64ToUint6(nChr) {
  return nChr > 64 && nChr < 91 ? nChr - 65 : nChr > 96 && nChr < 123 ? nChr - 71 : nChr > 47 && nChr < 58 ? nChr + 4 : nChr === 43 ? 62 : nChr === 47 ? 63 : 0;
}
function base64ToUint8(sBase64, nBlocksSize) {
  const sB64Enc = sBase64.replace(/[^A-Za-z0-9+/]/g, "");
  const nInLen = sB64Enc.length;
  const nOutLen = nBlocksSize ? Math.ceil((nInLen * 3 + 1 >> 2) / nBlocksSize) * nBlocksSize : nInLen * 3 + 1 >> 2;
  const taBytes = new Uint8Array(nOutLen);
  let nMod3;
  let nMod4;
  let nUint24 = 0;
  let nOutIdx = 0;
  for (let nInIdx = 0; nInIdx < nInLen; nInIdx++) {
    nMod4 = nInIdx & 3;
    nUint24 |= b64ToUint6(sB64Enc.charCodeAt(nInIdx)) << 6 * (3 - nMod4);
    if (nMod4 === 3 || nInLen - nInIdx === 1) {
      nMod3 = 0;
      while (nMod3 < 3 && nOutIdx < nOutLen) {
        taBytes[nOutIdx] = nUint24 >>> (16 >>> nMod3 & 24) & 255;
        nMod3++;
        nOutIdx++;
      }
      nUint24 = 0;
    }
  }
  return taBytes;
}
function toUint8(b64) {
  let bin = atob(b64);
  let len = bin.length;
  let bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = bin.charCodeAt(i);
  }
  return bytes;
}
const decode64 = typeof atob === "function" ? toUint8 : base64ToUint8;
decode64("hW9KgzjSqVIAiQECBGluaXQQd5D41AGHQhuGDhr51HVZoAGs/tAOrbrldko7PS/zxy9t9bCjgZJ10mjeVUTST27L3wcBAwMDEwIjCUADQwJWAgcVDCEDIwI0AUIDVgKAAQJ+AAF+AQACAX7io+q8BozdOX4AAX8AAgd+A2RtcwZzcGFjZXN+AAECAQJ+AAICAAIAAQ==");
decode64("hW9KgwYD4rcAmAEBBGluaXQBDGJBSOp7Mwq9tlEZt6xK3eWRDtFF2cb5X+EqGKwG+qYGAQIDAhMCIwZAAlYCBxUsIQIjBjQBQgZWBoABAn8AfwF/BX+54YW9Bn8Afwd7C2Rlc2NyaXB0aW9uCG1lc3NhZ2VzBG5hbWUHdGhyZWFkcwh0aW1lbGluZQUAewIBfgMBBXsBAAEAAn0GAAYCAAUAAA==");
decode64("hW9Kg99//uwAgQICEGB1CQqVREfTkD3OSlrqJD4EaW5pdAHe1K/LDPMniEGXeuqmSLltJN3EdaafpeJ98Mpeun9sNAcBAwMDEwMjCUADQwJWAgcVYCEIIww0AUIMVg2AAQJ+AQB+AQB+CAJ+5LCkvQaYzCR+AAF/AAIHdgZhZG1pbnMJYXZhdGFyVXJsCmNhdGVnb3JpZXMIY2hhbm5lbHMLZGVzY3JpcHRpb24IbWVzc2FnZXMKbW9kZXJhdG9ycwRuYW1lDHNpZGViYXJJdGVtcwd0aHJlYWRzfwAFAX8AAwF/CgJ9eX8Fegd9f3wKfgIBAgB6AQACAQIAfgAGAgB/BgIAfwYCAAoAAQ==");
let g = {
  catalog: void 0,
  dms: {},
  spaces: {},
  router: void 0,
  routerConnections: {},
  peer: void 0
};
globalThis.g = g;
export {
  g
};
