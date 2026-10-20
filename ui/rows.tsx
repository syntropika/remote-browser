/** The shape a settings page is made of: titled groups of rows, each with its control.
    A group is a 24px panel with a visible edge, the shape this dashboard used before HeroUI,
    and the line between two rows runs the panel's whole width. */
import type { ReactNode } from "react";

export function Group({
  title,
  description,
  children,
}: {
  title?: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <section className="flex flex-col">
      {title ? (
        <div className="flex flex-col gap-0.5 pb-2">
          <h2 className="text-ink-dim text-sm font-semibold">{title}</h2>
          {description ? <p className="text-ink-faint text-xs">{description}</p> : null}
        </div>
      ) : null}
      <div className="border-line-strong bg-card overflow-hidden rounded-3xl border">
        {children}
      </div>
    </section>
  );
}

export function Row({
  title,
  description,
  children,
}: {
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="border-line flex min-h-14 items-center justify-between gap-6 border-b px-6 py-4 last:border-b-0">
      <div className="flex min-w-0 flex-col gap-0.5">
        <div className="text-sm font-medium">{title}</div>
        {description ? <div className="text-ink-faint text-xs">{description}</div> : null}
      </div>
      {children ? <div className="flex shrink-0 items-center gap-2">{children}</div> : null}
    </div>
  );
}

/** A row whose control sits under its label, for forms. */
export function FormRow({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <div className="border-line flex flex-col gap-2 border-b px-6 py-5 last:border-b-0">
      <div className="flex flex-col gap-0.5">
        <div className="text-sm font-medium">{title}</div>
        {description ? <div className="text-ink-faint text-xs">{description}</div> : null}
      </div>
      {children}
    </div>
  );
}
