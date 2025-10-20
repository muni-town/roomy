<div class="progress-bar" title="Loading space history">
  <div class="progress-bar-value"></div>
</div>

<style>
  .progress-bar {
    height: 4px;
    width: 100%;
    background-color: var(--color-base-300);
    overflow: hidden;
  }

  :global(.dark) .progress-bar {
    background-color: var(--color-base-900);
  }

  .progress-bar-value {
    width: 100%;
    height: 100%;
    background-color: var(--color-accent-600);
    animation: indeterminateAnimation 2s infinite linear;
    transform-origin: 0% 50%;
  }

  @keyframes indeterminateAnimation {
    0% {
      transform: translateX(0) scaleX(0);
    }
    40% {
      transform: translateX(0) scaleX(0.25);
    }
    100% {
      transform: translateX(100%) scaleX(0.4);
    }
  }
</style>
