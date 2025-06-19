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
		'isolate fixed top-0 bottom-0 bg-base-200 h-screen left-0 z-[60] flex flex-col w-24 justify-between p-2 overflow-hidden',
		className
	)}
	{...restProps}
>
	{@render children?.()}
</div>
