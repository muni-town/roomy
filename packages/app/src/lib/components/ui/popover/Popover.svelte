<!--
MIT License

Copyright (c) Florian https://github.com/flo-bit

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
-->
<script lang="ts" module>
  import * as PopoverPrimitive from "bits-ui";

  export type PopoverProps = PopoverPrimitive.Popover.RootProps & {
    triggerProps?: PopoverPrimitive.Popover.TriggerProps;
    text?: string;

    triggerText?: string;
    triggerClasses?: string;
    triggerVariant?: ButtonVariant;
    triggerSize?: ButtonSize;

    triggerRef?: HTMLButtonElement | null;
  } & PopoverPrimitive.Popover.ContentProps &
    PopoverPrimitive.Popover.TriggerProps;
</script>

<script lang="ts">
  import {
    buttonVariants,
    type ButtonSize,
    type ButtonVariant,
  } from "$lib/components/ui/button/Button.svelte";
  import PopoverContent from "./PopoverContent.svelte";
  import { cn } from "$lib/utils.svelte";

  let {
    open = $bindable(false),
    onOpenChange,
    children,

    triggerText,
    triggerClasses = "",
    triggerVariant = "primary",
    triggerSize = "default",
    triggerRef = $bindable(null),

    side = "top",
    sideOffset = 10,

    child: myChild,
    class: className,
    ...restProps
  }: PopoverProps = $props();
</script>

<PopoverPrimitive.Popover.Root bind:open {onOpenChange}>
  {#if myChild}
    <PopoverPrimitive.Popover.Trigger
      class={triggerClasses}
      bind:ref={triggerRef}
    >
      {#snippet child({ props })}
        {@render myChild?.({ props })}
      {/snippet}
    </PopoverPrimitive.Popover.Trigger>
  {:else}
    <PopoverPrimitive.Popover.Trigger
      class={cn(
        buttonVariants({ variant: triggerVariant, size: triggerSize }),
        triggerClasses,
      )}
      bind:ref={triggerRef}
    >
      {triggerText}
    </PopoverPrimitive.Popover.Trigger>
  {/if}
  <PopoverContent {side} {sideOffset} class={className} {...restProps}>
    {@render children?.()}
  </PopoverContent>
</PopoverPrimitive.Popover.Root>
