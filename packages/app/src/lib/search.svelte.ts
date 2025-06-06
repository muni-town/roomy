import { Index } from "flexsearch";
import { CoState } from "jazz-svelte";
import { Message } from "./jazz/schema";

let Search = $state({
    timeline: {} as Record<string, any>
});

export function addMessage(timelineId: string, messageId: string, messageBody: string) {
    if(!Search.timeline[timelineId]) {
        Search.timeline[timelineId] = new Index({
            tokenize: "forward",
            preset: "performance",
          });
    }
    console.log("adding to index", timelineId)
    let timeline = Search.timeline[timelineId]
    timeline.add(messageId, messageBody);
    // console.log(Search.timeline)
}

export function findMessages(timelineId: string, query: string) {
    let timeline = Search.timeline[timelineId]
    if(!timeline) {
        console.log("no timeline", timelineId)
        return [];
    }
    const results = timeline.search(query);
    let messages = [];
    for (const result of results) {
        messages.push(new CoState(Message, result));
    }
    console.log("found messages", messages)
    return messages;
}
    
