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
		'sticky top-0 w-full bg-base-50 z-30 flex h-16 items-center justify-between p-2 border-b border-base-400/30 dark:border-base-300/10 overflow-hidden',
		className
	)}
	{...restProps}
>
	{@render children?.()}
</div>
