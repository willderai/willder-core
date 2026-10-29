"use client";

import { animate, useInView, useReducedMotion } from "framer-motion";
import { useEffect, useRef } from "react";

/**
 * A measured figure that counts up from zero as it scrolls into view.
 *
 * Adapted from Magic UI's Number Ticker (MIT, found through the 21st.dev
 * catalog). It differs from the original in one rule: the figure must read without
 * JavaScript, the same rule `reveal.tsx` follows. So the server renders the
 * final value, not zero, and the count only arms after hydration, only while
 * the figure is still below the fold, and never under prefers-reduced-motion.
 * A figure that is already on screen at mount stays put instead of flashing
 * back to zero.
 *
 * `format` maps progress (0 to 1) to the text shown, so one component covers
 * "25/25", "4.3s" and "15s / 21s / 1,059s" alike. Pass a stable function
 * (module-level), since it is only read when the count starts.
 *
 * Three spans, each for one reader: screen readers get the final value only,
 * never a mid-count "0/25"; an invisible copy of the final value holds the
 * width so the count never reflows the card; the animated copy sits on top.
 */
export function CountUp({
  format,
  duration = 1.5,
  delay = 0,
  className = "",
}: {
  format: (progress: number) => string;
  duration?: number;
  delay?: number;
  className?: string;
}) {
  const counterRef = useRef<HTMLSpanElement>(null);
  const armed = useRef(false);
  const reduceMotion = useReducedMotion();
  const inView = useInView(counterRef, { once: true, amount: "all" });
  const finalText = format(1);

  useEffect(() => {
    const counter = counterRef.current;
    if (!counter || reduceMotion || armed.current) return;
    if (counter.getBoundingClientRect().top < window.innerHeight) return;
    counter.textContent = format(0);
    armed.current = true;
  }, [format, reduceMotion]);

  useEffect(() => {
    const counter = counterRef.current;
    if (!counter || !inView || !armed.current) return;
    const controls = animate(0, 1, {
      duration,
      delay,
      ease: "easeOut",
      onUpdate: (progress) => {
        counter.textContent = format(progress);
      },
    });
    return () => {
      controls.stop();
      counter.textContent = format(1);
    };
  }, [inView, format, duration, delay]);

  return (
    <span className={`inline-grid tabular-nums ${className}`}>
      <span className="sr-only">{finalText}</span>
      <span aria-hidden="true" className="invisible col-start-1 row-start-1">
        {finalText}
      </span>
      <span aria-hidden="true" ref={counterRef} className="col-start-1 row-start-1">
        {finalText}
      </span>
    </span>
  );
}
