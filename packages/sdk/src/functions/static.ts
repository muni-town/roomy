import { Group } from "jazz-tools";
import { IDList, SpaceMigrationReference } from "../schema/index.ts";
import { publicGroup } from "./group.ts";

// these functions are only called once during development and their id is saved in the ../ids.ts file
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
