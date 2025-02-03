/** The user's index of all of the chats that they have joined. */
export type Catalog = {
  /** Direct messages to other users. */
  dms: {
    [
      /** The DID of the user that the DM is with. */
      did: string
    ]: {
      /** The name associated to the direct message, usually the handle of the user. */
      name: string;

      /** The avatar URL string, optional */
      avatar?: string;

      /** The number of new messages in the DM. */
      newMessages?: number;
    };
  };
};

export type Ulid = string;
export type Did = string;

export type Message = {
  author: Did;
  content: string;
  reactions: { [did: Did]: string };
};

export type Thread = {
  title: string;
  timeline: Ulid[];
};

export type Channel = {
  name: string;
  description: string;
  messages: { [ulid: Ulid]: Message };
  threads: { [ulid: Ulid]: Thread };
  timeline: Ulid[];
};
