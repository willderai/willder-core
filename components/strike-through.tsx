"use client";

import { animate, useInView, useReducedMotion } from "framer-motion";
import { useEffect, useRef } from "react";

/**
 * Old-way text with a line drawn through it as it scrolls into view.
 *
 * Adapted from Hirael's Comparison 3 (MIT, found through the 21st.dev
 * catalog), which marks the old way with crosses. The drawn strike is our
 * addition: it shows the old way being replaced rather than only listed.
 *
 * Same rule as `count-up.tsx`: the page must read without JavaScript, so the
 * server renders the strike already drawn. The draw only arms after hydration,
 * only while the text is still below the fold, and never under
 * prefers-reduced-motion. Text already on screen at mount keeps its strike.
 *
 * The strike is a background gradient on an inline span rather than
 * `text-decoration`, because a background can be sized: growing its width
 * from 0% to 100% draws the line across every wrapped line in reading order.
 * The words themselves are never hidden, dimmed or moved.
 */
export function StrikeThrough({ children, delay = 0 }: { children: React.ReactNode; delay?: number }) {
  const strikeRef = useRef<HTMLSpanElement>(null);
  const armed = useRef(false);
  const reduceMotion = useReducedMotion();
  const inView = useInView(strikeRef, { once: true, amount: "all" });

  useEffect(() => {
    const strike = strikeRef.current;
    if (!strike || reduceMotion || armed.current) return;
    if (strike.getBoundingClientRect().top < window.innerHeight) return;
    strike.style.backgroundSize = strikeWidth(0);
    armed.current = true;
  }, [reduceMotion]);

  useEffect(() => {
    const strike = strikeRef.current;
    if (!strike || !inView || !armed.current) return;
    const controls = animate(0, 1, {
      duration: 0.5,
      delay,
      ease: "easeOut",
      onUpdate: (progress) => {
        strike.style.backgroundSize = strikeWidth(progress);
      },
    });
    return () => {
      controls.stop();
      strike.style.backgroundSize = "";
    };
  }, [inView, delay]);

  return (
    <span
      ref={strikeRef}
      data-strike
      className="bg-[linear-gradient(currentColor,currentColor)] bg-[length:100%_1px] bg-[position:0_55%] bg-no-repeat"
    >
      {children}
    </span>
  );
}

function strikeWidth(progress: number) {
  return `${progress * 100}% 1px`;
}
