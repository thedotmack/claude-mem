import {
  useScroll,
  useTransform,
  motion,
} from "motion/react";
import React, { useEffect, useRef, useState } from "react";

interface TimelineEntry {
  title: string;
  content: React.ReactNode;
}

export const Timeline = ({ data }: { data: TimelineEntry[] }) => {
  const ref = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState(0);

  // Local fix: entries can grow after mount (quotes expand), so the beam tracks the list's height instead of measuring once.
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const measure = () => setHeight(element.getBoundingClientRect().height);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const { scrollYProgress } = useScroll({
    target: containerRef,
    offset: ["start 10%", "end 50%"],
  });

  const heightTransform = useTransform(scrollYProgress, [0, 1], [0, height]);
  const opacityTransform = useTransform(scrollYProgress, [0, 0.1], [0, 1]);

  return (
    // Local fix: the demo's own heading and blurb were sample copy (R12.1: nothing invented on screen), and its
    // white page background and large spacing are replaced with the app's theme tokens and tighter rhythm.
    <div className="w-full" ref={containerRef}>
      <div ref={ref} className="relative pb-6">
        {data.map((item, index) => (
          <div
            key={index}
            className="flex justify-start pt-8 first:pt-2 md:gap-6"
          >
            <div className="sticky flex flex-col md:flex-row z-20 items-center top-24 self-start md:w-56 md:shrink-0">
              <div className="h-10 absolute left-3 md:left-3 w-10 rounded-full bg-background flex items-center justify-center">
                <div className="h-4 w-4 rounded-full bg-muted border border-border p-2" />
              </div>
              <h3 className="hidden md:block md:pl-16 text-xl font-semibold tracking-tight text-muted-foreground">
                {item.title}
              </h3>
            </div>

            <div className="relative pl-16 md:pl-0 w-full min-w-0">
              <h3 className="md:hidden block text-lg mb-2 text-left font-semibold text-muted-foreground">
                {item.title}
              </h3>
              {item.content}
            </div>
          </div>
        ))}
        <div
          style={{
            height: height + "px",
          }}
          className="absolute md:left-8 left-8 top-0 overflow-hidden w-[2px] bg-linear-to-b from-transparent from-[0%] via-border to-transparent to-[99%]  [mask-image:linear-gradient(to_bottom,transparent_0%,black_10%,black_90%,transparent_100%)] "
        >
          <motion.div
            style={{
              height: heightTransform,
              opacity: opacityTransform,
            }}
            className="absolute inset-x-0 top-0  w-[2px] bg-gradient-to-t from-primary via-accent-foreground to-transparent from-[0%] via-[10%] rounded-full"
          />
        </div>
      </div>
    </div>
  );
};
