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
	import { type VariantProps, tv } from 'tailwind-variants';
	import { cn } from '$lib/utils.svelte.ts';

	export const badgeVariants = tv({
		base: 'inline-flex items-center backdrop-blur-sm justify-center whitespace-nowrap rounded-2xl text-sm font-medium transition-all disabled:pointer-events-none disabled:opacity-50 duration-300 active:duration-100 [&_svg]:pointer-events-none [&_svg]:shrink-0',
		variants: {
			variant: {
				primary:
					'backdrop-blur-md backdrop-brightness-105 shadow-lg shadow-accent-500/5 dark:shadow-accent-500/2 inset-shadow-sm inset-shadow-accent-700/5 dark:inset-shadow-accent-500/2 border border-accent-500/15 dark:border-accent-500/15 bg-accent-200/50 dark:bg-accent-950/20 text-accent-900 dark:text-accent-400',
				primary_shift:
					'backdrop-blur-md backdrop-brightness-105 shadow-lg shadow-[oklch(from_var(--color-accent-500)_l_c_calc(h+35)_/_0.05)] dark:shadow-[oklch(from_var(--color-accent-500)_l_c_calc(h+35)_/_0.02)] inset-shadow-sm inset-shadow-[oklch(from_var(--color-accent-700)_l_c_calc(h+35)_/_0.05)] dark:inset-shadow-[oklch(from_var(--color-accent-500)_l_c_calc(h+35)_/_0.02)] border border-[oklch(from_var(--color-accent-500)_l_c_calc(h+35)_/_0.15)] dark:border-[oklch(from_var(--color-accent-500)_l_c_calc(h+35)_/_0.15)] bg-[oklch(from_var(--color-accent-200)_l_c_calc(h+35)_/_0.5)] dark:bg-[oklch(from_var(--color-accent-950)_l_c_calc(h+35)_/_0.2)] text-[oklch(from_var(--color-accent-900)_l_c_calc(h+35))] dark:text-[oklch(from_var(--color-accent-400)_l_c_calc(h+35))]',
				primary_shift_2:
					'backdrop-blur-md backdrop-brightness-105 shadow-lg shadow-[oklch(from_var(--color-accent-500)_l_c_calc(h+70)_/_0.05)] dark:shadow-[oklch(from_var(--color-accent-500)_l_c_calc(h+70)_/_0.02)] inset-shadow-sm inset-shadow-[oklch(from_var(--color-accent-700)_l_c_calc(h+70)_/_0.05)] dark:inset-shadow-[oklch(from_var(--color-accent-500)_l_c_calc(h+70)_/_0.02)] border border-[oklch(from_var(--color-accent-500)_l_c_calc(h+70)_/_0.15)] dark:border-[oklch(from_var(--color-accent-500)_l_c_calc(h+70)_/_0.15)] bg-[oklch(from_var(--color-accent-200)_l_c_calc(h+70)_/_0.5)] dark:bg-[oklch(from_var(--color-accent-950)_l_c_calc(h+70)_/_0.2)] text-[oklch(from_var(--color-accent-900)_l_c_calc(h+70))] dark:text-[oklch(from_var(--color-accent-400)_l_c_calc(h+70))]',
				secondary:
					'backdrop-blur-md backdrop-brightness-105 shadow-lg shadow-base-500/5 dark:shadow-base-500/2 inset-shadow-sm inset-shadow-base-700/2 dark:inset-shadow-base-500/2 bg-base-300/40 dark:bg-base-800/30 text-base-900 dark:text-base-50 border border-base-300/50 dark:border-base-700/30',
				red: 'backdrop-blur-md backdrop-brightness-105 shadow-lg shadow-red-500/5 dark:shadow-red-500/2 inset-shadow-sm inset-shadow-red-700/5 dark:inset-shadow-red-500/2 border border-red-500/15 dark:border-red-500/15 bg-red-200/50 dark:bg-red-950/20 text-red-900 dark:text-red-400',
				orange:
					'backdrop-blur-md backdrop-brightness-105 shadow-lg shadow-orange-500/5 dark:shadow-orange-500/2 inset-shadow-sm inset-shadow-orange-700/5 dark:inset-shadow-orange-500/2 border border-orange-500/15 dark:border-orange-500/15 bg-orange-200/50 dark:bg-orange-950/20 text-orange-900 dark:text-orange-400',
				amber:
					'backdrop-blur-md backdrop-brightness-105 shadow-lg shadow-amber-500/5 dark:shadow-amber-500/2 inset-shadow-sm inset-shadow-amber-700/5 dark:inset-shadow-amber-500/2 border border-amber-500/15 dark:border-amber-500/15 bg-amber-200/50 dark:bg-amber-950/20 text-amber-900 dark:text-amber-400',
				yellow:
					'backdrop-blur-md backdrop-brightness-105 shadow-lg shadow-yellow-500/5 dark:shadow-yellow-500/2 inset-shadow-sm inset-shadow-yellow-700/5 dark:inset-shadow-yellow-500/2 border border-yellow-500/15 dark:border-yellow-500/15 bg-yellow-200/50 dark:bg-yellow-950/20 text-yellow-900 dark:text-yellow-400',
				lime: 'backdrop-blur-md backdrop-brightness-105 shadow-lg shadow-lime-500/5 dark:shadow-lime-500/2 inset-shadow-sm inset-shadow-lime-700/5 dark:inset-shadow-lime-500/2 border border-lime-500/15 dark:border-lime-500/15 bg-lime-200/50 dark:bg-lime-950/20 text-lime-900 dark:text-lime-400',
				green:
					'backdrop-blur-md backdrop-brightness-105 shadow-lg shadow-green-500/5 dark:shadow-green-500/2 inset-shadow-sm inset-shadow-green-700/5 dark:inset-shadow-green-500/2 border border-green-500/15 dark:border-green-500/15 bg-green-200/50 dark:bg-green-950/20 text-green-900 dark:text-green-400',
				emerald:
					'backdrop-blur-md backdrop-brightness-105 shadow-lg shadow-emerald-500/5 dark:shadow-emerald-500/2 inset-shadow-sm inset-shadow-emerald-700/5 dark:inset-shadow-emerald-500/2 border border-emerald-500/15 dark:border-emerald-500/15 bg-emerald-200/50 dark:bg-emerald-950/20 text-emerald-900 dark:text-emerald-400',
				teal: 'backdrop-blur-md backdrop-brightness-105 shadow-lg shadow-teal-500/5 dark:shadow-teal-500/2 inset-shadow-sm inset-shadow-teal-700/5 dark:inset-shadow-teal-500/2 border border-teal-500/15 dark:border-teal-500/15 bg-teal-200/50 dark:bg-teal-950/20 text-teal-900 dark:text-teal-400',
				cyan: 'backdrop-blur-md backdrop-brightness-105 shadow-lg shadow-cyan-500/5 dark:shadow-cyan-500/2 inset-shadow-sm inset-shadow-cyan-700/5 dark:inset-shadow-cyan-500/2 border border-cyan-500/15 dark:border-cyan-500/15 bg-cyan-200/50 dark:bg-cyan-950/20 text-cyan-900 dark:text-cyan-400',
				sky: 'backdrop-blur-md backdrop-brightness-105 shadow-lg shadow-sky-500/5 dark:shadow-sky-500/2 inset-shadow-sm inset-shadow-sky-700/5 dark:inset-shadow-sky-500/2 border border-sky-500/15 dark:border-sky-500/15 bg-sky-200/50 dark:bg-sky-950/20 text-sky-900 dark:text-sky-400',
				blue: 'backdrop-blur-md backdrop-brightness-105 shadow-lg shadow-blue-500/5 dark:shadow-blue-500/2 inset-shadow-sm inset-shadow-blue-700/5 dark:inset-shadow-blue-500/2 border border-blue-500/15 dark:border-blue-500/15 bg-blue-200/50 dark:bg-blue-950/20 text-blue-900 dark:text-blue-400',
				indigo:
					'backdrop-blur-md backdrop-brightness-105 shadow-lg shadow-indigo-500/5 dark:shadow-indigo-500/2 inset-shadow-sm inset-shadow-indigo-700/5 dark:inset-shadow-indigo-500/2 border border-indigo-500/15 dark:border-indigo-500/15 bg-indigo-200/50 dark:bg-indigo-950/20 text-indigo-900 dark:text-indigo-400',
				violet:
					'backdrop-blur-md backdrop-brightness-105 shadow-lg shadow-violet-500/5 dark:shadow-violet-500/2 inset-shadow-sm inset-shadow-violet-700/5 dark:inset-shadow-violet-500/2 border border-violet-500/15 dark:border-violet-500/15 bg-violet-200/50 dark:bg-violet-950/20 text-violet-900 dark:text-violet-400',
				purple:
					'backdrop-blur-md backdrop-brightness-105 shadow-lg shadow-purple-500/5 dark:shadow-purple-500/2 inset-shadow-sm inset-shadow-purple-700/5 dark:inset-shadow-purple-500/2 border border-purple-500/15 dark:border-purple-500/15 bg-purple-200/50 dark:bg-purple-950/20 text-purple-900 dark:text-purple-400',
				fuchsia:
					'backdrop-blur-md backdrop-brightness-105 shadow-lg shadow-fuchsia-500/5 dark:shadow-fuchsia-500/2 inset-shadow-sm inset-shadow-fuchsia-700/5 dark:inset-shadow-fuchsia-500/2 border border-fuchsia-500/15 dark:border-fuchsia-500/15 bg-fuchsia-200/50 dark:bg-fuchsia-950/20 text-fuchsia-900 dark:text-fuchsia-400',
				pink: 'backdrop-blur-md backdrop-brightness-105 shadow-lg shadow-pink-500/5 dark:shadow-pink-500/2 inset-shadow-sm inset-shadow-pink-700/5 dark:inset-shadow-pink-500/2 border border-pink-500/15 dark:border-pink-500/15 bg-pink-200/50 dark:bg-pink-950/20 text-pink-900 dark:text-pink-400',
				rose: 'backdrop-blur-md backdrop-brightness-105 shadow-lg shadow-rose-500/5 dark:shadow-rose-500/2 inset-shadow-sm inset-shadow-rose-700/5 dark:inset-shadow-rose-500/2 border border-rose-500/15 dark:border-rose-500/15 bg-rose-200/50 dark:bg-rose-950/20 text-rose-900 dark:text-rose-400'
			},
			size: {
				sm: 'px-2 text-xs py-0.5 [&_svg]:size-3 gap-1.5',
				md: 'px-3 py-1 [&_svg]:size-4 gap-2',
				lg: 'px-4 text-lg py-1.5 [&_svg]:size-5 gap-2.5'
			}
		},
		defaultVariants: {
			variant: 'primary',
			size: 'sm'
		}
	});

	export type BadgeVariant = VariantProps<typeof badgeVariants>['variant'];
	export type BadgeSize = VariantProps<typeof badgeVariants>['size'];
</script>

<script lang="ts">
	import type { WithElementRef } from 'bits-ui';
	import type { HTMLAttributes } from 'svelte/elements';

	let {
		ref = $bindable(null),
		class: className,
		variant = 'primary',
		size = 'sm',
		children,
		...restProps
	}: WithElementRef<HTMLAttributes<HTMLSpanElement>> & {
		variant?: BadgeVariant;
		size?: BadgeSize;
	} = $props();
</script>

<span bind:this={ref} class={cn(badgeVariants({ variant, size }), className)} {...restProps}>
	{@render children?.()}
</span>
