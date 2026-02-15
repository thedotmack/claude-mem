import { useEffect, useRef } from 'react';

/**
 * Heartbeat easing function.
 * Mimics a real heartbeat: two quick beats (systole + diastole) then a rest.
 * Returns a scale factor between 0 and 1.
 */
function heartbeat(t: number): number {
  // Normalize t to a 0-1 cycle
  const phase = t % 1;

  // First beat (systole): sharp spike at ~15% of cycle
  if (phase < 0.15) {
    const p = phase / 0.15;
    return Math.sin(p * Math.PI);
  }
  // Brief rest between beats
  if (phase < 0.25) {
    return 0;
  }
  // Second beat (diastole): smaller spike at ~35% of cycle
  if (phase < 0.4) {
    const p = (phase - 0.25) / 0.15;
    return 0.6 * Math.sin(p * Math.PI);
  }
  // Rest phase
  return 0;
}

/**
 * Hook that animates the browser tab favicon with a heartbeat effect when processing.
 * The icon scales up and down mimicking a real heartbeat rhythm (lub-dub...lub-dub).
 * When idle, restores the static favicon.
 */
export function useSpinningFavicon(isProcessing: boolean) {
  const animationRef = useRef<number | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const originalFaviconRef = useRef<string | null>(null);

  useEffect(() => {
    if (!canvasRef.current) {
      canvasRef.current = document.createElement('canvas');
      canvasRef.current.width = 32;
      canvasRef.current.height = 32;
    }

    if (!originalFaviconRef.current) {
      const link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
      if (link) {
        originalFaviconRef.current = link.href;
      }
    }

    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');
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

    if (isProcessing) {
      // Create/reuse a hidden img element with the animated WebP
      if (!imgRef.current) {
        imgRef.current = new Image();
        imgRef.current.src = 'magic-brain.webp';
        imgRef.current.style.cssText = 'position:fixed;top:-9999px;left:-9999px;width:32px;height:32px;pointer-events:none;';
        document.body.appendChild(imgRef.current);
      }

      const img = imgRef.current;
      const startTime = performance.now();
      // ~72 BPM heartbeat (one full cycle every ~830ms)
      const bpm = 72;
      const cycleDuration = 60000 / bpm;

      const animate = () => {
        if (img.complete && img.naturalWidth > 0) {
          const elapsed = performance.now() - startTime;
          const t = elapsed / cycleDuration;
          const beat = heartbeat(t);

          // Scale: resting at 0.85, peak at 1.0
          const scale = 0.85 + beat * 0.15;
          const size = 32 * scale;
          const offset = (32 - size) / 2;

          ctx.clearRect(0, 0, 32, 32);

          // Purple glow that intensifies with each beat
          const glowAlpha = 0.2 + beat * 0.7;
          ctx.shadowColor = `rgba(139, 92, 246, ${glowAlpha})`;
          ctx.shadowBlur = 2 + beat * 8;

          ctx.drawImage(img, offset, offset, size, size);

          ctx.shadowColor = 'transparent';
          ctx.shadowBlur = 0;

          updateFavicon(canvas.toDataURL('image/png'));
        }
        animationRef.current = requestAnimationFrame(animate);
      };

      animate();
    } else {
      // Stop animation
      if (animationRef.current) {
        cancelAnimationFrame(animationRef.current);
        animationRef.current = null;
      }

      // Remove the hidden animated img from DOM
      if (imgRef.current && imgRef.current.parentNode) {
        imgRef.current.parentNode.removeChild(imgRef.current);
        imgRef.current = null;
      }

      // Restore static favicon
      if (originalFaviconRef.current) {
        updateFavicon(originalFaviconRef.current);
      }
    }

    return () => {
      if (animationRef.current) {
        cancelAnimationFrame(animationRef.current);
        animationRef.current = null;
      }
    };
  }, [isProcessing]);
}
