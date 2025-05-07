import type { JSONContent } from "@tiptap/core";

const urlRegex =
  /https?:\/\/(www\.)?[-a-zA-Z0-9@:%._\+~#=]{1,256}\.[a-zA-Z0-9()]{1,6}\b([-a-zA-Z0-9()@:%_\+.~#?&//=]*)/gi;
/**
 * return an array of urls found in a plain text string
 * */
export function collectLinks(content = "") {
  return content?.match(urlRegex) ?? [];
}

export function tiptapJsontoString(jsonContent: JSONContent | string) {
  if (typeof jsonContent === "string") jsonContent = JSON.parse(jsonContent);
  if (typeof jsonContent !== "object" || !jsonContent.content) return undefined;

  return jsonContent.content.flatMap((c) => {
    let text: string = "";
    if (!c.content) {
      return;
    }
    for (const obj of c.content) {
      if (obj.type === "text") text += obj.text + "\n";
    }
    return text;
  })[0];
}

// import { convertUrlsToLinks } from "$lib/urlUtils";
// const html = convertUrlsToLinks(content)
