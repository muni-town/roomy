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
	import type { VariantProps, tv } from 'tailwind-variants';

	import { cn } from '$lib/utils.svelte';

	export const alertVariants = tv({
		base: 'text-xs relative w-full rounded-2xl border p-4 [&>svg]:absolute [&>svg]:left-4 [&>svg]:top-4 [&>svg]:size-4 [&>svg~*]:pl-7 ',
		variants: {
			variant: {
				default:
					'backdrop-blur-lg bg-accent-100/70 shadow-lg transform-all inset-shadow-sm inset-shadow-accent-700/5 dark:inset-shadow-accent-500/2 shadow-accent-500/5 dark:shadow-accent-500/2 dark:bg-accent-950/20 [&>div:first-of-type]:text-accent-800 [&>svg]:text-accent-700 dark:[&>svg]:text-accent-400 dark:[&>div:first-of-type]:text-accent-300 text-accent-800 dark:text-accent-300 border-accent-500/20 dark:border-accent-500/10',
				secondary:
					'backdrop-blur-lg bg-base-200/70 shadow-lg transform-all inset-shadow-sm inset-shadow-base-700/5 dark:inset-shadow-base-500/2 shadow-base-500/5 dark:shadow-base-950/10 dark:bg-base-900/40 [&>div:first-of-type]:text-base-800 [&>svg]:text-base-700 dark:[&>svg]:text-base-400 dark:[&>div:first-of-type]:text-base-200 text-base-800 dark:text-base-300 border-base-500/20 dark:border-base-500/10',

				red: 'backdrop-blur-lg bg-red-100/70 shadow-lg transform-all inset-shadow-sm inset-shadow-red-700/5 dark:inset-shadow-red-500/2 shadow-red-500/5 dark:shadow-red-500/2 dark:bg-red-950/20 [&>div:first-of-type]:text-red-800 [&>svg]:text-red-700 dark:[&>svg]:text-red-400 dark:[&>div:first-of-type]:text-red-300 text-red-800 dark:text-red-300 border-red-500/20 dark:border-red-500/10',
				orange:
					'backdrop-blur-lg bg-orange-100/70 shadow-lg transform-all inset-shadow-sm inset-shadow-orange-700/5 dark:inset-shadow-orange-500/2 shadow-orange-500/5 dark:shadow-orange-500/2 dark:bg-orange-950/20 [&>div:first-of-type]:text-orange-800 [&>svg]:text-orange-700 dark:[&>svg]:text-orange-400 dark:[&>div:first-of-type]:text-orange-300 text-orange-800 dark:text-orange-300 border-orange-500/20 dark:border-orange-500/10',
				amber:
					'backdrop-blur-lg bg-amber-100/70 shadow-lg transform-all inset-shadow-sm inset-shadow-amber-700/5 dark:inset-shadow-amber-500/2 shadow-amber-500/5 dark:shadow-amber-500/2 dark:bg-amber-950/20 [&>div:first-of-type]:text-amber-800 [&>svg]:text-amber-700 dark:[&>svg]:text-amber-400 dark:[&>div:first-of-type]:text-amber-300 text-amber-800 dark:text-amber-300 border-amber-500/20 dark:border-amber-500/10',
				yellow:
					'backdrop-blur-lg bg-yellow-100/70 shadow-lg transform-all inset-shadow-sm inset-shadow-yellow-700/5 dark:inset-shadow-yellow-500/2 shadow-yellow-500/5 dark:shadow-yellow-500/2 dark:bg-yellow-950/20 [&>div:first-of-type]:text-yellow-800 [&>svg]:text-yellow-700 dark:[&>svg]:text-yellow-400 dark:[&>div:first-of-type]:text-yellow-300 text-yellow-800 dark:text-yellow-300 border-yellow-500/20 dark:border-yellow-500/10',
				lime: 'backdrop-blur-lg bg-lime-100/70 shadow-lg transform-all inset-shadow-sm inset-shadow-lime-700/5 dark:inset-shadow-lime-500/2 shadow-lime-500/5 dark:shadow-lime-500/2 dark:bg-lime-950/20 [&>div:first-of-type]:text-lime-800 [&>svg]:text-lime-700 dark:[&>svg]:text-lime-400 dark:[&>div:first-of-type]:text-lime-300 text-lime-800 dark:text-lime-300 border-lime-500/20 dark:border-lime-500/10',
				green:
					'backdrop-blur-lg bg-green-100/70 shadow-lg transform-all inset-shadow-sm inset-shadow-green-700/5 dark:inset-shadow-green-500/2 shadow-green-500/5 dark:shadow-green-500/2 dark:bg-green-950/20 [&>div:first-of-type]:text-green-800 [&>svg]:text-green-700 dark:[&>svg]:text-green-400 dark:[&>div:first-of-type]:text-green-300 text-green-800 dark:text-green-300 border-green-500/20 dark:border-green-500/10',
				emerald:
					'backdrop-blur-lg bg-emerald-100/70 shadow-lg transform-all inset-shadow-sm inset-shadow-emerald-700/5 dark:inset-shadow-emerald-500/2 shadow-emerald-500/5 dark:shadow-emerald-500/2 dark:bg-emerald-950/20 [&>div:first-of-type]:text-emerald-800 [&>svg]:text-emerald-700 dark:[&>svg]:text-emerald-400 dark:[&>div:first-of-type]:text-emerald-300 text-emerald-800 dark:text-emerald-300 border-emerald-500/20 dark:border-emerald-500/10',
				teal: 'backdrop-blur-lg bg-teal-100/70 shadow-lg transform-all inset-shadow-sm inset-shadow-teal-700/5 dark:inset-shadow-teal-500/2 shadow-teal-500/5 dark:shadow-teal-500/2 dark:bg-teal-950/20 [&>div:first-of-type]:text-teal-800 [&>svg]:text-teal-700 dark:[&>svg]:text-teal-400 dark:[&>div:first-of-type]:text-teal-300 text-teal-800 dark:text-teal-300 border-teal-500/20 dark:border-teal-500/10',
				cyan: 'backdrop-blur-lg bg-cyan-100/70 shadow-lg transform-all inset-shadow-sm inset-shadow-cyan-700/5 dark:inset-shadow-cyan-500/2 shadow-cyan-500/5 dark:shadow-cyan-500/2 dark:bg-cyan-950/20 [&>div:first-of-type]:text-cyan-800 [&>svg]:text-cyan-700 dark:[&>svg]:text-cyan-400 dark:[&>div:first-of-type]:text-cyan-300 text-cyan-800 dark:text-cyan-300 border-cyan-500/20 dark:border-cyan-500/10',
				sky: 'backdrop-blur-lg bg-sky-100/70 shadow-lg transform-all inset-shadow-sm inset-shadow-sky-700/5 dark:inset-shadow-sky-500/2 shadow-sky-500/5 dark:shadow-sky-500/2 dark:bg-sky-950/20 [&>div:first-of-type]:text-sky-800 [&>svg]:text-sky-700 dark:[&>svg]:text-sky-400 dark:[&>div:first-of-type]:text-sky-300 text-sky-800 dark:text-sky-300 border-sky-500/20 dark:border-sky-500/10',
				blue: 'backdrop-blur-lg bg-blue-100/70 shadow-lg transform-all inset-shadow-sm inset-shadow-blue-700/5 dark:inset-shadow-blue-500/2 shadow-blue-500/5 dark:shadow-blue-500/2 dark:bg-blue-950/20 [&>div:first-of-type]:text-blue-800 [&>svg]:text-blue-700 dark:[&>svg]:text-blue-400 dark:[&>div:first-of-type]:text-blue-300 text-blue-800 dark:text-blue-300 border-blue-500/20 dark:border-blue-500/10',
				indigo:
					'backdrop-blur-lg bg-indigo-100/70 shadow-lg transform-all inset-shadow-sm inset-shadow-indigo-700/5 dark:inset-shadow-indigo-500/2 shadow-indigo-500/5 dark:shadow-indigo-500/2 dark:bg-indigo-950/20 [&>div:first-of-type]:text-indigo-800 [&>svg]:text-indigo-700 dark:[&>svg]:text-indigo-400 dark:[&>div:first-of-type]:text-indigo-300 text-indigo-800 dark:text-indigo-300 border-indigo-500/20 dark:border-indigo-500/10',
				violet:
					'backdrop-blur-lg bg-violet-100/70 shadow-lg transform-all inset-shadow-sm inset-shadow-violet-700/5 dark:inset-shadow-violet-500/2 shadow-violet-500/5 dark:shadow-violet-500/2 dark:bg-violet-950/20 [&>div:first-of-type]:text-violet-800 [&>svg]:text-violet-700 dark:[&>svg]:text-violet-400 dark:[&>div:first-of-type]:text-violet-300 text-violet-800 dark:text-violet-300 border-violet-500/20 dark:border-violet-500/10',
				purple:
					'backdrop-blur-lg bg-purple-100/70 shadow-lg transform-all inset-shadow-sm inset-shadow-purple-700/5 dark:inset-shadow-purple-500/2 shadow-purple-500/5 dark:shadow-purple-500/2 dark:bg-purple-950/20 [&>div:first-of-type]:text-purple-800 [&>svg]:text-purple-700 dark:[&>svg]:text-purple-400 dark:[&>div:first-of-type]:text-purple-300 text-purple-800 dark:text-purple-300 border-purple-500/20 dark:border-purple-500/10',
				fuchsia:
					'backdrop-blur-lg bg-fuchsia-100/70 shadow-lg transform-all inset-shadow-sm inset-shadow-fuchsia-700/5 dark:inset-shadow-fuchsia-500/2 shadow-fuchsia-500/5 dark:shadow-fuchsia-500/2 dark:bg-fuchsia-950/20 [&>div:first-of-type]:text-fuchsia-800 [&>svg]:text-fuchsia-700 dark:[&>svg]:text-fuchsia-400 dark:[&>div:first-of-type]:text-fuchsia-300 text-fuchsia-800 dark:text-fuchsia-300 border-fuchsia-500/20 dark:border-fuchsia-500/10',
				pink: 'backdrop-blur-lg bg-pink-100/70 shadow-lg transform-all inset-shadow-sm inset-shadow-pink-700/5 dark:inset-shadow-pink-500/2 shadow-pink-500/5 dark:shadow-pink-500/2 dark:bg-pink-950/20 [&>div:first-of-type]:text-pink-800 [&>svg]:text-pink-700 dark:[&>svg]:text-pink-400 dark:[&>div:first-of-type]:text-pink-300 text-pink-800 dark:text-pink-300 border-pink-500/20 dark:border-pink-500/10',
				rose: 'backdrop-blur-lg bg-rose-100/70 shadow-lg transform-all inset-shadow-sm inset-shadow-rose-700/5 dark:inset-shadow-rose-500/2 shadow-rose-500/5 dark:shadow-rose-500/2 dark:bg-rose-950/20 [&>div:first-of-type]:text-rose-800 [&>svg]:text-rose-700 dark:[&>svg]:text-rose-400 dark:[&>div:first-of-type]:text-rose-300 text-rose-800 dark:text-rose-300 border-rose-500/20 dark:border-rose-500/10'
			}
		},
		defaultVariants: {
			variant: 'default'
		}
	});

	export type AlertVariant = VariantProps<typeof alertVariants>['variant'];
