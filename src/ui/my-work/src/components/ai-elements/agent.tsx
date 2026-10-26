"use client";

import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { cn } from "@/lib/utils";
import type { Tool } from "ai";
import { BotIcon } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";
import { memo } from "react";


export type AgentProps = ComponentProps<"div">;

export const Agent = memo(({ className, ...props }: AgentProps) => (
  <div
    className={cn("not-prose w-full rounded-xl border bg-card shadow-panel", className)}
    {...props}
  />
));

export type AgentHeaderProps = ComponentProps<"div"> & {
  name: string;
  /** The agent's mark; defaults to a generic bot only when the tool is unknown. */
  icon?: ReactNode;
  /** What this agent is doing, so several agents of one tool can be told apart. */
  role?: string;
  model?: string;
};

export const AgentHeader = memo(
  ({ className, name, icon, role, model, ...props }: AgentHeaderProps) => (
    <div
      className={cn(
        "flex w-full min-w-0 items-center gap-3 px-5 pt-5 pb-3",
        className
      )}
      {...props}
    >
      <span className="flex size-9 shrink-0 items-center justify-center rounded-[10px] border bg-surface">{icon ?? <BotIcon className="size-4" />}</span>
      <div className="min-w-0">
        <p className="truncate font-medium text-[0.94rem] leading-tight">{name}{role && <span className="font-normal text-muted-foreground"> · {role}</span>}</p>
        {model && <p className="truncate text-muted-foreground text-xs">{model}</p>}
      </div>
    </div>
  )
);

export type AgentContentProps = ComponentProps<"div">;

export const AgentContent = memo(
  ({ className, ...props }: AgentContentProps) => (
    <div className={cn("space-y-4 px-5 pb-5 pt-0", className)} {...props} />
  )
);

export type AgentInstructionsProps = ComponentProps<"div"> & {
  children: string;
};

export const AgentInstructions = memo(
  ({ className, children, ...props }: AgentInstructionsProps) => (
    <div className={cn("space-y-2", className)} {...props}>
      <span className="font-medium text-muted-foreground text-sm">
        Instructions
      </span>
      <div className="rounded-md bg-muted/50 p-3 text-muted-foreground text-sm">
        <p>{children}</p>
      </div>
    </div>
  )
);

export type AgentToolsProps = ComponentProps<typeof Accordion>;

export const AgentTools = memo(({ className, ...props }: AgentToolsProps) => (
  <div className={cn("space-y-2", className)}>
    <span className="font-medium text-muted-foreground text-sm">Tools</span>
    <Accordion className="rounded-md border" {...props} />
  </div>
));

export type AgentToolProps = ComponentProps<typeof AccordionItem> & {
  tool: Tool;
};

export const AgentTool = memo(
  ({ className, tool, value, ...props }: AgentToolProps) => {
    const schema =
      "jsonSchema" in tool && tool.jsonSchema
        ? tool.jsonSchema
        : tool.inputSchema;

    return (
      <AccordionItem
        className={cn("border-b last:border-b-0", className)}
        value={value}
        {...props}
      >
        <AccordionTrigger className="px-3 py-2 text-sm hover:no-underline">
          {typeof tool.description === "string" ? tool.description : "No description"}
        </AccordionTrigger>
        <AccordionContent className="px-3 pb-3">
          <div className="rounded-md bg-muted/50">
            <pre className="overflow-auto p-3 font-mono text-xs">{JSON.stringify(schema, null, 2)}</pre>
          </div>
        </AccordionContent>
      </AccordionItem>
    );
  }
);

export type AgentOutputProps = ComponentProps<"div"> & {
  schema: string;
};

export const AgentOutput = memo(
  ({ className, schema, ...props }: AgentOutputProps) => (
    <div className={cn("space-y-2", className)} {...props}>
      <span className="font-medium text-muted-foreground text-sm">
        Output Schema
      </span>
      <div className="rounded-md bg-muted/50">
        <pre className="overflow-auto rounded-md bg-muted/50 p-3 font-mono text-xs">{schema}</pre>
      </div>
    </div>
  )
);

Agent.displayName = "Agent";
AgentHeader.displayName = "AgentHeader";
AgentContent.displayName = "AgentContent";
AgentInstructions.displayName = "AgentInstructions";
AgentTools.displayName = "AgentTools";
AgentTool.displayName = "AgentTool";
AgentOutput.displayName = "AgentOutput";
