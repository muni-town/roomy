import { Group } from "jazz-tools";
import { IDList, SpaceMigrationReference } from "./schema";
import { publicGroup } from "./utils";

// the
export function createAllSpacesList() {
  const group = Group.create();
  group.addMember("everyone", "writeOnly");
  const allSpaces = IDList.create([], group);
  console.log("allSpacesList", allSpaces.id);
  return allSpaces;
}

export function createAllAccountsList() {
  const group = Group.create();
  group.addMember("everyone", "writeOnly");
  const allAccounts = IDList.create([], group);
  console.log("allAccountsList", allAccounts.id);
  return allAccounts;
}

export function createSpaceMigrationReference() {
  const spaceMigrationReference = SpaceMigrationReference.create(
    {},
    publicGroup("writer"),
  );
  console.log(spaceMigrationReference.id);
}

export const spaceMigrationReferenceId = "co_znkJLqM9qGVyrdpVTVDUytvVtqN";
export const allSpacesListId = "co_zmvrY2Ai57fbYwcFEiBY3tDXBdK";
export const allAccountsListId = "co_zCrS57nCfgahG1h6sXLPajEY9ZR";
