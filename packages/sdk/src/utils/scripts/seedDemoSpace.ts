import process from "node:process";
import { writeHeapSnapshot } from "v8";

import { faker } from "@faker-js/faker";
import { startWorker } from "jazz-tools/worker";
import {
  AllPermissions,
  AuthorComponent,
  getComponent,
  RoomyAccount,
  RoomyEntity,
  SpacePermissionsComponent,
  ThreadComponent,
} from "../../schema";
import {
  addToFolder,
  createMessage,
  createSpace,
  createThread,
} from "../../functions";
import { co, Group } from "jazz-tools";
import { createWorkerAccount } from "jazz-run/createWorkerAccount";

faker.seed(42);

const isMain = import.meta.filename == process.argv[1];
if (!isMain) {
  console.log("This script is meant to be run as the main script.");
  process.exit(1);
}
const existingSpace = process.argv[2];
const existingChannel = process.argv[3];
const syncServer = `ws://127.0.0.1:4200/?key=zicklag@katharostech.com`;

const newAccount = await createWorkerAccount({
  name: "test account",
  peer: syncServer,
});

const { worker: jazz } = await startWorker({
  AccountSchema: RoomyAccount,
  accountID: newAccount.accountID,
  accountSecret: newAccount.agentSecret,
  syncServer,
});

const space = existingSpace
  ? (await RoomyEntity.load(existingSpace, {
      resolve: { components: { $each: true } },
    }))!
  : await createSpace("my space", "a test space in jazz", false);
console.log("space ID", space.id);

const permissions = await getComponent(space, SpacePermissionsComponent);
if (!permissions) throw "missing permissions";

const readGroup = await Group.load(permissions[AllPermissions.publicRead]!);
if (!readGroup) throw "missing read group";

const { roomyObject: threadEnt } = existingChannel
  ? {
      roomyObject: (await RoomyEntity.load(existingChannel, {
        resolve: { components: { $each: true } },
      }))!,
    }
  : await (async () => {
      const thread = await createThread("testing", permissions);
      await addToFolder(space, thread.roomyObject);
      return thread;
    })();
console.log("Thread ID", threadEnt.id);
await threadEnt.waitForSync();

const threadComp = await getComponent(threadEnt, ThreadComponent, {
  resolve: { timeline: true },
});
if (!threadComp || !threadComp.timeline)
  throw "missing thread component or timeline";

const authors: co.loaded<typeof AuthorComponent>[] = [];
console.time("create-32-authors");
for (let i = 0; i < 32; i++) {
  const author = AuthorComponent.create(
    {
      authorId: `discord:${faker.number.bigInt().toString()}`,
      imageUrl: faker.image.avatar(),
      name: faker.internet.username(),
    },
    {
      owner: readGroup,
    },
  );
  authors.push(author);
}
console.timeEnd("create-32-authors");

console.time("create-6000-chats");
console.time("create-100-chats");
const count = 6000;
for (let i = 0; i < count; i++) {
  if (i != 0 && i % 100 == 0) {
    // console.log(`total in feed: ${threadComp.timeline.length}`);
    console.log(`Progress: ${i} / ${count}`);
    console.timeEnd("create-100-chats");
    console.time("create-100-chats");
  }
  const syncCount = 1000;
  if (i != 0 && i % syncCount == 0) {
    console.log(`Waiting for sync of ${syncCount} messages...`);
    console.time(`Synced messages`);
    try {
      await threadComp.timeline.waitForSync();
    } catch (_) {}
    console.timeEnd(`Synced messages`);
  }
  const { roomyObject: message } = await createMessage(
    faker.lorem.sentences(),
    { permissions },
  );

  message.components[AuthorComponent.id] =
    faker.helpers.arrayElement(authors).id;

  threadComp.timeline?.push(message.id);
}
console.timeEnd("create-6000-chats");
