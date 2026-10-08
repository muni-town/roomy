opensocial.community proposal
Introduction
An atmospheric community is a cross-modality, cross-app community that may have a web presence of its own as well. The “atmospheric” quality is that the same community identity, presence, and data is shared and remixed across these different applications.
Because atmospheric communities span multiple applications, applications need to have a shared understanding of what a community is. In other words, they need a standard for interfacing with these communities.
The permissioned data protocol gives us some of that, specifically spaces which is a new primitive that allows for the creation of essentially “mini permissioned atprotos”. However the protocol is very un-opinionated about their use. As such, it doesn’t include notions of membership, roles, community moderation, or application semantics.
An atmospheric community standard then builds on the permissioned data protocol and introduces a suite of lexicons (spaces, records, and methods) for modeling communities on top of the new data protocol.
There are three main pieces to this:
Roles & access
Presence & discoverability
Moderation
Design Posture
The standard defines the interface between the community and the application. In the same way that the permissioned data protocol ruthlessly avoids describing application semantics, the community standard should avoid describing both community governance and application semantics. This is not to underrate the importance of those, if anything it is to acknowledge just how important those are. By not standardizing them, we leave the freedom of implementation up to community stewards.

The standard should be as minimal as possible. Standards like this are hard to change. By making this as minimal as possible (but no more minimal), we give the best chance for experimentation, growth, and applicability across many different communities.

The standard should target the 90% case. Every community is different  and some have bespoke or idiosyncratic needs. Reflecting all of those needs in the standard will increase complexity for all implementers. Instead, we target the 90% case. Most communities should be able to be modeled directly on the atmospheric community standard. If a community needs something more complicated, it can still do whatever it wants, and then project its backend state onto the community standard.
Proposal
An atmospheric community is a DID with a bunch of permissioned spaces under it.
opensocial.community is a set of lexicons describing space types, record types, and methods for modeling and interacting with atmospheric communities.
Communities run on opensocial.community-compliant space hosts. These are servers that natively understand the standardized records & methods. Communities should be able to migrate from one space host to another.
opensocial.community is a peer to the simplespace implementation that is required for PDSes to implement. It is not expected to operate on most PDSes and does not layer on top of simplespaces.
The spaces
There are two opensocial.community spaces: 
a meta space which includes metadata about the community that is often shared more publicly than just members. For instance, the profile, description, rules, community guidelines, etc. This space has to do with “overall community presence & discoverability”.
a members space which includes members-only information about the community. For instance, a members list, member confirmation/acceptance, roles, and an index of available modality spaces. This space has to do with “roles and access”.
The opensocial.community spaces are specifically intended for records about the community. Modality or app specific data is not published to these spaces.
Rather, a community hosts an additional space for each application or modality. If a community wants to enable event applications, it might create a  community.lexicon.calendar.events space. All community.lexicon.* records will then be published into this modality-specific space rather than into a universal “community” space.
Roles & Access
Authorization & access is modeled as flat RBAC (role-based access control). The community defines many roles and assigns one or more roles to each member. Each role gives access to a set of standardized actions.

There are no deny-rules or caveats. So roles’ authorization composes simply by unioning all authorized actions. There is no precedence, hierarchy or evaluation order.

Membership is defined bidirectionally. The community creates a membership record in the members space and the member in turn creates an acceptance record in the same space.

Two actions - assigning a role to a member and ejecting a member - are parameterized by the roles that they apply to.

Roles may entail certain conventions. For instance, the Bluesky app will likely special case the roles admin and moderator and give special UI affordances/badges to accounts with those roles in a community. Other roles may be treated as flair or metadata. A community is free to ignore the convention.

Each space in the community (both modality-specific spaces & opensocial.community spaces) has an open social access record. This record specifies which roles are able to view the space. Read access is enforced by the space host.

All other types of access are considered modality-specific and as such are app features. Who can write to a space, who can pin a thread, who can post to an announcements channel, who can create an event, etc. Each of these are declared in the modality’s own lexicon within the relevant space. However, these authorization declarations may still make use of the community-defined roles.
Writing as the Community DID
Certain modality-specific records need to be created by the community DID. For instance, pinning a post at the top of a forum may require a pin record created by the community DID in the forum space.

If a user (for instance a community admin) wishes to write as the community DID, they do so by holding an OAuth credential for the community DID and writing that record to the community service. The community service will support all com.atproto.space.* CRUD methods.

