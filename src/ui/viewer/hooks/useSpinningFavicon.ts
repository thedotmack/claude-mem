import { useEffect, useRef } from 'react';

/**
 * Hook that animates the browser tab favicon using an animated WebP when isProcessing is true.
 * Creates a hidden <img> with the animated WebP and captures frames to canvas for the favicon.
 * When idle, restores the static favicon.
 *
 * Note: Canvas drawImage from an animated WebP captures the currently displayed frame,
 * so we use requestAnimationFrame to continuously sample the browser-rendered animation.
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
        // Keep it off-screen but in the DOM so the browser animates it
        imgRef.current.style.cssText = 'position:fixed;top:-9999px;left:-9999px;width:32px;height:32px;pointer-events:none;';
        document.body.appendChild(imgRef.current);
      }

      const img = imgRef.current;

      let glowPhase = 0;

      const animate = () => {
        if (img.complete && img.naturalWidth > 0) {
          ctx.clearRect(0, 0, 32, 32);

          // Pulsing purple glow matching the in-page CSS effect
          glowPhase += 0.105;
          const pulse = 0.5 + 0.5 * Math.sin(glowPhase);
          const blur = 4 + pulse * 6;
          ctx.shadowColor = `rgba(139, 92, 246, ${0.6 + pulse * 0.3})`;
          ctx.shadowBlur = blur;

          // Draw centered with margin for glow to be visible
          ctx.drawImage(img, 4, 4, 24, 24);

          // Reset shadow for next frame
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
