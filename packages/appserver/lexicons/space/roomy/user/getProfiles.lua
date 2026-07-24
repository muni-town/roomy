-- space.roomy.user.getProfiles query script for HappyView.
--
-- Accepts `actors` (comma-separated DIDs) or `did` (single DID), queries the
-- space.roomy.user.profile collection for each, and returns
-- { profiles = [...] } with blob refs converted to atblob://<did>/<cid> URIs.
--
-- Uploaded via: POST /admin/scripts with id "xrpc.query:space.roomy.user.getProfiles"

function handle()
  -- Parse DIDs from `actors` (comma-separated) or `did` (single).
  local dids = {}
  if params.actors then
    for did in string.gmatch(params.actors, "[^,]+") do
      table.insert(dids, did)
    end
  elseif params.did then
    table.insert(dids, params.did)
  end

  if #dids == 0 then
    return { profiles = toarray({}) }
  end

  local profiles = {}
  for _, did in ipairs(dids) do
    local result = db.query({
      collection = collection,
      did = did,
      limit = 1,
    })
    if result.records and #result.records > 0 then
      local rec = result.records[1]
      -- Extract DID from URI: at://<did>/space.roomy.user.profile/self
      local record_did = string.match(rec.uri, "^at://([^/]+)/") or did
      local profile = { did = record_did }

      -- String fields pass through directly.
      if rec.displayName then profile.displayName = rec.displayName end
      if rec.description then profile.description = rec.description end
      if rec.pronouns then profile.pronouns = rec.pronouns end
      if rec.website then profile.website = rec.website end

      -- Convert blob refs to atblob://<did>/<cid> strings.
      -- Raw JSON shape: { $type = "blob", ref = { $link = "bafy..." }, ... }
      if type(rec.avatar) == "table" and rec.avatar.ref and rec.avatar.ref["$link"] then
        profile.avatar = "atblob://" .. record_did .. "/" .. rec.avatar.ref["$link"]
      elseif type(rec.avatar) == "string" then
        profile.avatar = rec.avatar
      end

      if type(rec.banner) == "table" and rec.banner.ref and rec.banner.ref["$link"] then
        profile.banner = "atblob://" .. record_did .. "/" .. rec.banner.ref["$link"]
      elseif type(rec.banner) == "string" then
        profile.banner = rec.banner
      end

      table.insert(profiles, profile)
    end
  end

  return { profiles = toarray(profiles) }
end