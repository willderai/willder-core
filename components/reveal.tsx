"use client";

import { motion, useReducedMotion } from "framer-motion";

// Rise on scroll into view. Keep the server-rendered copy readable even when
// JavaScript is unavailable or hydration is delayed.
//
// Under prefers-reduced-motion the block settles in place as soon as it
// hydrates, with no transition, instead of rising when scrolled to. The
// starting offset itself never depends on the preference: the server cannot
// read it, so a client that skipped the offset would hydrate against markup
// it did not render, and React keeps the server's transform in that case,
// leaving the block stuck 24px low.
export function Reveal({
  children,
  delay = 0,
  className = "",
  as = "div",
}: {
  children: React.ReactNode;
  delay?: number;
  className?: string;
  as?: "div" | "section" | "li" | "figure";
}) {
  const MotionTag = motion[as];
  const reduceMotion = useReducedMotion();
  return (
    <MotionTag
      className={className}
      initial={{ y: 24 }}
      animate={reduceMotion ? { y: 0 } : undefined}
      whileInView={reduceMotion ? undefined : { y: 0 }}
      viewport={{ once: true, margin: "-80px" }}
      transition={reduceMotion ? { duration: 0 } : { duration: 0.6, delay, ease: [0.22, 1, 0.36, 1] }}
    >
      {children}
    </MotionTag>
  );
}
