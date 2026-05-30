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
  import type { WithElementRef, WithoutChildren } from "bits-ui";
  import { type VariantProps, tv } from "tailwind-variants";
 	import { cn } from '../../../utils/index.js';

  import type { HTMLTextareaAttributes } from "svelte/elements";

  export const inputVariants = tv({
    base: "rounded-md text-sm border-1 font-medium focus-visible:outline-0 disabled:pointer-events-none disabled:opacity-50 disabled:cursor-not-allowed",
    variants: {
      variant: {
        primary:
          "focus:shadow-input focus:bg-accent-50 dark:focus:border-accent-400 border-neutral-400/50 dark:border-neutral-700 bg-neutral-300/50 dark:bg-neutral-900 text-neutral-950 dark:text-neutral-100 placeholder:text-base-500 dark:placeholder:text-base-50/50",
        secondary:
          "focus:ring-base-800 dark:focus:ring-base-200 bg-base-100/50 dark:bg-base-900/50 text-base-900 dark:text-base-50 ring-base-200 dark:ring-base-800",
      },
      sizeVariant: {
        default: "px-3 py-1.5 text-base min-h-[80px]",
        sm: "px-3 text-xs py-1.5 font-base min-h-[60px]",
        lg: "px-4 text-lg py-2 font-semibold min-h-[100px]",
      },
    },
    defaultVariants: {
      variant: "primary",
      sizeVariant: "default",
    },
  });

  export type InputVariant = VariantProps<typeof inputVariants>["variant"];
  export type InputSize = VariantProps<typeof inputVariants>["sizeVariant"];

  export type InputProps = WithElementRef<HTMLTextareaAttributes> & {
    variant?: InputVariant;
    sizeVariant?: InputSize;
  };
</script>

<script lang="ts">
  let {
    ref = $bindable(null),
    value = $bindable(),
    class: className,
    variant = "primary",
    sizeVariant = "default",
    ...restProps
  }: WithoutChildren<WithElementRef<HTMLTextareaAttributes>> & {
    variant?: InputVariant;
    sizeVariant?: InputSize;
  } = $props();
</script>

<textarea
  bind:this={ref}
  class={cn(inputVariants({ variant, sizeVariant }), className)}
  bind:value
  {...restProps}
></textarea>
