import type { JSONContent } from "@tiptap/core";
import { linkify } from "$lib/linkify";
/**
 * return an array of urls found in a plain text string
 * */
export function collectLinks(content = "") {
  if (!linkify.pretest(content)) return false;
  let links = linkify.match(content)?.map((m) => m.url);

  //dedupe
  links = [...new Set(links).values()];
  return links;
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
