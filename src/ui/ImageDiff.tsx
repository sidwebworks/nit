import type { FileDiffMetadata } from "@pierre/diffs";
import { useEffect, useState } from "react";

/** The images shown as pictures, not as a "binary files differ" diff (cli.ts serves the same list). */
const IMAGE = /\.(png|jpe?g|gif|webp|avif|bmp|ico|svg)$/i;
export const isImage = (name: string) => IMAGE.test(name);

type Loaded = { src: string; bytes: number; width?: number; height?: number } | "missing" | null;

/** One side's image, fetched as a blob so its size is known; `version` (the git object id) busts the cache. */
function useImage(side: "old" | "new", path: string | null, version: string | undefined): Loaded {
  const [loaded, setLoaded] = useState<Loaded>(null);
  useEffect(() => {
    setLoaded(null);
    if (!path) return;
    let src = "";
    let live = true;
    const q = new URLSearchParams({ side, path, v: version ?? "" });
    fetch(`/api/image?${q}`)
      .then((r) => (r.ok ? r.blob() : null))
      .then((blob) => {
        if (!live) return;
        if (!blob) return setLoaded("missing");
        src = URL.createObjectURL(blob);
        setLoaded({ src, bytes: blob.size });
      })
      .catch(() => live && setLoaded("missing"));
    return () => {
      live = false;
      if (src) URL.revokeObjectURL(src);
    };
  }, [side, path, version]);
  return loaded;
}

const size = (n: number) =>
  n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`;

function Side({ label, image, tone }: { label: string; image: Loaded; tone: "red" | "green" }) {
  const [dims, setDims] = useState<{ w: number; h: number } | null>(null);
  const src = image && image !== "missing" ? image.src : null;
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new picture is measured afresh
  useEffect(() => setDims(null), [src]);
  return (
    <figure className="flex min-h-0 min-w-0 flex-1 flex-col gap-2">
      <figcaption className="flex items-center gap-2 text-[12px] text-ink-3 tabular-nums">
        <span className={`font-medium ${tone === "red" ? "text-red" : "text-green"}`}>{label}</span>
        {dims ? (
          <span>
            {dims.w} × {dims.h}
          </span>
        ) : null}
        {image && image !== "missing" ? <span>{size(image.bytes)}</span> : null}
      </figcaption>
      <div className="image-backdrop relative grid min-h-40 flex-1 place-items-center rounded-card shadow-[inset_0_0_0_1px_var(--line)]">
        {src ? (
          <img
            src={src}
            alt={label}
            className="absolute inset-4 m-auto max-h-[calc(100%-2rem)] max-w-[calc(100%-2rem)] object-contain"
            onLoad={(e) => setDims({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })}
          />
        ) : image === "missing" ? (
          <span className="text-[12.5px] text-ink-3">Couldn't load this image</span>
        ) : null}
      </div>
    </figure>
  );
}

/** A changed image: before and after, side by side in split layout or stacked in unified. */
export function ImageDiff({ file, layout }: { file: FileDiffMetadata; layout: "split" | "unified" }) {
  const hasOld = file.type !== "new";
  const hasNew = file.type !== "deleted";
  const before = useImage("old", hasOld ? (file.prevName ?? file.name) : null, file.prevObjectId);
  const after = useImage("new", hasNew ? file.name : null, file.newObjectId);
  return (
    <div className={`flex h-full gap-4 p-4 ${layout === "split" ? "flex-row" : "flex-col"}`}>
      {hasOld ? <Side label={hasNew ? "Before" : "Deleted"} image={before} tone="red" /> : null}
      {hasNew ? <Side label={hasOld ? "After" : "Added"} image={after} tone="green" /> : null}
    </div>
  );
}
