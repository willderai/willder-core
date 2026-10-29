"use client";

// Ambient page backdrop — a soft cinematic light pool over a textured wall.
// Sits behind all content (the section grounds are translucent over it).
// Decorative only.
//
// The whole field gets a subtle scroll-linked parallax (drifts up ~12% of the
// scroll distance) so it feels alive on long pages instead of pinned-and-dead —
// the outer container stays inset-0 so the frame is always covered (no reveal
// gaps); only the decorative layer moves. Skipped under prefers-reduced-motion.

import { useEffect, useRef } from "react";

// Shared theme tokens keep the ambient ground aligned with both page themes.
export function Backdrop({ className = "" }: { className?: string }) {
  const layerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const layer = layerRef.current;
    if (!layer) return;
    // Nearest scrolling ancestor — the product shell's <main overflow-y-auto>.
    const scroller = layer.closest<HTMLElement>(".overflow-y-auto") ?? layer.parentElement;
    if (!scroller) return;
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;

    let raf = 0;
    const onScroll = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        // Subtle parallax: field drifts up ~12% of scroll, capped so long pages stay covered.
        const dy = Math.min(scroller.scrollTop * 0.12, 260);
        layer.style.transform = `translate3d(0, ${-dy}px, 0)`;
      });
    };
    scroller.addEventListener("scroll", onScroll, { passive: true });
    onScroll();
    return () => {
      scroller.removeEventListener("scroll", onScroll);
      if (raf) cancelAnimationFrame(raf);
    };
  }, []);

  return (
    <div aria-hidden className={`pointer-events-none absolute inset-0 z-0 overflow-hidden ${className}`}>
      <div ref={layerRef} className="absolute inset-0 will-change-transform">
        {/* The field joins the shell without a color seam. */}
        <div
          aria-hidden
          className="absolute inset-0"
          style={{
            background:
              "linear-gradient(155deg, color-mix(in srgb, var(--color-gold) 10%, var(--color-ink)) 0%, var(--color-ink) 66%)",
          }}
        />

        {/* the light source(s) — soft cones that widen going down, like light
          falling from high windows, not bars laid across the wall. A second,
          half-strength cone is duplicated further right so the background
          doesn't read as one single glow — same shape/direction, so it's
          "more of the same light," not a competing second source. */}
        <svg
          aria-hidden
          className="absolute inset-0 h-full w-full"
          style={{ mixBlendMode: "screen", opacity: "var(--texture-strength, 1)" }}
          preserveAspectRatio="none"
          viewBox="0 0 100 100"
        >
          <defs>
            <filter id="light-cone-blur" x="-60%" y="-60%" width="220%" height="220%">
              <feGaussianBlur stdDeviation="5" />
            </filter>
            <linearGradient id="light-cone-fill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="color-mix(in srgb, var(--color-marble) 20%, transparent)" />
              <stop offset="35%" stopColor="color-mix(in srgb, var(--color-gold) 10%, transparent)" />
              <stop offset="60%" stopColor="color-mix(in srgb, var(--color-gold) 3%, transparent)" />
              <stop offset="100%" stopColor="transparent" />
            </linearGradient>
            <linearGradient id="light-cone-fill-half" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="color-mix(in srgb, var(--color-marble) 10%, transparent)" />
              <stop offset="35%" stopColor="color-mix(in srgb, var(--color-gold) 5%, transparent)" />
              <stop offset="60%" stopColor="color-mix(in srgb, var(--color-gold) 1.5%, transparent)" />
              <stop offset="100%" stopColor="transparent" />
            </linearGradient>
          </defs>
          <polygon points="34,0 46,0 76,100 6,100" fill="url(#light-cone-fill)" filter="url(#light-cone-blur)" />
          <polygon points="66,0 76,0 100,100 58,100" fill="url(#light-cone-fill-half)" filter="url(#light-cone-blur)" />
        </svg>

        {/* film-style vignette — frames the shot, deepens the corners */}
        <div
          aria-hidden
          className="absolute inset-0"
          style={{
            background:
              "radial-gradient(ellipse 90% 70% at 62% 28%, transparent 40%, color-mix(in srgb, var(--color-ink) 40%, transparent) 100%)",
          }}
        />
      </div>
    </div>
  );
}
