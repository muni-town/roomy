<script lang="ts">
  import { goto } from "$app/navigation";
  import { page } from "$app/state";
  import { CommonMark, Entity } from "@roomy-chat/sdk";
  import { CoState } from "jazz-tools/svelte";
  import { onMount } from "svelte";

  const id: string | undefined = $derived(page.params.id);

  const entity = $derived(new CoState(Entity, id));
  onMount(async () => {
    if (!id) {
      const entity = Entity.create({ name: "example entity" });
      const commonmark = entity.addComponent(CommonMark, {
        text: "Hello world",
      });
      commonmark.text += "!!";

      await goto(`/test/${entity.id}`);
    } else {
      console.log('entity', entity);
    }
  });
</script>

<h1>Entity ID: {entity.current?.id}</h1>


<pre>{JSON.stringify(entity.current?.components?.toJSON(), undefined, "  ")}</pre>
