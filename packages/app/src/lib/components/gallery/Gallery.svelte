<script lang="ts">
  import { ImageMasonry } from "@fuxui/visual";
  import { GalleryContent, GalleryImage, RoomyObject } from "@roomy-chat/sdk";
  import { CoState } from "jazz-tools/svelte";
  import FullscreenImageDropper from "../helper/FullscreenImageDropper.svelte";
  import { user } from "$lib/user.svelte";
  import { Button, ScrollArea } from "@fuxui/base";
  import UploadFileButton from "../helper/UploadFileButton.svelte";

  let { objectId, spaceId }: { objectId: string; spaceId: string } = $props();

  let galleryObject = $derived(
    new CoState(RoomyObject, objectId, {
      resolve: {
        components: {
          $each: true,
          $onError: null,
        },
      },
    }),
  );

  let galleryContent = $derived(
    new CoState(GalleryContent, galleryObject.current?.components?.gallery),
  );

  const images = [
    {
      src: "https://picsum.photos/200/300",
      name: "Image 1",
      width: 200,
      height: 300,
      // optional either onclick
      onclick: () => {
        console.log("clicked");
      },
    },
    {
      src: "https://picsum.photos/200/300",
      name: "Image 2",
      width: 200,
      height: 150,
      // or href
      href: "#",
    },
    {
      src: "https://picsum.photos/200/300",
      name: "Image 3",
      width: 100,
      height: 100,
    },
  ];

  async function processImageFile(file: File) {
    console.log(file);
    // get height and width
    const img = new Image();
    img.src = URL.createObjectURL(file);
    img.onload = async () => {
      console.log(img.width, img.height);
      const uploadedFile = await user.uploadBlob(file);
      console.log(uploadedFile);

      const image = GalleryImage.create({
        src: uploadedFile.url,
        name: file.name,
        width: img.width,
        height: img.height,
        alt: "",
      });

      galleryContent.current?.images?.push(image);
    };
    // get height and width
    // const uploadedFile = await user.uploadBlob(file);
  }
</script>

<div class="flex flex-col flex-1 overflow-hidden">
  <div class="flex-1 overflow-y-auto overflow-x-hidden relative">
    <ScrollArea class="h-full px-4 py-8">
      {#if !galleryContent.current?.images?.length}
        <div
          class="text-sm text-base-500 dark:text-base-400 flex items-center gap-2"
        >
          No images yet
          <UploadFileButton {processImageFile} />
        </div>
      {/if}
      <ImageMasonry
        maxColumns={1}
        class="columns-2 lg:columns-3 xl:columns-4"
        images={galleryContent.current?.images?.filter((image) => image) as any}
      />

      <FullscreenImageDropper {processImageFile} />
    </ScrollArea>
  </div>
</div>
