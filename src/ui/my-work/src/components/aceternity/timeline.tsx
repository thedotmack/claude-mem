import React from "react";

interface TimelineEntry {
  title: string;
  content: React.ReactNode;
  /** Local addition: the entry that is still open (this month); its dot is filled. */
  current?: boolean;
  /**
   * Local addition: what the entry is, so a reorder keeps each entry's own state with it (an opened month stays open
   * when the months are sorted another way). Entries without one keep their place's state, as before.
   */
  id?: string;
}

/*
 * Local fix (c-aceternity-timeline): a plain list on one static hairline with a dot per entry. The demo's beam that
 * grew down the rail while scrolling and its sticky titles are gone (plan rule 8: low motion; the titles slid and
 * stacked under the floating header), and each title is printed once, as one heading (it was two h3s, one per
 * breakpoint). From the sm width up the titles share one narrow monospace column (a subgrid sized to the longest
 * title, so a range across two years stays on one line and every row stays aligned); on phones a title sits above its
 * entry. The demo's own heading and blurb were sample copy (R12.1: nothing invented on screen).
 */
export const Timeline = ({ data }: { data: TimelineEntry[] }) => {
  return (
    <ol className="relative w-full sm:grid sm:grid-cols-[auto_minmax(0,1fr)] sm:gap-x-5">
      {/* The one hairline, through the dots' centres; decoration only. */}
      <span aria-hidden="true" className="absolute top-3 bottom-3 left-[0.4375rem] w-px bg-control-edge/60" />
      {data.map((item, index) => (
        <li key={item.id ?? index} className="relative grid pl-7 sm:col-span-2 sm:grid-cols-subgrid">
          <span
            aria-hidden="true"
            data-current={item.current || undefined}
            className="absolute top-[0.9rem] left-0 size-[0.9375rem] rounded-full border border-control-edge bg-background data-current:border-primary-deep data-current:bg-primary"
          />
          <h3 data-slot="timeline-date" className="mono-number pt-2.5 text-xs whitespace-nowrap text-muted-foreground sm:pt-3.5">
            {item.title}
          </h3>
          <div className="min-w-0">{item.content}</div>
        </li>
      ))}
    </ol>
  );
};
