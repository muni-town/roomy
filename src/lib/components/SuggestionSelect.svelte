<script lang="ts">
  import { Select } from "bits-ui";

  interface Item {
    value: string;
    label: string;
    disabled?: boolean;
    [x: string]: unknown;
  }

  type Props = { 
    items: Item[];
    anchor: HTMLElement;
    callback: (value: string) => void;
  }

  let { items, anchor, callback }: Props = $props();
  export function setItems(value: any[]) { items = value; }
</script>

<Select.Root type="single" open loop onValueChange={(value) => callback(value)}>
  <Select.Trigger ref={anchor}></Select.Trigger>
  <Select.Portal>
    <Select.Content customAnchor={anchor}>
      <Select.Viewport>
        {#each items as { value, label }, i}
          <Select.Item value={value} class="text-white data-[highlighted]:text-red-500">
            <p>{label}</p>
          </Select.Item>
        {/each}
      </Select.Viewport>
    </Select.Content>
  </Select.Portal>
</Select.Root>