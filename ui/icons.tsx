/** The dashboard's icons, defined once as symbols in the page shell. */
export function Icon({ name, className = "size-[18px]" }: { name: string; className?: string }) {
  return (
    <svg
      aria-hidden="true"
      className={`shrink-0 fill-none stroke-current ${className}`}
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth={1.75}
    >
      <use href={`#icon-${name}`} />
    </svg>
  );
}
