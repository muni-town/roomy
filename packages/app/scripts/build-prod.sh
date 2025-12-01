#!/bin/bash

npm run build-web-app

target_url=${OAUTH_HOST:-https://roomy.space}

echo "Generating OAuth client configuration..."
echo "OAuth Host URL: $OAUTH_HOST"
echo "Target URL: $target_url"

# Add oauth-client configuration
oauth_config="{
  \"client_id\": \"$target_url/oauth-client-metadata.json\",
  \"client_name\": \"Roomy\",
  \"client_uri\": \"$target_url\",
  \"logo_uri\": \"$target_url/favicon.png\",
  \"tos_uri\": \"$target_url\",
  \"policy_uri\": \"$target_url\",
  \"redirect_uris\": [\"$target_url/oauth/callback\"],
  \"scope\": \"atproto blob:*/* repo:space.roomy.upload rpc:app.bsky.actor.getProfile?aud=did:web:api.bsky.app%23bsky_appview rpc:chat.bsky.actor.deleteAccount?aud=did:web:api.bsky.chat%23bsky_chat rpc:chat.bsky.actor.exportAccountData?aud=did:web:api.bsky.chat%23bsky_chat rpc:chat.bsky.convo.acceptConvo?aud=did:web:api.bsky.chat%23bsky_chat rpc:chat.bsky.convo.deleteMessageForSelf?aud=did:web:api.bsky.chat%23bsky_chat rpc:chat.bsky.convo.getConvoAvailability?aud=did:web:api.bsky.chat%23bsky_chat rpc:chat.bsky.convo.getConvoForMembers?aud=did:web:api.bsky.chat%23bsky_chat rpc:chat.bsky.convo.getConvo?aud=did:web:api.bsky.chat%23bsky_chat rpc:chat.bsky.convo.getLog?aud=did:web:api.bsky.chat%23bsky_chat rpc:chat.bsky.convo.leaveConvo?aud=did:web:api.bsky.chat%23bsky_chat rpc:chat.bsky.convo.listConvos?aud=did:web:api.bsky.chat%23bsky_chat rpc:chat.bsky.convo.muteConvo?aud=did:web:api.bsky.chat%23bsky_chat rpc:chat.bsky.convo.removeReaction?aud=did:web:api.bsky.chat%23bsky_chat rpc:chat.bsky.convo.sendMessageBatch?aud=did:web:api.bsky.chat%23bsky_chat rpc:chat.bsky.convo.unmuteConvo?aud=did:web:api.bsky.chat%23bsky_chat rpc:chat.bsky.convo.addReaction?aud=did:web:api.bsky.chat%23bsky_chat rpc:chat.bsky.convo.updateAllRead?aud=did:web:api.bsky.chat%23bsky_chat rpc:chat.bsky.convo.updateRead?aud=did:web:api.bsky.chat%23bsky_chat rpc:chat.bsky.moderation.getActorMetadata?aud=did:web:api.bsky.chat%23bsky_chat rpc:chat.bsky.moderation.getMessageContext?aud=did:web:api.bsky.chat%23bsky_chat rpc:chat.bsky.moderation.updateActorAccess?aud=did:web:api.bsky.chat%23bsky_chat repo:space.roomy.stream repo:space.roomy.stream.handle rpc:town.muni.leaf.authenticate?aud=*\",
  \"grant_types\": [\"authorization_code\", \"refresh_token\"],
  \"response_types\": [\"code\"],
  \"token_endpoint_auth_method\": \"none\",
  \"application_type\": \"web\",
  \"dpop_bound_access_tokens\": true
}"

# Log for debugging
echo "$oauth_config"

# Write to 'oauth-client-metadata.json' file for clean OAuth login page
echo "$oauth_config" > build/oauth-client-metadata.json