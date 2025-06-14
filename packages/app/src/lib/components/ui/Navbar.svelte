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
		'header fixed top-0 right-0 left-0 z-30 flex h-16 items-center justify-between p-2 shadow-lg border border-base-400/30 dark:border-base-300/10 overflow-hidden',
		hasSidebar ? 'sm:left-78' : '',
		className
	)}
	{...restProps}
>
	{@render children?.()}
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
