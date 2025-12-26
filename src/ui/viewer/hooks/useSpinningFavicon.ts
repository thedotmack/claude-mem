import { useEffect, useRef } from 'react';

/**
 * Hook that makes the browser tab favicon spin when isProcessing is true.
 * Uses canvas to rotate the logo image and dynamically update the favicon.
 */
export function useSpinningFavicon(isProcessing: boolean) {
  const animationRef = useRef<number | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const imageRef = useRef<HTMLImageElement | null>(null);
  const rotationRef = useRef(0);
  const originalFaviconRef = useRef<string | null>(null);

  useEffect(() => {
    // Create canvas once
    if (!canvasRef.current) {
      canvasRef.current = document.createElement('canvas');
      canvasRef.current.width = 32;
      canvasRef.current.height = 32;
    }

    // Load image once
    if (!imageRef.current) {
      imageRef.current = new Image();
      imageRef.current.src = 'claude-mem-logomark.webp';
    }

    // Store original favicon
    if (!originalFaviconRef.current) {
      const link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
      if (link) {
        originalFaviconRef.current = link.href;
      }
    }

    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');
    const image = imageRef.current;

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

    const animate = () => {
      if (!image.complete) {
        animationRef.current = requestAnimationFrame(animate);
        return;
      }

      // Rotate by ~4 degrees per frame (matches 1.5s for full rotation at 60fps)
      rotationRef.current += (2 * Math.PI) / 90;

      ctx.clearRect(0, 0, 32, 32);
      ctx.save();
      ctx.translate(16, 16);
      ctx.rotate(rotationRef.current);
      ctx.drawImage(image, -16, -16, 32, 32);
      ctx.restore();

      updateFavicon(canvas.toDataURL('image/png'));
      animationRef.current = requestAnimationFrame(animate);
    };

    if (isProcessing) {
      rotationRef.current = 0;
      animate();
    } else {
      // Stop animation and restore original favicon
      if (animationRef.current) {
        cancelAnimationFrame(animationRef.current);
        animationRef.current = null;
      }
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
