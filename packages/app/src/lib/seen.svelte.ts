let seen = $state({} as Record<string, any>);

function getMessages(){
    const seenLoaded = localStorage.getItem("seen")
    if(!seenLoaded) return []
    const messageIds = JSON.parse(seenLoaded)
    return messageIds
}
export function markSeen(messageId: string){
    seen[messageId] = true
    const messageIds = getMessages()
    messageIds.push(messageId)
    localStorage.setItem("seen", JSON.stringify(messageIds))
}
export function loadSeen(){
    const messageIds = getMessages()
    for(const messageId of messageIds){
        seen[messageId] = true
    }
}

export function hasSeen(messageId: string){
    return seen[messageId] ? true : false
}