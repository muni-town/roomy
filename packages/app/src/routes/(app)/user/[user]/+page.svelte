<script lang="ts">
  import { page } from "$app/state";

  const user = page.params.user;
</script>

<div>
  <h1>{user}</h1>
</div>