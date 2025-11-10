import { encode } from "blurhash";
import piexif from "piexifjs";

export async function getImagePreloadData(file: File): Promise<{
  width?: number;
  height?: number;
  blurhash?: string;
  cleanedFile?: File; // file without EXIF metadata
}> {
  if (file.type.startsWith("image/")) {
    // Extract EXIF orientation before stripping (only for JPEG)
    let orientation = 1;
    if (file.type === "image/jpeg" || file.type === "image/jpg") {
      try {
        // Use FileReader to read as data URL (more efficient than manual conversion)
        const dataUrl = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result as string);
          reader.onerror = reject;
          reader.readAsDataURL(file);
        });

        const exifObj = piexif.load(dataUrl);
        if (exifObj["0th"] && exifObj["0th"][piexif.ImageIFD.Orientation]) {
          orientation = exifObj["0th"][piexif.ImageIFD.Orientation];
        }
      } catch (e) {
        // No EXIF data or error reading it - that's fine
        console.debug("No EXIF orientation found:", e);
      }
    }

    // Load image to get dimensions
    const url = URL.createObjectURL(file);
    try {
      const { img } = await getImageDimensions(url);

      // Get image data for blurhash and apply orientation correction
      const { imageData, correctedWidth, correctedHeight } =
        await getImageDataWithOrientation(img, orientation);
      const blurhash = imageData
        ? encode(imageData.data, correctedWidth, correctedHeight, 4, 4)
        : "";

      // Re-encode through canvas with orientation applied, then strip EXIF with piexifjs
      const cleanedFile = await createCleanedFile(
        file,
        img,
        orientation,
        correctedWidth,
        correctedHeight,
      );

      return {
        width: correctedWidth,
        height: correctedHeight,
        blurhash,
        cleanedFile,
      };
    } finally {
      URL.revokeObjectURL(url);
    }
  } else if (file.type.startsWith("video/")) {
    const url = URL.createObjectURL(file);
    try {
      return await getVideoDimensions(url);
    } finally {
      URL.revokeObjectURL(url);
    }
  } else {
    console.info("Cannot get dimensions for file:", file.name);
    return {};
  }
}

// Get ImageData from an image with orientation correction applied
const getImageDataWithOrientation = async (
  image: HTMLImageElement,
  orientation: number,
): Promise<{
  imageData: ImageData | undefined;
  correctedWidth: number;
  correctedHeight: number;
}> => {
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d");

  if (!context) {
    return {
      imageData: undefined,
      correctedWidth: image.width,
      correctedHeight: image.height,
    };
  }

  // Orientation 5-8 require width/height swap
  const shouldSwapDimensions = orientation >= 5 && orientation <= 8;
  const width = shouldSwapDimensions ? image.height : image.width;
  const height = shouldSwapDimensions ? image.width : image.height;

  canvas.width = width;
  canvas.height = height;

  // Apply orientation transformation
  applyOrientation(context, orientation, image.width, image.height);
  context.drawImage(image, 0, 0);

  return {
    imageData: context.getImageData(0, 0, width, height),
    correctedWidth: width,
    correctedHeight: height,
  };
};

// Apply EXIF orientation transformation to canvas context
const applyOrientation = (
  ctx: CanvasRenderingContext2D,
  orientation: number,
  width: number,
  height: number,
) => {
  switch (orientation) {
    case 2:
      // Horizontal flip
      ctx.transform(-1, 0, 0, 1, width, 0);
      break;
    case 3:
      // 180° rotation
      ctx.transform(-1, 0, 0, -1, width, height);
      break;
    case 4:
      // Vertical flip
      ctx.transform(1, 0, 0, -1, 0, height);
      break;
    case 5:
      // Vertical flip + 90° rotation
      ctx.transform(0, 1, 1, 0, 0, 0);
      break;
    case 6:
      // 90° rotation
      ctx.transform(0, 1, -1, 0, height, 0);
      break;
    case 7:
      // Horizontal flip + 90° rotation
      ctx.transform(0, -1, -1, 0, height, width);
      break;
    case 8:
      // 270° rotation
      ctx.transform(0, -1, 1, 0, 0, width);
      break;
    default:
      // Orientation 1 or unknown - no transformation
      break;
  }
};

// Create a cleaned file with orientation applied and EXIF stripped using piexifjs
const createCleanedFile = async (
  originalFile: File,
  image: HTMLImageElement,
  orientation: number,
  width: number,
  height: number,
): Promise<File> => {
  return new Promise((resolve, reject) => {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");

    if (!ctx) {
      reject(new Error("Could not get canvas context"));
      return;
    }

    // Apply orientation and draw image
    applyOrientation(ctx, orientation, image.width, image.height);
    ctx.drawImage(image, 0, 0);

    // Convert to data URL
    const dataUrl = canvas.toDataURL(originalFile.type, 0.95);

    try {
      // Strip EXIF data using piexifjs (only works for JPEG)
      // For PNG and other formats, the canvas re-encoding already strips metadata
      let cleanedDataUrl = dataUrl;
      if (
        originalFile.type === "image/jpeg" ||
        originalFile.type === "image/jpg"
      ) {
        cleanedDataUrl = piexif.remove(dataUrl);
      }

      // Convert back to File
      fetch(cleanedDataUrl)
        .then((res) => res.blob())
        .then((blob) => {
          const cleanFile = new File([blob], originalFile.name, {
            type: originalFile.type,
          });
          resolve(cleanFile);
        })
        .catch(reject);
    } catch (error) {
      reject(error);
    }
  });
};

export function getImageDimensions(
  url: string,
): Promise<{ img: HTMLImageElement; width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      resolve({ img, width: img.naturalWidth, height: img.naturalHeight });
    };
    img.onerror = reject;
    img.src = url;
  });
}

export function getVideoDimensions(
  url: string,
): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const video = document.createElement("video");
    video.onloadedmetadata = () => {
      resolve({ width: video.videoWidth, height: video.videoHeight });
    };
    video.onerror = reject;
    video.src = url;
  });
}