This does not imply that the user needs to have “full access” to the community account or that they need to login to the app as the community account in a traditional sense. Rather, the community service also serves as an OAuth authorization server for the community DID. Instead of requiring a password, it requires that the user authenticate using their personal account.

The OAuth scopes that each user/role is able to request for the community DID are also encoded in the access record in each relevant space.

Applications are in charge of juggling these credentials. They may choose to offer an “account switcher” where an admin switches to using the community account, or they may do this more transparently and just use the community account credential when the admin performs some action that requires it.
Presence & Discoverability
Each community has a profile that it publishes in its meta space. This includes some basic metadata about the community such as a display name and a profile picture. It also includes records describing the rules of the community.

Any app that wants to show or interact with open social communities, will use these profile records when displaying the community.

Many communities will wish to make their meta space public, even if the rest of the community is private. Even in those cases, the data is still published in a space, the space is just permissioned to allow public reads.

Communities that wish to be easily discoverable may also publish a declaration record to the public broadcast protocol. This record simply includes a pointer to the public meta space for the community.
Moderation
Each community is also a moderation service with moderation authority over all content in the community. 
Moderation happens in the normal atproto way: reports come in one side, labels come out the other side. In some cases, certain community-specific actions such as ejection from the community may need to occur.
Reports are sent through a createReport method in a similar manner to how content is reported to a moderation service. 
Labels are published as records by the community DID in the same space as the content. Labels on accounts are published in the members space. We will likely define a new com.atproto label record type.
On top of this, a simple moderation information architecture is specified. In this system, a report may be open, escalated, or resolved. Moderators may see limited information and take limited action on reports. The goal of this system is to support in-app moderation use-cases. 
Communities at scale may support significantly more complex moderation systems. However this will likely require bespoke community moderation software and wouldn’t be done through in-app flows.
Invites
An invite is an interesting case because it must reach someone who isn’t yet a member and therefore does not necessarily have access to the community’s spaces. Invites usually should not be broadcast publicly. 

Instead, each user who is interested in receiving invites to communities hosts an invites space under their own DID, and a community writes an invite record into that space. The community will notify the user’s PDS of the write which will in turn forward that notification to any relevant services which can then read and present the notification to the user.

Only the user (and authorized applications) may read the space. In other words, the inviting community writes the record but can’t read other invites in the space.
Community governance
The opensocial.community standard is intended for standardizing the interface between applications and communities. Therefore community governance is generally considered out of scope.

A community may implement arbitrarily complex governance, including things like voting and holding periods for certain actions. This is all considered out of scope for the community standard.
Spaces, records, and methods: at a glance
Space types
Space type
skey
Purpose
community.opensocial.meta
self
The community's public face. Profile, rules, how to get in. Often readable by anyone, though may be private to members.
community.opensocial.members
self
Roles, who holds them, the authz config, and the space index. Usually gated to members.
community.opensocial.invites
self
Hosted by each user, not by communities. Where invites arrive.
(modality spaces)
any
com.atmoboards.forum, app.bsky.group, etc. Not specified here.

Record types
Record
Space
Author
Key
Purpose
community.opensocial.declaration
public repo
authority
self
Marks a DID as a community. Points at the meta space. Discovery only.
community.opensocial.profile
meta
authority
self
Name, description, avatar, join policy.
community.opensocial.rule
meta
authority
tid
One community rule, with a stable URI a mod action can cite.
community.opensocial.permissions
members
authority
self
The authz config. Binds roles to actions and bounds role.assign.
community.opensocial.space
members
authority
tid
One space under this community. The index of what exists.
community.opensocial.role
members
authority
role id
Declares that a role exists.
community.opensocial.membership
members
authority
member DID
Grants a member their roles.
community.opensocial.acceptance
members
member
self
The member's side of membership. Gates appearing in the roster, not access.
community.opensocial.access
any space
authority
self
Who may read this space.
community.opensocial.label
any space
authority
tid
A moderation label, written into the space its subject lives in.
community.opensocial.invite
invites
inviting community
tid
An invitation, delivered into the invitee's own space.

