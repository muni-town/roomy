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
		'isolate bg-base-100 z-10 flex flex-col justify-between p-2 overflow-hidden border-r border-base-800/10',
		className
	)}
	{...restProps}
>
	{@render children?.()}
</div>
