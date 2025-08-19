import { Account, type Group } from "jazz-tools";

import { pow_work_wasm } from "./spow/spow-wasm.js";

async function checkResponse(resp: Response) {
  if (!resp.ok) {
    console.error(await resp.text());
    throw new Error("Error getting service ID.");
  }
}

async function getServiceAccount(inviteServiceUrl: string): Promise<Account> {
  const accountResp = await fetch(`${inviteServiceUrl}/service-id`);
  await checkResponse(accountResp);
  const account = await Account.load(await accountResp.text());
  if (!account) throw new Error("Could not load Roomy invites service account");
  return account;
}

export const inviteServiceUrl = "https://invites.roomy.space";
let inviteServiceAccount: Account | undefined;

export async function addInviteServiceAsGroupAdmin(group: Group) {
  if (!inviteServiceAccount) {
    inviteServiceAccount = await getServiceAccount(inviteServiceUrl);
  }
  group.addMember(inviteServiceAccount, "admin");
}

export async function joinGroupThroughInviteService(
  group: string,
  member: string,
) {
  const challengeResp = await fetch(`${inviteServiceUrl}/get-challenge`);
  await checkResponse(challengeResp);
  const challenge = await challengeResp.text();
  console.log("challenge", challenge);
  const response = pow_work_wasm(challenge);
  console.log("computed proof of work", response);
  if (!response) throw new Error("Could not compute proof-of-work.");

  const resp = await fetch(
    `${inviteServiceUrl}/add-member/${group}/${member}`,
    { method: "post", body: response },
  );
  await checkResponse(resp);
}
