# Roomy Architecture

## Bootstrapping flow

1. user logs in with atproto
2. roomy requests `space.roomy.space.personal.dev/self` from user's PDS
3. that record contains the ID for a 'personal stream', which roomy then requests a subscription to from the leaf server
4. roomy gets a backfill of events for the personal stream
5. some of those are space join events, and when we materialise them, roomy requests subscriptions for the corresponding streams
6. roomy gets backfill events for each of these streams
7. roomy materialises state for each space
