<script lang="ts">
	import type { WithElementRef } from 'bits-ui';
	import type { HTMLAttributes } from 'svelte/elements';
	import { cn } from '@fuxui/base';

	const {
		class: className,
		children,
		hasSidebar = false,
		...restProps
	}: WithElementRef<HTMLAttributes<HTMLDivElement>> & { hasSidebar?: boolean } = $props();
</script>

<div
	class={cn(
		'header fixed top-2 right-0 left-0 z-30 flex h-16 items-center justify-between p-2 shadow-lg rounded-4xl max-w-6xl mx-2 border border-base-400/30 dark:border-base-300/10 overflow-hidden',
		hasSidebar ? 'sm:left-84' : '',
		className
	)}
	{...restProps}
>
	{@render children?.()}
	<div
		class="backdrop from-base-200/50 via-base-100/50 inset-shadow-sm rounded-4xl inset-shadow-base-700/5 dark:inset-shadow-base-400/5 dark:from-base-900/50 dark:via-base-900/30 dark:to-base-950/20 pointer-events-none absolute inset-0 -z-10 bg-linear-to-b backdrop-blur-md"
	></div>

	<div
		class="backdrop-edge bg-base-900/10 dark:bg-base-500/10 pointer-events-none absolute right-0 bottom-0 left-0 -z-10 translate-y-full backdrop-blur-sm"
	></div>
</div>

<style>
	/** better frosted glass effect adopted from https://www.joshwcomeau.com/css/backdrop-filter/ */
	.header {
		--thickness: 1px;
	}

	@supports (mask-image: none) or (-webkit-mask-image: none) {
		.backdrop {
			height: 200%;
			-webkit-mask-image: linear-gradient(to bottom, black 0% 50%, transparent 50% 100%);
			mask-image: linear-gradient(to bottom, black 0% 50%, transparent 50% 100%);
		}
		.backdrop-edge {
			height: 100%;
			inset: 0;
			-webkit-mask-image: linear-gradient(
				to bottom,
				black 0,
				black var(--thickness),
				transparent var(--thickness)
			);
			mask-image: linear-gradient(
				to bottom,
				black 0,
				black var(--thickness),
				transparent var(--thickness)
			);

			filter: brightness(1.5);
		}
	}
</style>