Actions
Action
Governs
mod.read
see the moderation queue and subject histories
mod.resolve
resolve or escalate a subject, add notes
label
apply and negate labels (excluding !hide and !takedown)
takedown
apply and negate !hide and !takedown labels
invite
issue invites
admit
approve join requests
eject
remove a member, bounded by assignable
role.assign
grant and revoke roles, bounded by assignable
space.create
create a space under the community DID
space.configure
change space config, including its access record
space.delete
delete a space
community.configure
edit the profile, rules, roles, and permissions

Methods
Method
Requires
Purpose
updateProfile
community.configure
Replace the profile: name, description, avatar, join policy.
uploadImage
community.configure
Upload an image for the profile avatar or banner.
putRule
community.configure
Create or update a rule.
deleteRule
community.configure
Remove a rule.
putRole
community.configure
Create or update a role, and its action bindings.
deleteRole
community.configure
Remove a role.
createSpace
space.create
Add a modality space to the community.
updateSpace
space.configure
Change a space's config, including who can read it.
deleteSpace
space.delete
Remove a space. Refuses on the two well-known ones.
assignRoles
role.assign
Set a member's full role set.
ejectMember
eject, bounded by assignable
Remove a member and their access.
createInvite
invite
Write an invite into someone's own invites space.
listInvites
invite
Outstanding invites.
revokeInvite
invite
Retract an outstanding invite.
requestJoin
—
Ask to join, or redeem an invite.
cancelJoinRequest
—
Withdraw a pending join request.
leaveCommunity
—
Leave the community.
listJoinRequests
admit
The pending-requests queue.
admitMember
admit
Approve or deny a join request.
listSubjects
mod.read
The moderation queue.
getSubjectHistory
mod.read
Every event on one subject.
resolveSubject
mod.resolve
Resolve or escalate a subject, optionally with a note.
applyLabel
label, or takedown for those vals
Write a label record into the subject's space.
negateLabel
label, or takedown for those vals
Negate a previously applied label.

A note on naming
I know the working group has more circled around the term “group” for this thing. I find “group” to be a bit too loose/small, and I don’t feel it captures the nature of the concept as well as “community”. Especially in the context of OAuth login screens: “This app is requesting access to your [X]”. I think “Open social communities” would read nicely there!

Similarly, I quite like the name opensocial.community for this lexicon suite (which also makes me lean “community” over “group”). Brittany currently owns that domain but is open to transferring it to whichever entity makes sense to own the domain.
Some questions
Can we think of ways to smooth over the UX of needing to go through an OAuth flow in order to create records on behalf of a community DID?
Are their alternatives to the above that are secure and legible to users in OAuth consent screens?
Should actions be NSIDs instead? Should they be permission sets? 
Some of the methods could probably be ditched and instead just captured as normal record writes (for instance updateProfile). What’s the right line to draw that at?
The invite space requires anyone to be able to write into it but only the user to read from it. This isn’t configurable in the current alpha implementation. It also opens up an inbound spam vector. Do we like this model? Is there another way to model this?




Deep-dive on how to model proxy/delegated permissions for communities (groups) in atproto OAuth, and on spam vectors in the PDS-hosted invite/space inbox design. No decisions; group will continue in Discourse and possibly regroup in a couple weeks.
Proxy Permissions for Community DIDs
Core question: how to express 'act on behalf of community DID' in an OAuth scope a user can consent to
Two approaches weighed: spec a new third-party repo-access resource, vs. app holds its own OAuth credential to the community
Daniel leans toward the latter: simpler, no new primitives, matches web norms
Ms Boba wants protocol-level support so burden isn't on every app, even if 6 months out
Alternative: extend repo/RPC resource with an 'audience' / 'acting as' parameter (star or specific DID), akin to audience tokens
Shank noted JWT Bearer Grant (used in Habitat) lets community accept any app of a given type without per-app authorization
Invite Inbox & Spam Vectors
PDS-hosted space inbox creates a spam vector via notifyWrite + listRepos accumulating author rows
Debate: apps are better equipped to filter spam than PDSs; labeling services could tag spammy apps like spam accounts
Mitigations floated: retention period on write notifications, compressed (space, author) keys
Zicklag proposal: one level of indirection — user points to a separate inbox DID / space host designed for spam handling, keeping inbox on protocol
Open question raised: can a DID have multiple space hosts (e.g. one for groups, one for notifications)?
Next Steps
(Brittany) Continue both discussions in Discourse and schedule a follow-up call in a couple weeks if needed
Prototype a fake OAuth consent screen for the proxy-permission flow to evaluate UX
