interface PreloadRecoveryTarget {
  addEventListener(type: 'vite:preloadError', listener: (event: Event) => void): void;
  location: { reload(): void };
}

export function installPreloadRecovery(target: PreloadRecoveryTarget): void {
  target.addEventListener('vite:preloadError', (event) => {
    event.preventDefault();
    target.location.reload();
  });
}
