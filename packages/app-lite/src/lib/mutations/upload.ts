import { uploadBlob } from "@roomy-space/sdk";
import { auth } from "$lib/auth.svelte";
import { normalizeMimeType } from "$lib/utils";

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
  const normalizedType = normalizeMimeType(file.type);
  const { uri } = await uploadBlob(agent, bytes, {
    mimetype: normalizedType,
  });

  return { uri, mimeType: normalizedType, size: file.size };
}
