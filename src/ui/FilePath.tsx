import { NavArrowRight } from "iconoir-react/regular";

/** The file and its nearest folders stay readable when header controls crowd the path. */
export function FilePath({
  path,
  fullPath = path,
  previous,
  scope = [],
}: {
  path: string;
  fullPath?: string;
  previous?: string;
  scope?: { line: number; name: string }[];
}) {
  const parts = path.split("/");
  const name = parts.pop() ?? path;
  const parent = `${parts.length > 2 ? "… / " : ""}${parts.slice(-2).join(" / ")}`;

  return (
    <nav aria-label="File path" title={fullPath} className="flex min-w-0 items-center gap-1 overflow-hidden text-[13px]">
      {previous ? <span className="min-w-0 shrink truncate text-ink-3">{previous} →</span> : null}
      <span className="flex min-w-0 shrink items-center gap-1">
        {parent ? <span className="min-w-0 truncate text-ink-3">{parent} /</span> : null}
        <span className="min-w-0 max-w-full shrink-0 truncate font-medium text-ink">{name}</span>
      </span>
      {scope.map((sym) => (
        <span key={`${sym.line}:${sym.name}`} className="flex min-w-0 shrink items-center gap-1 text-ink-2">
          <NavArrowRight width={12} height={12} className="shrink-0 text-ink-3" />
          <span className="truncate font-mono text-[12px]">{sym.name}</span>
        </span>
      ))}
    </nav>
  );
}
