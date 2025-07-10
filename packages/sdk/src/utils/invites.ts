import { Account, type Group } from "jazz-tools";

import { pow_work_wasm } from "./spow/spow-wasm_bg.js";

async function checkResponse(resp: Response) {
  if (!resp.ok) {
    console.error(await resp.text());
    throw "Error getting service ID.";
  }
}

async function getServiceAccount(inviteServiceUrl: string): Promise<Account> {
  const accountResp = await fetch(`${inviteServiceUrl}/service-id`);
  await checkResponse(accountResp);
  const account = await Account.load(await accountResp.text());
  if (!account) throw "Could not load Roomy invites service account";
  return account;
}

let inviteServiceUrl: string | undefined;
let inviteServiceAccount: Account | undefined;
export async function setInviteServiceUrl(url: string) {
  inviteServiceUrl = url;
  inviteServiceAccount = await getServiceAccount(url);
}

export function addInviteServiceAsGroupAdmin(group: Group) {
  if (!inviteServiceAccount)
    throw "You must call `setInviteServiceUrl()` before calling `addInviteServiceAsGroupAdmin`";
  group.addMember(inviteServiceAccount, "admin");
}

export async function joinGroupThroughInviteService(
  group: string,
  member: string,
) {
  const challengeResp = await fetch(`${inviteServiceUrl}/get-challenge`);
  await checkResponse(challengeResp);
  const challenge = await challengeResp.text();
  const response = pow_work_wasm(challenge);
  if (!response) throw "Could not compute proof-of-work.";

  const resp = await fetch(`${inviteServiceUrl}/${group}/${member}`);
  await checkResponse(resp);
}
