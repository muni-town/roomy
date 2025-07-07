import { readFileSync, statSync } from 'fs';
import { extname } from 'path';
import sharp from 'sharp';
import { FileStream, ImageDefinition, Group, Account } from 'jazz-tools';

export interface ImageUploadOptions {
  owner?: Group | Account;
  maxSize?: number;
  quality?: number;
}

export interface ImageUploadResult {
  imageDefinition: ImageDefinition;
  originalSize: { width: number; height: number };
  processedSize: { width: number; height: number };
}

/**
 * Create an ImageDefinition from a file path in Node.js environment
 */
export async function createImageFromFile(
  filePath: string,
  options: ImageUploadOptions = {}
): Promise<ImageUploadResult> {
  try {
    // Read the file
    const fileBuffer = readFileSync(filePath);
    const fileStats = statSync(filePath);
    
    // Validate file size (max 10MB)
    const maxFileSize = 10 * 1024 * 1024; // 10MB
    if (fileStats.size > maxFileSize) {
      throw new Error(`File too large. Maximum size is ${maxFileSize / (1024 * 1024)}MB`);
    }

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

    // Create placeholder (8x8 thumbnail)
    const placeholderBuffer = await sharp(fileBuffer)
      .resize(8, 8, { fit: 'cover' })
      .jpeg({ quality: 60 })
      .toBuffer();

    const placeholderDataURL = `data:image/jpeg;base64,${placeholderBuffer.toString('base64')}`;

    // Create ImageDefinition
    const imageDefinition = ImageDefinition.create(
      { 
        originalSize: [newWidth, newHeight],
        placeholderDataURL
      },
      options.owner
    );

    // Create FileStream for the processed image
    const owner = imageDefinition._owner;
    const binaryStream = await FileStream.createFromBlob(
      new Blob([processedBuffer], { type: 'image/jpeg' }),
      owner
    );

    // Store the image data
    imageDefinition[`${newWidth}x${newHeight}`] = binaryStream;

    return {
      imageDefinition,
      originalSize,
      processedSize: { width: newWidth, height: newHeight }
    };

  } catch (error) {
    throw new Error(`Failed to process image: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
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
      height: Math.round(maxSize / aspectRatio)
    };
  } else {
    return {
      width: Math.round(maxSize * aspectRatio),
      height: maxSize
    };
  }
}

/**
 * Validate if a file is a supported image format
 */
export function isSupportedImageFormat(filePath: string): boolean {
  const supportedExtensions = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp'];
  const extension = extname(filePath).toLowerCase();
  return supportedExtensions.includes(extension);
}

/**
 * Get file size in a human-readable format
 */
export function formatFileSize(bytes: number): string {
  const sizes = ['Bytes', 'KB', 'MB', 'GB'];
  if (bytes === 0) return '0 Bytes';
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return Math.round(bytes / Math.pow(1024, i) * 100) / 100 + ' ' + sizes[i];
} 