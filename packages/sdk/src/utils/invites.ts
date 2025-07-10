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

export async function addInviteServiceAsGroupAdmin(
  inviteServiceUrl: string,
  group: Group,
) {
  const serviceAccount = await getServiceAccount(inviteServiceUrl);
  console.warn('Adding service account!!!', serviceAccount);
  if (!serviceAccount) throw "Could not load service ID";
  group.addMember(serviceAccount, "admin");
}

export async function joinGroupThroughInviteService(
  inviteServiceUrl: string,
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
