# one time setup:
  1. create co.list with discord bot and add "everyone" as "writeOnly", save id

# running discord bot:
  1. subscribe to co.list with specified id
  2. each item should be have 
    - space id
    - discord guild id
    - status (requested, failed, running)
  3. any time a new item is added/changed:
    - if status is "requested" check if space and guild exist and can be accessed (if not, set status to "failed")
    - if status is "running" check if event listeners in both directions exist
      - if not add event listeners (for message events in discord and for messages in all roomy channels)
  4. any time a message is received in discord:
    - find a channel in the space that has the same name as the discord channel
    - if found, send the message to the space
  5. any time a message is sent to a space:
    - find a channel in discord that has the same name as the space channel
    - if found, send the message to the discord channel
    
# on client:
  1. add bot to discord server
  2. in space settings, enter your discord guild id and click "enable discord bridge"
    -> will add a co.list item with status "requested"
    -> wait for co.list item status to change
      -> if failed show error message
      -> if running, show success message


# other todos:
  - move schema and utils to seperate package