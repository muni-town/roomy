import { goto } from "$app/navigation";

export function navigate(path: string) {
  goto(`/${path}`);
}
