import { goto } from "$app/navigation";
import { atproto } from "$lib/atproto.svelte";
import { user } from "$lib/user.svelte";

export const handleOauthCallback = async (searchParams: URLSearchParams) => {
  await atproto.init();
  
  // do not catch callback error.
  // result should bubble up to login() function
  return atproto.oauth.callback(searchParams).then((result) => {
    // Validate the callback result
    if (!result || !result.session) {
      throw new Error("Invalid OAuth callback result: missing session");
    }
    
    // Update user session
    user.session = result.session;
    
    // Redirect to stored path or home
    const redirectPath = localStorage.getItem("redirectAfterAuth") || "/";
    localStorage.removeItem("redirectAfterAuth"); // Clean up
    goto(redirectPath);
    
    return result;
  });
};
