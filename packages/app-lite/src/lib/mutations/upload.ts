import { uploadBlob } from "@roomy-space/sdk";
import { auth } from "$lib/auth.svelte";

/**
 * Upload a file (image or video) to the user's PDS and return the atblob:// URI.
 * Skips EXIF stripping and blurhash generation for now — follow-up optimisation.
 */
export async function uploadFile(
  file: File,
): Promise<{
  uri: string;
  mimeType: string;
  size: number;
}> {
  const agent = auth.agent;
  if (!agent) throw new Error("Not authenticated");

  const bytes = await file.arrayBuffer();
  const { uri } = await uploadBlob(agent, bytes, {
    mimetype: file.type,
  });

  return { uri, mimeType: file.type, size: file.size };
}
