// A cached noise tile preserves the shared film texture without a second
// full-screen WebGL context or a perpetual animation loop. Keeping this a
// Server Component also removes decorative JavaScript from every route.
// Opacity and blend mode remain in .grain-overlay for both brand themes.
export function GrainBackground() {
  return (
    <div
      aria-hidden="true"
      className="grain-overlay h-full w-full"
      style={{ backgroundImage: 'url("/grain.png")', backgroundSize: "64px 64px" }}
    />
  );
}