</script>

<script lang="ts">
	import type { HTMLAttributes } from 'svelte/elements';
	import type { WithElementRef } from 'bits-ui';

	import { AlertTitle } from './index.js';

	let {
		ref = $bindable(null),
		class: className,
		variant = undefined,
		title,
		type,
		children,
		...restProps
	}: WithElementRef<HTMLAttributes<HTMLDivElement>> & {
		variant?: AlertVariant;
		title?: string;
		type?: 'info' | 'warning' | 'success' | 'error';
	} = $props();

	if (type === 'warning' && variant === undefined) {
		variant = 'amber';
	} else if (type === 'error' && variant === undefined) {
		variant = 'red';
	} else if (type === 'success' && variant === undefined) {
		variant = 'green';
	} else if (type === 'info' && variant === undefined) {
		variant = 'sky';
	}
</script>

<div
	bind:this={ref}
	class={cn(alertVariants({ variant: variant ?? 'default' }), className)}
	{...restProps}
	role="alert"
>
	{#if type === 'warning'}
		<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" class="size-6">
			<path
				fill-rule="evenodd"
				d="M9.401 3.003c1.155-2 4.043-2 5.197 0l7.355 12.748c1.154 2-.29 4.5-2.599 4.5H4.645c-2.309 0-3.752-2.5-2.598-4.5L9.4 3.003ZM12 8.25a.75.75 0 0 1 .75.75v3.75a.75.75 0 0 1-1.5 0V9a.75.75 0 0 1 .75-.75Zm0 8.25a.75.75 0 1 0 0-1.5.75.75 0 0 0 0 1.5Z"
				clip-rule="evenodd"
			/>
		</svg>
	{:else if type === 'success'}
		<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" class="size-6">
			<path
				fill-rule="evenodd"
				d="M8.603 3.799A4.49 4.49 0 0 1 12 2.25c1.357 0 2.573.6 3.397 1.549a4.49 4.491 4.49 0 0 1 3.498 1.307 4.491 4.491 0 0 1 1.307 3.497A4.49 4.49 0 0 1 21.75 12a4.49 4.49 0 0 1-1.549 3.397 4.491 4.491 0 0 1-1.307 3.497 4.491 4.491 0 0 1-3.497 1.307A4.49 4.49 0 0 1 12 21.75a4.49 4.49 0 0 1-3.397-1.549 4.491 4.491 0 0 1-3.498-1.306 4.491 4.491 0 0 1-1.307-3.498A4.49 4.49 0 0 1 2.25 12c0-1.357.6-2.573 1.549-3.397a4.49 4.49 0 0 1 1.307-3.497 4.491 4.491 0 0 1 3.497-1.307Zm7.007 6.387a.75.75 0 1 0-1.22-.872l-3.236 4.53L9.53 12.22a.75.75 0 0 0-1.06 1.06l2.25 2.25a.75.75 0 0 0 1.14-.094l3.75-5.25Z"
				clip-rule="evenodd"
			/>
		</svg>
	{:else if type === 'info'}
		<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" class="size-6">
			<path
				fill-rule="evenodd"
				d="M2.25 12c0-5.385 4.365-9.75 9.75-9.75s9.75 4.365 9.75 9.75-4.365 9.75-9.75 9.75S2.25 17.385 2.25 12Zm8.706-1.442c1.146-.573 2.437.463 2.126 1.706l-.709 2.836.042-.02a.75.75 0 0 1 .67 1.34l-.04.022c-1.147.573-2.438-.463-2.127-1.706l.71-2.836-.042.02a.75.75 0 1 1-.671-1.34l.041-.022ZM12 9a.75.75 0 1 0 0-1.5.75.75 0 0 0 0 1.5Z"
				clip-rule="evenodd"
			/>
		</svg>
	{:else if type === 'error'}
		<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" class="size-6">
			<path
				fill-rule="evenodd"
				d="M12 2.25c-5.385 0-9.75 4.365-9.75 9.75s4.365 9.75 9.75 9.75 9.75-4.365 9.75-9.75S17.385 2.25 12 2.25Zm-1.72 6.97a.75.75 0 1 0-1.06 1.06L10.94 12l-1.72 1.72a.75.75 0 1 0 1.06 1.06L12 13.06l1.72 1.72a.75.75 0 1 0 1.06-1.06L13.06 12l1.72-1.72a.75.75 0 1 0-1.06-1.06L12 10.94l-1.72-1.72Z"
				clip-rule="evenodd"
			/>
		</svg>
	{/if}
	{#if title}
		<AlertTitle>{title}</AlertTitle>
	{/if}
	{@render children?.()}
</div>
