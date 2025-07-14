import { readFileSync, statSync } from 'fs';
import { extname } from 'path';
import sharp from 'sharp';
import { Agent, BlobRef } from '@atproto/api';

export interface BlueskyUploadOptions {
  maxSize?: number;
  quality?: number;
  mediaType?: 'auto' | 'image' | 'video';
}

export interface BlueskyUploadResult {
  url: string;
  mediaType: 'image' | 'video';
  originalSize?: { width: number; height: number };
  processedSize?: { width: number; height: number };
  duration?: number; // for videos
}

/**
 * Upload media (image or video) to Bluesky's CDN and return the URL
 */
export async function uploadMediaToBluesky(
  agent: Agent,
  filePath: string,
  options: BlueskyUploadOptions = {}
): Promise<BlueskyUploadResult> {
  try {
    console.log(`📸 Processing media: ${filePath}`);

    // Read and validate the file
    const fileBuffer = readFileSync(filePath);
    const fileStats = statSync(filePath);

    // Validate file size (max 10MB)
    const maxFileSize = 10 * 1024 * 1024; // 10MB
    if (fileStats.size > maxFileSize) {
      throw new Error(
        `File too large. Maximum size is ${maxFileSize / (1024 * 1024)}MB`
      );
    }

    // Determine media type
    const mediaType =
      options.mediaType === 'auto' || !options.mediaType
        ? detectMediaType(filePath)
        : options.mediaType;

    if (mediaType === 'image') {
      return await uploadImage(agent, fileBuffer, filePath, options);
    } else if (mediaType === 'video') {
      return await uploadVideo(agent, fileBuffer, filePath);
    } else {
      throw new Error(`Unsupported media type: ${mediaType}`);
    }
  } catch (error) {
    throw new Error(
      `Failed to upload media to Bluesky: ${error instanceof Error ? error.message : 'Unknown error'}`
    );
  }
}

/**
 * Upload an image to Bluesky
 */
async function uploadImage(
  agent: Agent,
  fileBuffer: Buffer,
  filePath: string,
  options: BlueskyUploadOptions
): Promise<BlueskyUploadResult> {
  // Get image metadata
  const metadata = await sharp(fileBuffer).metadata();
  if (!metadata.width || !metadata.height) {
    throw new Error('Invalid image file');
  }

  const originalSize = { width: metadata.width, height: metadata.height };

  // Calculate new dimensions
  const maxSize = options.maxSize || 2048;
  const { width: newWidth, height: newHeight } = calculateDimensions(
    metadata.width,
    metadata.height,
    maxSize
  );

  // Process the image
  const processedBuffer = await sharp(fileBuffer)
    .resize(newWidth, newHeight, { fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: options.quality || 85 })
    .toBuffer();

  // Create a Blob for upload
  const blob = new Blob([processedBuffer], { type: 'image/jpeg' });

  // Upload to Bluesky
  console.log('☁️ Uploading image to Bluesky CDN...');
  const resp = await agent.com.atproto.repo.uploadBlob(blob);
  const blobRef = resp.data.blob;

  // Create a record that links to the blob
  const record = {
    $type: 'chat.roomy.v0.images',
    image: blobRef,
    alt: 'User uploaded image',
  };

  // Put the record in the repository
  await agent.com.atproto.repo.putRecord({
    repo: agent.did!,
    collection: 'chat.roomy.v0.images',
    rkey: `${Date.now()}`,
    record: record,
  });

  // Generate the CDN URL (same format as the app)
  const url = `https://cdn.bsky.app/img/feed_thumbnail/plain/${agent.did}/${blobRef.ref}`;

  console.log('url', url);
  console.log(`✅ Image uploaded to Bluesky CDN!`);
  console.log(`   Original size: ${originalSize.width}x${originalSize.height}`);
  console.log(`   Processed size: ${newWidth}x${newHeight}`);

  return {
    url,
    mediaType: 'image',
    originalSize,
    processedSize: { width: newWidth, height: newHeight },
  };
}

/**
 * Upload a video to Bluesky
 */
const VIDEO_SERVICE = 'https://video.bsky.app';

