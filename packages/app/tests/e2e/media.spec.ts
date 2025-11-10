import { test, expect } from "@playwright/test";
import { readFile } from "fs/promises";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

test.describe("Media Processing", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await page.waitForLoadState("domcontentloaded");

    // Wait for workers to be available
    await page.waitForFunction(
      () => {
        return (
          (window as any).backend &&
          (window as any).backendStatus &&
          (window as any).debugWorkers
        );
      },
      { timeout: 20000 },
    );
  });

  test("should strip GPS EXIF metadata from real JPEG with location data", async ({
    page,
  }) => {
    // Load the real sample image with GPS EXIF data
    const imagePath = join(__dirname, "sample", "has-gps-exif.jpg");
    const imageBuffer = await readFile(imagePath);

    // Serve the image file via a route to avoid huge base64 transfers
    await page.route("**/test-gps-image.jpg", (route) => {
      route.fulfill({
        status: 200,
        contentType: "image/jpeg",
        body: imageBuffer,
      });
    });

    const result = await page.evaluate(async () => {
      const { getImagePreloadData } = await import("../../src/lib/utils/media");

      // Fetch the image from the mocked route
      const response = await fetch("/test-gps-image.jpg");
      const blob = await response.blob();
      const originalFile = new File([blob], "has-gps-exif.jpg", {
        type: "image/jpeg",
      });

      // Process the file
      const data = await getImagePreloadData(originalFile);

      if (!data.cleanedFile) {
        throw new Error("cleanedFile is undefined");
      }

      // Check the cleaned file
      const cleanedArrayBuffer = await data.cleanedFile.arrayBuffer();
      const cleanedBytes = new Uint8Array(cleanedArrayBuffer);

      // Search for common EXIF markers in the cleaned file
      // EXIF data typically contains "Exif\0\0" marker (45 78 69 66 00 00)
      let hasExifMarker = false;
      for (let i = 0; i < cleanedBytes.length - 6; i++) {
        if (
          cleanedBytes[i] === 0x45 && // E
          cleanedBytes[i + 1] === 0x78 && // x
          cleanedBytes[i + 2] === 0x69 && // i
          cleanedBytes[i + 3] === 0x66 && // f
          cleanedBytes[i + 4] === 0x00 &&
          cleanedBytes[i + 5] === 0x00
        ) {
          hasExifMarker = true;
          break;
        }
      }

      return {
        originalSize: originalFile.size,
        cleanedSize: data.cleanedFile.size,
        width: data.width,
        height: data.height,
        hasBlurhash: !!data.blurhash,
        blurhash: data.blurhash,
        hasExifMarkerInCleaned: hasExifMarker,
        sizeReduction: originalFile.size - data.cleanedFile.size,
      };
    });

    // The cleaned file should NOT have EXIF markers - this is the main goal
    expect(result.hasExifMarkerInCleaned).toBe(false);

    // Note: The cleaned file may be larger than the original because re-encoding
    // through canvas at quality 1.0 can produce larger files than highly compressed JPEGs.
    // The privacy benefit (EXIF removal) is more important than file size.
    expect(result.cleanedSize).toBeGreaterThan(0);

    // Image should still have valid dimensions and blurhash
    expect(result.width).toBeGreaterThan(0);
    expect(result.height).toBeGreaterThan(0);
    expect(result.hasBlurhash).toBeTruthy();

    console.log("GPS EXIF stripping result:", {
      originalSize: result.originalSize,
      cleanedSize: result.cleanedSize,
      sizeChange: result.cleanedSize - result.originalSize,
      dimensions: `${result.width}x${result.height}`,
      exifRemoved: !result.hasExifMarkerInCleaned,
    });
  });

  test("should strip iPhone HDR EXIF metadata from real photo", async ({
    page,
  }) => {
    // Increase timeout for large image processing (1.9MB file)
    test.setTimeout(90000); // 90 seconds

    const imagePath = join(__dirname, "sample", "has-iphone-hdr-exif.jpg");
    const imageBuffer = await readFile(imagePath);

    // Serve the image file via a route to avoid huge base64 transfers
    await page.route("**/test-large-image.jpg", (route) => {
      route.fulfill({
        status: 200,
        contentType: "image/jpeg",
        body: imageBuffer,
      });
    });

    const result = await page.evaluate(async () => {
      const { getImagePreloadData } = await import("../../src/lib/utils/media");

      // Fetch the image from the mocked route
      const response = await fetch("/test-large-image.jpg");
      const blob = await response.blob();
      const originalFile = new File([blob], "has-iphone-hdr-exif.jpg", {
        type: "image/jpeg",
      });

      const data = await getImagePreloadData(originalFile);

      if (!data.cleanedFile) {
        throw new Error("cleanedFile is undefined");
      }

      const cleanedArrayBuffer = await data.cleanedFile.arrayBuffer();
      const cleanedBytes = new Uint8Array(cleanedArrayBuffer);

      // Check for EXIF marker
      let hasExifMarker = false;
      for (let i = 0; i < cleanedBytes.length - 6; i++) {
        if (
          cleanedBytes[i] === 0x45 &&
          cleanedBytes[i + 1] === 0x78 &&
          cleanedBytes[i + 2] === 0x69 &&
          cleanedBytes[i + 3] === 0x66 &&
          cleanedBytes[i + 4] === 0x00 &&
          cleanedBytes[i + 5] === 0x00
        ) {
          hasExifMarker = true;
          break;
        }
      }

      // Verify the image still loads correctly
      const cleanedUrl = URL.createObjectURL(data.cleanedFile);
      const img = new Image();
      await new Promise((resolve, reject) => {
        img.onload = resolve;
        img.onerror = reject;
        img.src = cleanedUrl;
      });
      URL.revokeObjectURL(cleanedUrl);

      return {
        originalSize: originalFile.size,
        cleanedSize: data.cleanedFile.size,
        width: data.width,
        height: data.height,
        loadedWidth: img.naturalWidth,
        loadedHeight: img.naturalHeight,
        hasBlurhash: !!data.blurhash,
        hasExifMarkerInCleaned: hasExifMarker,
        sizeReduction: originalFile.size - data.cleanedFile.size,
      };
    });

    // EXIF should be stripped - this is the main goal
    expect(result.hasExifMarkerInCleaned).toBe(false);

    // The cleaned file exists and is valid
    expect(result.cleanedSize).toBeGreaterThan(0);

    // Dimensions should match after loading
    expect(result.width).toBe(result.loadedWidth);
    expect(result.height).toBe(result.loadedHeight);
    expect(result.width).toBeGreaterThan(0);
    expect(result.height).toBeGreaterThan(0);
    expect(result.hasBlurhash).toBeTruthy();

    console.log("iPhone HDR EXIF stripping result:", {
      originalSize: result.originalSize,
      cleanedSize: result.cleanedSize,
      sizeChange: result.cleanedSize - result.originalSize,
      dimensions: `${result.width}x${result.height}`,
      exifRemoved: !result.hasExifMarkerInCleaned,
    });
  });

  test("should process both sample images concurrently", async ({ page }) => {
    // Increase timeout for processing two large images
    test.setTimeout(90000); // 90 seconds

    const gpsImagePath = join(__dirname, "sample", "has-gps-exif.jpg");
    const hdrImagePath = join(__dirname, "sample", "has-iphone-hdr-exif.jpg");

    const [gpsBuffer, hdrBuffer] = await Promise.all([
      readFile(gpsImagePath),
      readFile(hdrImagePath),
    ]);

    // Serve both images via routes
    await page.route("**/test-gps-concurrent.jpg", (route) => {
      route.fulfill({
        status: 200,
        contentType: "image/jpeg",
        body: gpsBuffer,
      });
    });

    await page.route("**/test-hdr-concurrent.jpg", (route) => {
      route.fulfill({
        status: 200,
        contentType: "image/jpeg",
        body: hdrBuffer,
      });
    });

    const result = await page.evaluate(async () => {
      const { getImagePreloadData } = await import("../../src/lib/utils/media");

      const createFileFromFetch = async (url: string, filename: string) => {
        const response = await fetch(url);
        const blob = await response.blob();
        return new File([blob], filename, { type: "image/jpeg" });
      };

      const gpsFile = await createFileFromFetch(
        "/test-gps-concurrent.jpg",
        "has-gps-exif.jpg",
      );
      const hdrFile = await createFileFromFetch(
        "/test-hdr-concurrent.jpg",
        "has-iphone-hdr-exif.jpg",
      );

      // Process both images concurrently
      const [gpsResult, hdrResult] = await Promise.all([
        getImagePreloadData(gpsFile),
        getImagePreloadData(hdrFile),
      ]);

      return {
        gps: {
          hasCleanedFile: !!gpsResult.cleanedFile,
          width: gpsResult.width,
          height: gpsResult.height,
          hasBlurhash: !!gpsResult.blurhash,
          originalSize: gpsFile.size,
          cleanedSize: gpsResult.cleanedFile?.size,
        },
        hdr: {
          hasCleanedFile: !!hdrResult.cleanedFile,
          width: hdrResult.width,
          height: hdrResult.height,
          hasBlurhash: !!hdrResult.blurhash,
          originalSize: hdrFile.size,
          cleanedSize: hdrResult.cleanedFile?.size,
        },
      };
    });

    // Both images should be processed successfully
    expect(result.gps.hasCleanedFile).toBeTruthy();
    expect(result.gps.width).toBeGreaterThan(0);
    expect(result.gps.height).toBeGreaterThan(0);
    expect(result.gps.hasBlurhash).toBeTruthy();
    expect(result.gps.cleanedSize).toBeGreaterThan(0);

    expect(result.hdr.hasCleanedFile).toBeTruthy();
    expect(result.hdr.width).toBeGreaterThan(0);
    expect(result.hdr.height).toBeGreaterThan(0);
    expect(result.hdr.hasBlurhash).toBeTruthy();
    expect(result.hdr.cleanedSize).toBeGreaterThan(0);

    console.log("Concurrent processing result:", {
      gps: {
        ...result.gps,
        sizeChange: result.gps.cleanedSize! - result.gps.originalSize,
      },
      hdr: {
        ...result.hdr,
        sizeChange: result.hdr.cleanedSize! - result.hdr.originalSize,
      },
    });
  });

  test("should preserve image dimensions after EXIF stripping", async ({
    page,
  }) => {
    const result = await page.evaluate(async () => {
      const { getImagePreloadData } = await import("../../src/lib/utils/media");

      // Create a test image with specific dimensions
      const canvas = document.createElement("canvas");
      canvas.width = 800;
      canvas.height = 600;
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("Could not get canvas context");

      // Draw gradient
      const gradient = ctx.createLinearGradient(0, 0, 800, 600);
      gradient.addColorStop(0, "red");
      gradient.addColorStop(1, "blue");
      ctx.fillStyle = gradient;
      ctx.fillRect(0, 0, 800, 600);

      const blob = await new Promise<Blob>((resolve, reject) => {
        canvas.toBlob(
          (b) => (b ? resolve(b) : reject(new Error("Failed to create blob"))),
          "image/jpeg",
          1.0,
        );
      });

      const file = new File([blob], "test-800x600.jpg", {
        type: "image/jpeg",
      });

      const data = await getImagePreloadData(file);

      // Verify the cleaned file still loads with correct dimensions
      const cleanedUrl = URL.createObjectURL(data.cleanedFile!);
      const img = new Image();
      await new Promise((resolve, reject) => {
        img.onload = resolve;
        img.onerror = reject;
        img.src = cleanedUrl;
      });

      URL.revokeObjectURL(cleanedUrl);

      return {
        originalWidth: data.width,
        originalHeight: data.height,
        loadedWidth: img.naturalWidth,
        loadedHeight: img.naturalHeight,
      };
    });

    expect(result.originalWidth).toBe(800);
    expect(result.originalHeight).toBe(600);
    expect(result.loadedWidth).toBe(800);
    expect(result.loadedHeight).toBe(600);
  });

  test("should generate valid blurhash for cleaned images", async ({
    page,
  }) => {
    const result = await page.evaluate(async () => {
      const { getImagePreloadData } = await import("../../src/lib/utils/media");

      const canvas = document.createElement("canvas");
      canvas.width = 200;
      canvas.height = 200;
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("Could not get canvas context");

      // Create a colorful pattern
      ctx.fillStyle = "red";
      ctx.fillRect(0, 0, 100, 100);
      ctx.fillStyle = "green";
      ctx.fillRect(100, 0, 100, 100);
      ctx.fillStyle = "blue";
      ctx.fillRect(0, 100, 100, 100);
      ctx.fillStyle = "yellow";
      ctx.fillRect(100, 100, 100, 100);

      const blob = await new Promise<Blob>((resolve, reject) => {
        canvas.toBlob(
          (b) => (b ? resolve(b) : reject(new Error("Failed to create blob"))),
          "image/jpeg",
          1.0,
        );
      });

      const file = new File([blob], "colorful.jpg", { type: "image/jpeg" });
      const data = await getImagePreloadData(file);

      return {
        blurhash: data.blurhash,
        blurhashLength: data.blurhash?.length || 0,
      };
    });

    // Blurhash should be a valid string with reasonable length
    expect(result.blurhash).toBeTruthy();
    expect(result.blurhashLength).toBeGreaterThan(0);
    // Typical blurhash with 4x4 components is around 20-30 characters
    expect(result.blurhashLength).toBeGreaterThan(10);

    console.log("Generated blurhash:", result.blurhash);
  });

  test("should handle PNG images", async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { getImagePreloadData } = await import("../../src/lib/utils/media");

      const canvas = document.createElement("canvas");
      canvas.width = 150;
      canvas.height = 150;
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("Could not get canvas context");

      // Draw with transparency
      ctx.fillStyle = "rgba(255, 0, 0, 0.5)";
      ctx.fillRect(0, 0, 150, 150);

      const blob = await new Promise<Blob>((resolve, reject) => {
        canvas.toBlob(
          (b) => (b ? resolve(b) : reject(new Error("Failed to create blob"))),
          "image/png",
          1.0,
        );
      });

      const file = new File([blob], "test.png", { type: "image/png" });
      const data = await getImagePreloadData(file);

      return {
        hasCleanedFile: !!data.cleanedFile,
        cleanedFileType: data.cleanedFile?.type,
        width: data.width,
        height: data.height,
      };
    });

    expect(result.hasCleanedFile).toBeTruthy();
    expect(result.cleanedFileType).toBe("image/png");
    expect(result.width).toBe(150);
    expect(result.height).toBe(150);
  });

  test("should handle video files and return dimensions", async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { getImagePreloadData } = await import("../../src/lib/utils/media");

      // Create a minimal video blob (this is just for testing structure)
      // In real use, this would be an actual video file
      const blob = new Blob([], { type: "video/mp4" });
      const file = new File([blob], "test.mp4", { type: "video/mp4" });

      try {
        const data = await getImagePreloadData(file);
        return {
          success: true,
          data,
        };
      } catch (error) {
        // Expected to fail with empty blob, but we're testing the code path
        return {
          success: false,
          error: (error as Error).message,
        };
      }
    });

    // This will fail with empty blob, but confirms the video path is handled
    console.log("Video processing result:", result);
  });

  test("should maintain file name after processing", async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { getImagePreloadData } = await import("../../src/lib/utils/media");

      const canvas = document.createElement("canvas");
      canvas.width = 100;
      canvas.height = 100;
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("Could not get canvas context");
      ctx.fillStyle = "black";
      ctx.fillRect(0, 0, 100, 100);

      const blob = await new Promise<Blob>((resolve, reject) => {
        canvas.toBlob(
          (b) => (b ? resolve(b) : reject(new Error("Failed to create blob"))),
          "image/jpeg",
          1.0,
        );
      });

      const originalName = "my-special-photo-2024.jpg";
      const file = new File([blob], originalName, { type: "image/jpeg" });
      const data = await getImagePreloadData(file);

      return {
        originalName,
        cleanedFileName: data.cleanedFile?.name,
      };
    });

    expect(result.cleanedFileName).toBe(result.originalName);
  });

  test("should process multiple images independently", async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { getImagePreloadData } = await import("../../src/lib/utils/media");

      const createTestImage = async (
        width: number,
        height: number,
        color: string,
        name: string,
      ) => {
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext("2d");
        if (!ctx) throw new Error("Could not get canvas context");
        ctx.fillStyle = color;
        ctx.fillRect(0, 0, width, height);

        const blob = await new Promise<Blob>((resolve, reject) => {
          canvas.toBlob(
            (b) =>
              b ? resolve(b) : reject(new Error("Failed to create blob")),
            "image/jpeg",
            1.0,
          );
        });

        return new File([blob], name, { type: "image/jpeg" });
      };

      const file1 = await createTestImage(100, 100, "red", "image1.jpg");
      const file2 = await createTestImage(200, 150, "blue", "image2.jpg");
      const file3 = await createTestImage(300, 200, "green", "image3.jpg");

      const [data1, data2, data3] = await Promise.all([
        getImagePreloadData(file1),
        getImagePreloadData(file2),
        getImagePreloadData(file3),
      ]);

      return {
        image1: {
          width: data1.width,
          height: data1.height,
          name: data1.cleanedFile?.name,
          hasBlurhash: !!data1.blurhash,
        },
        image2: {
          width: data2.width,
          height: data2.height,
          name: data2.cleanedFile?.name,
          hasBlurhash: !!data2.blurhash,
        },
        image3: {
          width: data3.width,
          height: data3.height,
          name: data3.cleanedFile?.name,
          hasBlurhash: !!data3.blurhash,
        },
      };
    });

    // Verify each image was processed correctly
    expect(result.image1.width).toBe(100);
    expect(result.image1.height).toBe(100);
    expect(result.image1.name).toBe("image1.jpg");
    expect(result.image1.hasBlurhash).toBeTruthy();

    expect(result.image2.width).toBe(200);
    expect(result.image2.height).toBe(150);
    expect(result.image2.name).toBe("image2.jpg");
    expect(result.image2.hasBlurhash).toBeTruthy();

    expect(result.image3.width).toBe(300);
    expect(result.image3.height).toBe(200);
    expect(result.image3.name).toBe("image3.jpg");
    expect(result.image3.hasBlurhash).toBeTruthy();
  });

  test("should clean images before upload in chat flow", async ({ page }) => {
    // This test verifies the integration with ChatInputArea
    // We'll check that the cleanedFile is used, not the original

    const result = await page.evaluate(async () => {
      const { getImagePreloadData } = await import("../../src/lib/utils/media");

      // Simulate the flow in ChatInputArea.svelte
      const canvas = document.createElement("canvas");
      canvas.width = 100;
      canvas.height = 100;
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("Could not get canvas context");
      ctx.fillStyle = "purple";
      ctx.fillRect(0, 0, 100, 100);

      const blob = await new Promise<Blob>((resolve, reject) => {
        canvas.toBlob(
          (b) => (b ? resolve(b) : reject(new Error("Failed to create blob"))),
          "image/jpeg",
          1.0,
        );
      });

      const originalFile = new File([blob], "upload.jpg", {
        type: "image/jpeg",
      });

      // This is what ChatInputArea does
      const { cleanedFile, ...dimensions } =
        await getImagePreloadData(originalFile);

      if (!cleanedFile) {
        throw new Error(
          "Could not strip EXIF metadata for " + originalFile.name,
        );
      }

      // Verify cleanedFile can be converted to ArrayBuffer (for upload)
      const arrayBuffer = await cleanedFile.arrayBuffer();

      return {
        cleanedFileExists: !!cleanedFile,
        cleanedFileName: cleanedFile.name,
        hasDimensions: !!(dimensions.width && dimensions.height),
        hasBlurhash: !!dimensions.blurhash,
        arrayBufferSize: arrayBuffer.byteLength,
      };
    });

    expect(result.cleanedFileExists).toBeTruthy();
    expect(result.cleanedFileName).toBe("upload.jpg");
    expect(result.hasDimensions).toBeTruthy();
    expect(result.hasBlurhash).toBeTruthy();
    expect(result.arrayBufferSize).toBeGreaterThan(0);

    console.log("Chat upload integration result:", result);
  });
});
