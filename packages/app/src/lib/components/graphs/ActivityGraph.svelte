<script lang="ts">
  import { LayerCake, Svg } from "layercake";
  import Line from "./Line.svelte";

  let {
    data,
    width = "100%",
    height = "100%",
    yDomain = [0, null],
  }: {
    data: { x: number; y: number }[];
    width?: string;
    height?: string;
    yDomain?: [number | null, number | null];
  } = $props();
</script>

<div style={`width: ${width}; height: ${height}`}>
  <LayerCake x="x" y="y" {yDomain} {data}>
    <Svg>
      <Line />
    </Svg>
  </LayerCake>
</div>
