// Lumi's lantern: a handle ring, a cap, the glass, a base and a teardrop flame with its glow.
// One drawing for the masthead, the home-screen icon and the link preview, so they always match.
// app/icon.svg is a copy on its night tile (Next serves that file as is): keep the two in step.
// The viewBox crops the icon's 64×64 grid to the lantern, so the coordinates are the same.
export default function LanternMark({ className, size }: { className?: string; size?: number }) {
  return (
    <svg
      className={className}
      viewBox="12 4 40 56"
      width={size && (size * 40) / 56}
      height={size}
      aria-hidden="true"
    >
      <defs>
        <radialGradient id="mark-glow">
          <stop offset="0" stopColor="#ffb547" stopOpacity="0.55" />
          <stop offset="1" stopColor="#ffb547" stopOpacity="0" />
        </radialGradient>
        <radialGradient id="mark-flame" cy="0.62" r="0.6">
          <stop offset="0" stopColor="#fffbea" />
          <stop offset="0.25" stopColor="#ffe39a" />
          <stop offset="0.55" stopColor="#ffb547" />
          <stop offset="1" stopColor="#e8742a" />
        </radialGradient>
      </defs>
      <circle cx="32" cy="40" r="18" fill="url(#mark-glow)" />
      <circle cx="32" cy="12.5" r="5" fill="none" stroke="#ffb547" strokeWidth="3.5" />
      <rect x="22" y="17.5" width="20" height="5" rx="2.5" fill="#ffb547" />
      <rect x="18" y="23.5" width="28" height="30" rx="9" fill="#ffb547" fillOpacity="0.08" stroke="#ffb547" strokeWidth="3.5" />
      <rect x="22" y="53.5" width="20" height="4.5" rx="2.25" fill="#ffb547" />
      <path className="mark-flame" d="M32 29.9 L37.3 35.2 A7.5 7.5 0 1 1 26.7 35.2 Z" fill="url(#mark-flame)" />
    </svg>
  );
}