async function uploadVideo(
  agent: Agent,
  fileBuffer: Buffer,
  filePath: string
): Promise<BlueskyUploadResult> {
  const videoName = filePath.split('/').pop()!;
  const mimeType = 'video/mp4'; // Assuming you're only allowing .mp4

  if (!agent.did) {
    throw new Error('Agent did not resolve');
  }

  const { data: repoInfo } = await agent.com.atproto.repo.describeRepo({
    repo: agent.did,
  });

  console.log('repoInfo', repoInfo.didDoc.service);

  const pdsHost = new URL((repoInfo.didDoc.service as any)[0].serviceEndpoint)
    .host;
  const audience = `did:web:${pdsHost}`;

  // Step 1: Get a service auth token
  const { data: serviceAuth } = await agent.com.atproto.server.getServiceAuth({
    aud: audience,
    exp: Math.floor(Date.now() / 1000 + 60 * 30), // 30 minutes expiry
    lxm: 'com.atproto.repo.uploadBlob',
  });

  console.log('serviceAuth', serviceAuth);

  const token = serviceAuth.token;

  // Step 2: Upload the video to the video service
  const uploadUrl = new URL(`${VIDEO_SERVICE}/xrpc/app.bsky.video.uploadVideo`);
  uploadUrl.searchParams.append('did', agent.did);
  uploadUrl.searchParams.append('name', videoName);

  const uploadResponse = await fetch(uploadUrl.toString(), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': mimeType,
      'Content-Length': fileBuffer.length.toString(),
    },
    body: fileBuffer,
  });

  const uploadResponseJson = await uploadResponse.json();
  if (!uploadResponse.ok) {
    if (uploadResponseJson.state !== 'JOB_STATE_COMPLETED') {
      throw new Error(
        `Upload failed: ${uploadResponse.status} ${uploadResponseJson}`
      );
    }
  }

  const jobStatus = uploadResponseJson;
  console.log('Job status response:', jobStatus);
  if (!jobStatus.jobId && !jobStatus.blob) {
    throw new Error('Video upload failed: No jobId or blob in response');
  }

  // Step 3: Poll for job completion
  let blob: BlobRef | undefined = jobStatus.blob;
  const jobId = jobStatus.jobId;
  const videoAgent = new Agent({ service: VIDEO_SERVICE });

  while (!blob) {
    const { data: status } = await videoAgent.app.bsky.video.getJobStatus({
      jobId,
    });

    console.log(
      'Video processing...',
      status.jobStatus.state,
      status.jobStatus.progress || ''
    );

    if (status.jobStatus.blob) {
      blob = status.jobStatus.blob;
    } else if (status.jobStatus.state === 'failed') {
      throw new Error('Video processing failed');
    }

    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  // Step 4: Create your custom record referencing the blob
  const rkey = `${Date.now()}`;
  const record = {
    $type: 'chat.roomy.v0.videos',
    video: blob,
    alt: 'User uploaded video',
  };

  await agent.com.atproto.repo.putRecord({
    repo: agent.did!,
    collection: 'chat.roomy.v0.videos',
    rkey,
    record,
  });

  // Step 5: Create a dummy embed post to activate CDN caching
  const embedRecord = {
    $type: 'app.bsky.embed.video',
    video: blob,
    aspectRatio: await getAspectRatio(filePath),
  };

  await agent.com.atproto.repo.putRecord({
    repo: agent.did!,
    collection: 'chat.roomy.v0.videoEmbeds',
    rkey: `embed-${rkey}`,
    record: {
      $type: 'chat.roomy.v0.videoEmbeds',
      embed: embedRecord,
      createdAt: new Date().toISOString(),
    },
  });

  const url = `https://video.cdn.bsky.app/hls/${agent.did}/${blob.ref}/720p/video.m3u8`;
  console.log('✅ Video uploaded and processed. CDN URL:', url);

  return {
    url,
    mediaType: 'video',
    duration: undefined,
  };
}

/**
 * Detect media type based on file extension
 */
function detectMediaType(filePath: string): 'image' | 'video' {
  const extension = extname(filePath).toLowerCase();

  const imageExtensions = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp'];
  const videoExtensions = [
    '.mp4',
    '.mov',
    '.avi',
    '.mkv',
    '.webm',
    '.flv',
    '.wmv',
  ];

  if (imageExtensions.includes(extension)) {
    return 'image';
  } else if (videoExtensions.includes(extension)) {
    return 'video';
  } else {
    throw new Error(`Unsupported file extension: ${extension}`);
  }
}

/**
 * Get MIME type for video files
 */
function getVideoMimeType(extension: string): string {
  const mimeTypes: Record<string, string> = {
    '.mp4': 'video/mp4',
    '.mov': 'video/quicktime',
    '.avi': 'video/x-msvideo',
    '.mkv': 'video/x-matroska',
    '.webm': 'video/webm',
    '.flv': 'video/x-flv',
    '.wmv': 'video/x-ms-wmv',
  };

  return mimeTypes[extension] || 'video/mp4';
}

/**
 * Calculate new dimensions while maintaining aspect ratio
 */
function calculateDimensions(
  originalWidth: number,
  originalHeight: number,
  maxSize: number
): { width: number; height: number } {
  if (originalWidth <= maxSize && originalHeight <= maxSize) {
    return { width: originalWidth, height: originalHeight };
  }

  const aspectRatio = originalWidth / originalHeight;

  if (originalWidth > originalHeight) {
    return {
      width: maxSize,
      height: Math.round(maxSize / aspectRatio),
    };
  } else {
    return {
      width: Math.round(maxSize * aspectRatio),
      height: maxSize,
    };
  }
}

/**
 * Validate if a file is a supported media format
 */
export function isSupportedMediaFormat(filePath: string): boolean {
  const imageExtensions = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp'];
  const videoExtensions = [
    '.mp4',
    '.mov',
    '.avi',
    '.mkv',
    '.webm',
    '.flv',
    '.wmv',
  ];
  const supportedExtensions = [...imageExtensions, ...videoExtensions];
  const extension = extname(filePath).toLowerCase();
  return supportedExtensions.includes(extension);
}

/**
 * Validate if a file is a supported image format (legacy function)
 */
export function isSupportedImageFormat(filePath: string): boolean {
  const imageExtensions = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp'];
  const extension = extname(filePath).toLowerCase();
  return imageExtensions.includes(extension);
}

import ffmpeg from 'fluent-ffmpeg';

function getAspectRatio(filePath: string): Promise<number> {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(filePath, (err, metadata) => {
      if (err) return reject(err);
      const videoStream = metadata.streams.find(
        (s) => s.codec_type === 'video'
      );
      if (!videoStream || !videoStream.width || !videoStream.height) {
        return reject(new Error('No video stream found'));
      }
      const aspect = videoStream.width / videoStream.height;
      resolve(parseFloat(aspect.toFixed(2))); // round to 2 decimal places
    });
  });
}
