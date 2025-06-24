import { goto } from "$app/navigation";
import { atproto } from "./atproto.svelte";
import { user } from "./user.svelte";

export const handleOauthCallback = async (searchParams: URLSearchParams) => {
  await atproto.init();
  // do not catch callback error.
  // result should bubble up to login() function
  return atproto.oauth.callback(searchParams).then((result: any) => {
    user.session = result.session;
    goto(localStorage.getItem("redirectAfterAuth") || "/");
  });
};
