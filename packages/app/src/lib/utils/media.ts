import { encode } from "blurhash";

export async function getMediaPreloadData(
  file: File,
): Promise<{ width?: number; height?: number; blurhash?: string }> {
  const url = URL.createObjectURL(file);

  try {
    if (file.type.startsWith("image/")) {
      const { img, width, height } = await getImageDimensions(url);
      const imageData = getImageData(img);
      const blurhash = imageData
        ? encode(imageData.data, width, height, 4, 4)
        : "";
      return { width, height, blurhash };
    } else if (file.type.startsWith("video/")) {
      return await getVideoDimensions(url);
    } else {
      console.info("Cannot get dimensions for file:", file.name);
      return {};
    }
  } finally {
    URL.revokeObjectURL(url);
  }
}

const getImageData = (image: HTMLImageElement) => {
  const canvas = document.createElement("canvas");
  canvas.width = image.width;
  canvas.height = image.height;
  const context = canvas.getContext("2d");
  context?.drawImage(image, 0, 0);
  return context?.getImageData(0, 0, image.width, image.height);
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
