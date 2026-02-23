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
	import type { WithElementRef } from 'bits-ui';
	import { type VariantProps, tv } from 'tailwind-variants';
	import { cn } from '$lib/utils.svelte.ts';

	import type { HTMLInputAttributes, HTMLInputTypeAttribute } from 'svelte/elements';

	export const inputVariants = tv({
		base: 'focus:ring-2 ring-1 ring-inset border-0 focus:transition-transform rounded-2xl text-sm font-medium transition-all disabled:pointer-events-none disabled:opacity-50 disabled:cursor-not-allowed duration-300 active:duration-100',
		variants: {
			variant: {
				primary:
					'focus:ring-accent-500 dark:focus:ring-accent-500 ring-accent-500/30 dark:ring-accent-500/20 bg-accent-400/5 dark:bg-accent-600/5 text-accent-700 dark:text-accent-400 placeholder:text-accent-700/50 dark:placeholder:text-accent-400/50',
				secondary:
					'focus:ring-base-800 dark:focus:ring-base-200 bg-base-100/50 dark:bg-base-900/50 text-base-900 dark:text-base-50 ring-base-200 dark:ring-base-800 placeholder:text-base-900/50 dark:placeholder:text-base-50/50'
			},
			sizeVariant: {
				default: 'px-3 py-1.5 text-base',
				sm: 'px-3 text-xs py-1.5 font-base',
				lg: 'px-4 text-lg py-2 font-semibold'
			}
		},
		defaultVariants: {
			variant: 'primary',
			sizeVariant: 'default'
		}
	});

	export type InputVariant = VariantProps<typeof inputVariants>['variant'];
	export type InputSize = VariantProps<typeof inputVariants>['sizeVariant'];

	type InputType = Exclude<HTMLInputTypeAttribute, 'file'>;

	export type InputProps = WithElementRef<
		Omit<HTMLInputAttributes, 'type'> & { type?: InputType }
	> & {
		variant?: InputVariant;
		sizeVariant?: InputSize;
	};
</script>

<script lang="ts">
	let {
		ref = $bindable(null),
		value = $bindable(),
		type,
		class: className,
		variant = 'primary',
		sizeVariant = 'default',
		...restProps
	}: InputProps = $props();
</script>

<input
	bind:this={ref}
	class={cn(inputVariants({ variant, sizeVariant }), className)}
	{type}
	bind:value
	{...restProps}
/>
