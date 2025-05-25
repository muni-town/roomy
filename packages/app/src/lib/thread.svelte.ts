import type { Message } from "./schema";

export let threads = $state({selected: [] as Message[]});
export function selectMessage(message: Message) {
    threads.selected = [...threads.selected, message];
}

