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
  import type { WithElementRef } from "bits-ui";
  import type {
    HTMLAnchorAttributes,
    HTMLButtonAttributes,
  } from "svelte/elements";
  import { type VariantProps, tv } from "tailwind-variants";
  import { cn } from "../../../utils/index.js";
  import type { AsyncStateWithIdle } from "@roomy-space/sdk";

  export const buttonVariants = tv({
    base: [
      "touch-manipulation hover:cursor-pointer",
      "inline-flex items-center justify-center gap-2",
      "whitespace-nowrap rounded-[8px]",
      "text-sm font-normal",
      "outline-offset-2 focus-visible:outline-2",
      "duration-50 active:duration-100",
      "disabled:pointer-events-none disabled:opacity-60",
      "[&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
    ],
    variants: {
      variant: {
        cta: [
          "bg-accent-400 dark:bg-accent-400",
          "text-accent-950 [&_svg]:text-accent-700",
          "border border-px border-accent-400 [--shadow-button-color:var(--color-accent-700)]",
          "hover:bg-accent-400 hover:shadow-button",
          "focus-visible:outline-accent-500 dark:focus-visible:outline-accent-300",
          "backdrop-blur-md",
          "active:translate-[2px] active:shadow-none",
        ],
        primary: [
          "bg-accent-300/90 dark:bg-accent-600/90",
          "text-accent-950 [&_svg]:text-accent-900 dark:text-accent-50 dark:[&_svg]:text-accent-50",
          "border border-px border-accent-600",
          "hover:bg-accent-300 hover:shadow-button",
          "[--shadow-button-color:var(--color-accent-600)] dark:[--shadow-button-color:var(--color-accent-700)]",
          "focus-visible:outline-accent-950 dark:focus-visible:outline-accent-300",
          "backdrop-blur-md",
          "active:translate-[2px] active:shadow-none",
        ],
        toggle: [
          "bg-accent-200/60 dark:bg-accent-700/50",
          "text-accent-950 dark:text-accent-50",
          "border border-px border-accent-400 dark:border-accent-600",
          "hover:bg-accent-200/80 dark:hover:bg-accent-700/70",
          "focus-visible:outline-accent-950 dark:focus-visible:outline-accent-300",
          "backdrop-blur-md",
          "active:translate-[2px]",
        ],
        secondary: [
          "bg-base-50 dark:bg-transparent",
          "text-base-800 dark:text-base-200 [&_svg]:dark:text-base-200",
          "border border-px border-base-200 dark:border-base-800",
          "hover:bg-base-100 dark:hover:bg-base-800/40 hover:border-base-300",
          "hover:shadow-[2px_2px_0_0_var(--color-base-300)] dark:hover:shadow-[2px_2px_0_0_var(--color-base-600)]",
          "focus-visible:outline-base-900 dark:focus-visible:outline-base-50",
          "active:translate-[2px] active:shadow-none dark:active:shadow-none",
        ],
        link: [
          "text-base-800 dark:text-base-200",
          "font-semibold",
          "focus-visible:outline-base-900 dark:focus-visible:outline-base-50",
          "hover:text-accent-600 dark:hover:text-accent-400",
          "data-[current=true]:text-accent-600 dark:data-[current=true]:text-accent-400",
        ],
        ghost: [
          "text-base-700 dark:text-base-200",
          "hover:bg-base-200/50 dark:hover:bg-base-900/30",
          "border border-transparent hover:border-base-200 dark:hover:border-transparent",
          "active:bg-accent-300/30 dark:active:bg-accent-500/15",
          "font-semibold",
          "focus-visible:outline-base-900 dark:focus-visible:outline-base-50",
          "data-[current=true]:bg-accent-300/50 dark:data-[current=true]:bg-accent-500/10",
          "data-[current=true]:text-accent-950 dark:data-[current=true]:text-accent-50",
          "data-[current=true]:border-accent-300/60 dark:data-[current=true]:border-transparent"
        ],
        red: [
          "bg-red-200 dark:bg-red-700",
          "text-red-950 dark:text-red-50",
          "border border-px border-red-500 dark:border-red-800",
          "hover:bg-red-200/60 dark:hover:bg-red-700 hover:shadow-button",
          "[--shadow-button-color:var(--color-red-400)] [--shadow-button-color:var(--color-red-800)]",
          "focus-visible:outline-red-500",
          "active:translate-[2px] active:shadow-none",
        ],
        orange: [
          "bg-orange-200 dark:bg-orange-700/40",
          "text-orange-950 dark:text-orange-300",
          "border border-px border-orange-500 dark:border-orange-800",
          "hover:bg-orange-200/60 dark:hover:bg-orange-700/60 hover:shadow-button [--shadow-button-color:var(--color-orange-400)]",
          "focus-visible:outline-orange-500",
          "active:translate-[2px] active:shadow-none",
        ],
        amber: [
          "bg-amber-200 dark:bg-amber-700/40",
          "text-amber-950 dark:text-amber-300",
          "border border-px border-amber-500 dark:border-amber-800",
          "hover:bg-amber-200/60 dark:hover:bg-amber-700/60 hover:shadow-button [--shadow-button-color:var(--color-amber-400)]",
          "focus-visible:outline-amber-500",
          "active:translate-[2px] active:shadow-none",
        ],
        yellow: [
          "bg-yellow-200 dark:bg-yellow-700/40",
          "text-yellow-950 dark:text-yellow-300",
          "border border-px border-yellow-500 dark:border-yellow-800",
          "hover:bg-yellow-200/60 dark:hover:bg-yellow-700/60 hover:shadow-button [--shadow-button-color:var(--color-yellow-400)]",
          "focus-visible:outline-yellow-500",
          "active:translate-[2px] active:shadow-none",
        ],
        lime: [
          "bg-lime-200 dark:bg-lime-700/40",
          "text-lime-950 dark:text-lime-300",
          "border border-px border-lime-500 dark:border-lime-800",
          "hover:bg-lime-200/60 dark:hover:bg-lime-700/60 hover:shadow-button [--shadow-button-color:var(--color-lime-400)]",
          "focus-visible:outline-lime-500",
          "active:translate-[2px] active:shadow-none",
        ],
        green: [
          "bg-green-200 dark:bg-green-700/40",
          "text-green-950 dark:text-green-300",
          "border border-px border-green-500 dark:border-green-800",
          "hover:bg-green-200/60 dark:hover:bg-green-700/60 hover:shadow-button [--shadow-button-color:var(--color-green-400)]",
          "focus-visible:outline-green-500",
          "active:translate-[2px] active:shadow-none",
        ],
        emerald: [
          "bg-emerald-200 dark:bg-emerald-700/40",
          "text-emerald-950 dark:text-emerald-300",
          "border border-px border-emerald-500 dark:border-emerald-800",
          "hover:bg-emerald-200/60 dark:hover:bg-emerald-700/60 hover:shadow-button [--shadow-button-color:var(--color-emerald-400)]",
          "focus-visible:outline-emerald-500",
          "active:translate-[2px] active:shadow-none",
        ],
        teal: [
          "bg-teal-200 dark:bg-teal-700/40",
          "text-teal-950 dark:text-teal-300",
          "border border-px border-teal-500 dark:border-teal-800",
          "hover:bg-teal-200/60 dark:hover:bg-teal-700/60 hover:shadow-button [--shadow-button-color:var(--color-teal-400)]",
          "focus-visible:outline-teal-500",
          "active:translate-[2px] active:shadow-none",
        ],
        cyan: [
          "bg-cyan-200 dark:bg-cyan-700/40",
          "text-cyan-950 dark:text-cyan-300",
          "border border-px border-cyan-500 dark:border-cyan-800",
          "hover:bg-cyan-200/60 dark:hover:bg-cyan-700/60 hover:shadow-button [--shadow-button-color:var(--color-cyan-400)]",
          "focus-visible:outline-cyan-500",
          "active:translate-[2px] active:shadow-none",
        ],
        sky: [
          "bg-sky-200 dark:bg-sky-700/40",
          "text-sky-950 dark:text-sky-300",
          "border border-px border-sky-500 dark:border-sky-800",
          "hover:bg-sky-200/60 dark:hover:bg-sky-700/60 hover:shadow-button [--shadow-button-color:var(--color-sky-400)]",
          "focus-visible:outline-sky-500",
          "active:translate-[2px] active:shadow-none",
        ],
        blue: [
          "bg-blue-200 dark:bg-blue-700/40",
          "text-blue-950 dark:text-blue-300",
          "border border-px border-blue-500 dark:border-blue-800",
          "hover:bg-blue-200/60 dark:hover:bg-blue-700/60 hover:shadow-button [--shadow-button-color:var(--color-blue-400)]",
          "focus-visible:outline-blue-500",
          "active:translate-[2px] active:shadow-none",
        ],
        indigo: [
          "bg-indigo-200 dark:bg-indigo-700/40",
          "text-indigo-950 dark:text-indigo-300",
          "border border-px border-indigo-500 dark:border-indigo-800",
          "hover:bg-indigo-200/60 dark:hover:bg-indigo-700/60 hover:shadow-button [--shadow-button-color:var(--color-indigo-400)]",
          "focus-visible:outline-indigo-500",
          "active:translate-[2px] active:shadow-none",
        ],
        violet: [
          "bg-violet-200 dark:bg-violet-700/40",
          "text-violet-950 dark:text-violet-300",
          "border border-px border-violet-500 dark:border-violet-800",
          "hover:bg-violet-200/60 dark:hover:bg-violet-700/60 hover:shadow-button [--shadow-button-color:var(--color-violet-400)]",
          "focus-visible:outline-violet-500",
          "active:translate-[2px] active:shadow-none",
        ],
        purple: [
          "bg-purple-200 dark:bg-purple-700/40",
          "text-purple-950 dark:text-purple-300",
          "border border-px border-purple-500 dark:border-purple-800",
          "hover:bg-purple-200/60 dark:hover:bg-purple-700/60 hover:shadow-button [--shadow-button-color:var(--color-purple-400)]",
          "focus-visible:outline-purple-500",
          "active:translate-[2px] active:shadow-none",
        ],
        fuchsia: [
          "bg-fuchsia-200 dark:bg-fuchsia-700/40",
          "text-fuchsia-950 dark:text-fuchsia-300",
          "border border-px border-fuchsia-500 dark:border-fuchsia-800",
          "hover:bg-fuchsia-200/60 dark:hover:bg-fuchsia-700/60 hover:shadow-button [--shadow-button-color:var(--color-fuchsia-400)]",
          "focus-visible:outline-fuchsia-500",
          "active:translate-[2px] active:shadow-none",
        ],
        pink: [
          "bg-pink-200 dark:bg-pink-700/40",
          "text-pink-950 dark:text-pink-300",
          "border border-px border-pink-500 dark:border-pink-800",
          "hover:bg-pink-200/60 dark:hover:bg-pink-700/60 hover:shadow-button [--shadow-button-color:var(--color-pink-400)]",
          "focus-visible:outline-pink-500",
          "active:translate-[2px] active:shadow-none",
        ],
        rose: [
          "bg-rose-200 dark:bg-rose-700/40",
          "text-rose-950 dark:text-rose-300",
          "border border-px border-rose-500 dark:border-rose-800",
          "hover:bg-rose-200/60 dark:hover:bg-rose-700/60 hover:shadow-button [--shadow-button-color:var(--color-rose-400)]",
          "focus-visible:outline-rose-500",
          "active:translate-[2px] active:shadow-none",
        ],
      },
      size: {
        default: "px-4 py-1.5",
        sm: "px-2 py-1 gap-1.5 text-xs font-base [&_svg]:size-3",
        lg: "px-4 py-2 gap-2.5 text-lg font-semibold [&_svg]:size-5",
        icon: "p-2",
        iconSm: "p-1.5 [&_svg]:size-3",
        iconLg: "p-2.5 [&_svg]:size-6",
      },
    },
    defaultVariants: {
      variant: "primary",
      size: "default",
    },
  });


  export type ButtonVariant = VariantProps<typeof buttonVariants>["variant"];
  export type ButtonSize = VariantProps<typeof buttonVariants>["size"];

  export type ButtonProps = WithElementRef<HTMLButtonAttributes> &
    WithElementRef<HTMLAnchorAttributes> & {
      variant?: ButtonVariant;
      size?: ButtonSize;
      asyncState?: AsyncStateWithIdle<unknown>;
    };
</script>

<script lang="ts">
  import { IconLoading } from "@roomy/design/icons";

  let {
    class: className,
    variant = "primary",
    size = "default",
    ref = $bindable(null),
    href = undefined,
    type = "button",
    children,
    asyncState,
    ...restProps
  }: ButtonProps = $props();

  // Derive disabled state from asyncState
  const isLoading = $derived(asyncState?.status === "loading");
  const disabled = $derived(isLoading || restProps.disabled);
</script>

{#if href}
  <a
    bind:this={ref}
    class={cn(buttonVariants({ variant, size }), className)}
    {href}
    {...restProps}
  >
    {#if isLoading}
      <IconLoading class="animate-spin" />
    {/if}
    {@render children?.()}
  </a>
{:else}
  <button
    bind:this={ref}
    class={cn(buttonVariants({ variant, size }), className)}
    {type}
    {disabled}
    {...restProps}
  >
    {#if isLoading}
      <IconLoading class="animate-spin" />
    {/if}
    {@render children?.()}
  </button>
{/if}
