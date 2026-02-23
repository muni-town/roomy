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
	import type { HTMLAnchorAttributes, HTMLButtonAttributes } from 'svelte/elements';
	import { type VariantProps, tv } from 'tailwind-variants';
	import { cn } from '$lib/utils.svelte.ts';

	export const buttonVariants = tv({
		base: 'touch-manipulation hover:cursor-pointer hover:scale-101 focus-visible:scale-101 disabled:hover:scale-100 motion-safe:focus-visible:transition-transform focus-visible:outline-2 outline-offset-2 inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-2xl active:scale-98 text-sm font-medium motion-safe:transition-all disabled:pointer-events-none disabled:opacity-60 duration-800 active:duration-100 hover:duration-300 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0',
		variants: {
			variant: {
				primary:
					'backdrop-blur-md backdrop-brightness-105 shadow-lg transform-all shadow-accent-500/5 dark:shadow-accent-500/2 disabled:shadow-md active:shadow-md  inset-shadow-sm inset-shadow-accent-700/5 dark:inset-shadow-accent-500/2 focus-visible:outline-accent-500 border border-accent-500/15 dark:border-accent-500/15 hover:bg-accent-200/60 dark:hover:bg-accent-950/25 bg-accent-200/50 dark:bg-accent-950/20 text-accent-950 dark:text-accent-400',
				secondary:
					'backdrop-blur-md backdrop-brightness-105 shadow-lg transform-all shadow-base-500/5 dark:shadow-base-500/2 active:shadow-md inset-shadow-sm inset-shadow-base-700/2 dark:inset-shadow-base-500/2 focus-visible:outline-base-800 dark:focus-visible:outline-base-200 bg-base-300/40 dark:bg-base-800/30 text-base-900 dark:text-base-50 hover:bg-base-300/45 dark:hover:bg-base-800/35 border border-base-300/50 dark:border-base-700/30',
				link: 'focus-visible:outline-base-900 dark:focus-visible:outline-base-50 text-base-800 dark:text-base-200 font-semibold hover:text-accent-600 dark:hover:text-accent-400 data-[current=true]:text-accent-600 dark:data-[current=true]:text-accent-400',
				ghost:
					'focus-visible:outline-base-900 dark:focus-visible:outline-base-50 text-base-800 dark:text-base-200 font-semibold hover:text-accent-600 hover:bg-accent-400/5 data-[current=true]:bg-accent-500/5 dark:hover:text-accent-400 dark:hover:bg-accent-700/5 data-[current=true]:text-accent-600 dark:data-[current=true]:text-accent-400 dark:data-[current=true]:bg-accent-500/5',

				red: 'backdrop-blur-md backdrop-brightness-105 shadow-lg transform-all shadow-red-500/5 dark:shadow-red-500/2 disabled:shadow-md active:shadow-md focus-visible:inset-shadow-red-500/15 inset-shadow-sm inset-shadow-red-700/5 dark:inset-shadow-red-500/2 focus-visible:outline-red-500 border border-red-500/15 dark:border-red-500/15 hover:bg-red-200/60 dark:hover:bg-red-950/30 bg-red-200/50 dark:bg-red-950/20 text-red-800 dark:text-red-400',
				orange:
					'backdrop-blur-md backdrop-brightness-105 shadow-lg transform-all shadow-orange-500/5 dark:shadow-orange-500/2 disabled:shadow-md active:shadow-md focus-visible:inset-shadow-orange-500/15 inset-shadow-sm inset-shadow-orange-700/5 dark:inset-shadow-orange-500/2 focus-visible:outline-orange-500 border border-orange-500/15 dark:border-orange-500/15 hover:bg-orange-200/60 dark:hover:bg-orange-950/30 bg-orange-200/50 dark:bg-orange-950/20 text-orange-800 dark:text-orange-400',
				amber:
					'backdrop-blur-md backdrop-brightness-105 shadow-lg transform-all shadow-amber-500/5 dark:shadow-amber-500/2 disabled:shadow-md active:shadow-md focus-visible:inset-shadow-amber-500/15 inset-shadow-sm inset-shadow-amber-700/5 dark:inset-shadow-amber-500/2 focus-visible:outline-amber-500 border border-amber-500/15 dark:border-amber-500/15 hover:bg-amber-200/60 dark:hover:bg-amber-950/30 bg-amber-200/50 dark:bg-amber-950/20 text-amber-800 dark:text-amber-400',
				yellow:
					'backdrop-blur-md backdrop-brightness-105 shadow-lg transform-all shadow-yellow-500/5 dark:shadow-yellow-500/2 disabled:shadow-md active:shadow-md focus-visible:inset-shadow-yellow-500/15 inset-shadow-sm inset-shadow-yellow-700/5 dark:inset-shadow-yellow-500/2 focus-visible:outline-yellow-500 border border-yellow-500/15 dark:border-yellow-500/15 hover:bg-yellow-200/60 dark:hover:bg-yellow-950/30 bg-yellow-200/50 dark:bg-yellow-950/20 text-yellow-800 dark:text-yellow-400',
				lime: 'backdrop-blur-md backdrop-brightness-105 shadow-lg transform-all shadow-lime-500/5 dark:shadow-lime-500/2 disabled:shadow-md active:shadow-md focus-visible:inset-shadow-lime-500/15 inset-shadow-sm inset-shadow-lime-700/5 dark:inset-shadow-lime-500/2 focus-visible:outline-lime-500 border border-lime-500/15 dark:border-lime-500/15 hover:bg-lime-200/60 dark:hover:bg-lime-950/30 bg-lime-200/50 dark:bg-lime-950/20 text-lime-800 dark:text-lime-400',
				green:
					'backdrop-blur-md backdrop-brightness-105 shadow-lg transform-all shadow-green-500/5 dark:shadow-green-500/2 disabled:shadow-md active:shadow-md focus-visible:inset-shadow-green-500/15 inset-shadow-sm inset-shadow-green-700/5 dark:inset-shadow-green-500/2 focus-visible:outline-green-500 border border-green-500/15 dark:border-green-500/15 hover:bg-green-200/60 dark:hover:bg-green-950/30 bg-green-200/50 dark:bg-green-950/20 text-green-800 dark:text-green-400',
				emerald:
					'backdrop-blur-md backdrop-brightness-105 shadow-lg transform-all shadow-emerald-500/5 dark:shadow-emerald-500/2 disabled:shadow-md active:shadow-md focus-visible:inset-shadow-emerald-500/15 inset-shadow-sm inset-shadow-emerald-700/5 dark:inset-shadow-emerald-500/2 focus-visible:outline-emerald-500 border border-emerald-500/15 dark:border-emerald-500/15 hover:bg-emerald-200/60 dark:hover:bg-emerald-950/30 bg-emerald-200/50 dark:bg-emerald-950/20 text-emerald-800 dark:text-emerald-400',
				teal: 'backdrop-blur-md backdrop-brightness-105 shadow-lg transform-all shadow-teal-500/5 dark:shadow-teal-500/2 disabled:shadow-md active:shadow-md focus-visible:inset-shadow-teal-500/15 inset-shadow-sm inset-shadow-teal-700/5 dark:inset-shadow-teal-500/2 focus-visible:outline-teal-500 border border-teal-500/15 dark:border-teal-500/15 hover:bg-teal-200/60 dark:hover:bg-teal-950/30 bg-teal-200/50 dark:bg-teal-950/20 text-teal-800 dark:text-teal-400',
				cyan: 'backdrop-blur-md backdrop-brightness-105 shadow-lg transform-all shadow-cyan-500/5 dark:shadow-cyan-500/2 disabled:shadow-md active:shadow-md focus-visible:inset-shadow-cyan-500/15 inset-shadow-sm inset-shadow-cyan-700/5 dark:inset-shadow-cyan-500/2 focus-visible:outline-cyan-500 border border-cyan-500/15 dark:border-cyan-500/15 hover:bg-cyan-200/60 dark:hover:bg-cyan-950/30 bg-cyan-200/50 dark:bg-cyan-950/20 text-cyan-800 dark:text-cyan-400',
				sky: 'backdrop-blur-md backdrop-brightness-105 shadow-lg transform-all shadow-sky-500/5 dark:shadow-sky-500/2 disabled:shadow-md active:shadow-md focus-visible:inset-shadow-sky-500/15 inset-shadow-sm inset-shadow-sky-700/5 dark:inset-shadow-sky-500/2 focus-visible:outline-sky-500 border border-sky-500/15 dark:border-sky-500/15 hover:bg-sky-200/60 dark:hover:bg-sky-950/30 bg-sky-200/50 dark:bg-sky-950/20 text-sky-800 dark:text-sky-400',
				blue: 'backdrop-blur-md backdrop-brightness-105 shadow-lg transform-all shadow-blue-500/5 dark:shadow-blue-500/2 disabled:shadow-md active:shadow-md focus-visible:inset-shadow-blue-500/15 inset-shadow-sm inset-shadow-blue-700/5 dark:inset-shadow-blue-500/2 focus-visible:outline-blue-500 border border-blue-500/15 dark:border-blue-500/15 hover:bg-blue-200/60 dark:hover:bg-blue-950/30 bg-blue-200/50 dark:bg-blue-950/20 text-blue-800 dark:text-blue-400',
				indigo:
					'backdrop-blur-md backdrop-brightness-105 shadow-lg transform-all shadow-indigo-500/5 dark:shadow-indigo-500/2 disabled:shadow-md active:shadow-md focus-visible:inset-shadow-indigo-500/15 inset-shadow-sm inset-shadow-indigo-700/5 dark:inset-shadow-indigo-500/2 focus-visible:outline-indigo-500 border border-indigo-500/15 dark:border-indigo-500/15 hover:bg-indigo-200/60 dark:hover:bg-indigo-950/30 bg-indigo-200/50 dark:bg-indigo-950/20 text-indigo-800 dark:text-indigo-400',
				violet:
					'backdrop-blur-md backdrop-brightness-105 shadow-lg transform-all shadow-violet-500/5 dark:shadow-violet-500/2 disabled:shadow-md active:shadow-md focus-visible:inset-shadow-violet-500/15 inset-shadow-sm inset-shadow-violet-700/5 dark:inset-shadow-violet-500/2 focus-visible:outline-violet-500 border border-violet-500/15 dark:border-violet-500/15 hover:bg-violet-200/60 dark:hover:bg-violet-950/30 bg-violet-200/50 dark:bg-violet-950/20 text-violet-800 dark:text-violet-400',
				purple:
					'backdrop-blur-md backdrop-brightness-105 shadow-lg transform-all shadow-purple-500/5 dark:shadow-purple-500/2 disabled:shadow-md active:shadow-md focus-visible:inset-shadow-purple-500/15 inset-shadow-sm inset-shadow-purple-700/5 dark:inset-shadow-purple-500/2 focus-visible:outline-purple-500 border border-purple-500/15 dark:border-purple-500/15 hover:bg-purple-200/60 dark:hover:bg-purple-950/30 bg-purple-200/50 dark:bg-purple-950/20 text-purple-800 dark:text-purple-400',
				fuchsia:
					'backdrop-blur-md backdrop-brightness-105 shadow-lg transform-all shadow-fuchsia-500/5 dark:shadow-fuchsia-500/2 disabled:shadow-md active:shadow-md focus-visible:inset-shadow-fuchsia-500/15 inset-shadow-sm inset-shadow-fuchsia-700/5 dark:inset-shadow-fuchsia-500/2 focus-visible:outline-fuchsia-500 border border-fuchsia-500/15 dark:border-fuchsia-500/15 hover:bg-fuchsia-200/60 dark:hover:bg-fuchsia-950/30 bg-fuchsia-200/50 dark:bg-fuchsia-950/20 text-fuchsia-800 dark:text-fuchsia-400',
				pink: 'backdrop-blur-md backdrop-brightness-105 shadow-lg transform-all shadow-pink-500/5 dark:shadow-pink-500/2 disabled:shadow-md active:shadow-md focus-visible:inset-shadow-pink-500/15 inset-shadow-sm inset-shadow-pink-700/5 dark:inset-shadow-pink-500/2 focus-visible:outline-pink-500 border border-pink-500/15 dark:border-pink-500/15 hover:bg-pink-200/60 dark:hover:bg-pink-950/30 bg-pink-200/50 dark:bg-pink-950/20 text-pink-800 dark:text-pink-400',
				rose: 'backdrop-blur-md backdrop-brightness-105 shadow-lg transform-all shadow-rose-500/5 dark:shadow-rose-500/2 disabled:shadow-md active:shadow-md focus-visible:inset-shadow-rose-500/15 inset-shadow-sm inset-shadow-rose-700/5 dark:inset-shadow-rose-500/2 focus-visible:outline-rose-500 border border-rose-500/15 dark:border-rose-500/15 hover:bg-rose-200/60 dark:hover:bg-rose-950/30 bg-rose-200/50 dark:bg-rose-950/20 text-rose-800 dark:text-rose-400'
			},
			size: {
				default: 'px-3 py-1.5',
				sm: 'px-2 text-xs py-1 font-base [&_svg]:size-3 gap-1.5',
				lg: 'px-4 gap-2.5 text-lg py-2 font-semibold [&_svg]:size-5 gap-2.5',
				icon: 'p-2',
				iconSm: 'p-1.5 [&_svg]:size-3',
				iconLg: 'p-3 [&_svg]:size-5'
			}
		},
		defaultVariants: {
			variant: 'primary',
			size: 'default'
		}
	});

	export type ButtonVariant = VariantProps<typeof buttonVariants>['variant'];
	export type ButtonSize = VariantProps<typeof buttonVariants>['size'];

	export type ButtonProps = WithElementRef<HTMLButtonAttributes> &
		WithElementRef<HTMLAnchorAttributes> & {
			variant?: ButtonVariant;
			size?: ButtonSize;
		};
</script>

<script lang="ts">
	let {
		class: className,
		variant = 'primary',
		size = 'default',
		ref = $bindable(null),
		href = undefined,
		type = 'button',
		children,
		...restProps
	}: ButtonProps = $props();
</script>

{#if href}
	<a
		bind:this={ref}
		class={cn(buttonVariants({ variant, size }), className)}
		{href}
		{...restProps}
	>
		{@render children?.()}
	</a>
{:else}
	<button
		bind:this={ref}
		class={cn(buttonVariants({ variant, size }), className)}
		{type}
		{...restProps}
	>
		{@render children?.()}
	</button>
{/if}
