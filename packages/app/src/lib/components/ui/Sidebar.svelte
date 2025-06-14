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
		'isolate fixed top-2 bottom-2 h-[calc(100dvh-1rem)] left-2 z-50 flex flex-col w-16 justify-between p-2 shadow-lg rounded-4xl border border-base-400/30 dark:border-base-300/10 overflow-hidden',
		className
	)}
	{...restProps}
>
	{@render children?.()}
	<div
		class="from-base-200/50 via-base-100/50 inset-shadow-sm rounded-4xl inset-shadow-base-700/5 dark:inset-shadow-base-400/5 dark:from-base-900/50 dark:via-base-900/30 dark:to-base-950/20 pointer-events-none absolute inset-0 -z-10 bg-linear-to-b backdrop-blur-md"
	></div>
</div>
