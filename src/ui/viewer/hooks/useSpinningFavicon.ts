import { useEffect, useRef } from 'react';

// How long to keep animating after isProcessing goes false.
// Covers rapid true→false→true flicker during batch processing.
const STOP_DEBOUNCE_MS = 2000;

// Animation: smooth loop between 32px and 24px over 800ms
const CYCLE_MS = 800;
const SIZE_MAX = 32;
const SIZE_MIN = 24;

/**
 * Hook that pulses the browser tab favicon (32px ↔ 24px) while processing.
 * Uses a ref-based animation loop that survives React re-renders and a
 * debounced stop so batch processing doesn't cause flicker.
 */
export function useSpinningFavicon(isProcessing: boolean) {
  const animationRef = useRef<number | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const ctxRef = useRef<CanvasRenderingContext2D | null>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const originalFaviconRef = useRef<string | null>(null);
  const stopTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isAnimatingRef = useRef(false);

  // One-time setup: canvas + original favicon capture
  useEffect(() => {
    if (!canvasRef.current) {
      canvasRef.current = document.createElement('canvas');
      canvasRef.current.width = SIZE_MAX;
      canvasRef.current.height = SIZE_MAX;
      ctxRef.current = canvasRef.current.getContext('2d');
    }
    if (!originalFaviconRef.current) {
      const link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
      if (link) {
        originalFaviconRef.current = link.href;
      }
    }
  }, []);

  useEffect(() => {
    const ctx = ctxRef.current;
    if (!ctx) return;

    const updateFavicon = (dataUrl: string) => {
      let link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
      if (!link) {
        link = document.createElement('link');
        link.rel = 'icon';
        document.head.appendChild(link);
      }
      link.href = dataUrl;
    };

    const startAnimation = () => {
      if (isAnimatingRef.current) return;
      isAnimatingRef.current = true;

      if (!imgRef.current) {
        imgRef.current = new Image();
        imgRef.current.src = 'magic-brain.webp';
        imgRef.current.style.cssText =
          'position:fixed;top:-9999px;left:-9999px;width:32px;height:32px;pointer-events:none;';
        document.body.appendChild(imgRef.current);
      }

      const img = imgRef.current;
      const startTime = performance.now();

      const animate = () => {
        if (!isAnimatingRef.current) return;

        if (img.complete && img.naturalWidth > 0) {
          // Smooth sine wave: 0 → 1 → 0 over CYCLE_MS
          const phase = ((performance.now() - startTime) % CYCLE_MS) / CYCLE_MS;
          const t = Math.sin(phase * Math.PI);

          const size = SIZE_MIN + t * (SIZE_MAX - SIZE_MIN);
          const offset = (SIZE_MAX - size) / 2;

          ctx.clearRect(0, 0, SIZE_MAX, SIZE_MAX);
          ctx.drawImage(img, offset, offset, size, size);
          updateFavicon(canvasRef.current!.toDataURL('image/png'));
        }

        animationRef.current = requestAnimationFrame(animate);
      };

      animate();
    };

    const stopAnimation = () => {
      isAnimatingRef.current = false;

      if (animationRef.current) {
        cancelAnimationFrame(animationRef.current);
        animationRef.current = null;
      }

      if (imgRef.current?.parentNode) {
        imgRef.current.parentNode.removeChild(imgRef.current);
        imgRef.current = null;
      }

      if (originalFaviconRef.current) {
        updateFavicon(originalFaviconRef.current);
      }
    };

    if (isProcessing) {
      if (stopTimerRef.current) {
        clearTimeout(stopTimerRef.current);
        stopTimerRef.current = null;
      }
      startAnimation();
    } else if (isAnimatingRef.current && !stopTimerRef.current) {
      stopTimerRef.current = setTimeout(() => {
        stopTimerRef.current = null;
        stopAnimation();
      }, STOP_DEBOUNCE_MS);
    }

    return () => {
      if (stopTimerRef.current) {
        clearTimeout(stopTimerRef.current);
        stopTimerRef.current = null;
      }
      if (animationRef.current) {
        cancelAnimationFrame(animationRef.current);
        animationRef.current = null;
      }
      isAnimatingRef.current = false;
    };
  }, [isProcessing]);
}
