/** Inline SVG PATi bee-bot avatar — matches brand colors */
export default function PatiIcon({ size = 24, className = '' }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg" className={className}>
      {/* Body */}
      <ellipse cx="32" cy="36" rx="18" ry="20" fill="#0D1117"/>
      {/* Visor */}
      <ellipse cx="32" cy="30" rx="15" ry="13" fill="#1a2332"/>
      <ellipse cx="32" cy="30" rx="13" ry="11" fill="#0a1628"/>
      {/* Eyes glow */}
      <ellipse cx="25" cy="29" rx="4" ry="4.5" fill="#0057FF" opacity="0.9"/>
      <ellipse cx="39" cy="29" rx="4" ry="4.5" fill="#0057FF" opacity="0.9"/>
      <ellipse cx="25" cy="28.5" rx="2" ry="2" fill="#5eaaff" opacity="0.6"/>
      <ellipse cx="39" cy="28.5" rx="2" ry="2" fill="#5eaaff" opacity="0.6"/>
      {/* Bee stripes */}
      <rect x="20" y="40" width="24" height="4" rx="2" fill="#FFC107"/>
      <rect x="22" y="46" width="20" height="4" rx="2" fill="#FFC107"/>
      <rect x="24" y="52" width="16" height="3" rx="1.5" fill="#FFC107"/>
      {/* Antennae */}
      <line x1="26" y1="18" x2="22" y2="8" stroke="#E6E8ED" strokeWidth="2" strokeLinecap="round"/>
      <line x1="38" y1="18" x2="42" y2="8" stroke="#E6E8ED" strokeWidth="2" strokeLinecap="round"/>
      <circle cx="22" cy="7" r="3" fill="#FF6A00"/>
      <circle cx="42" cy="7" r="3" fill="#FF6A00"/>
      {/* Wings */}
      <ellipse cx="12" cy="28" rx="8" ry="5" fill="#0057FF" opacity="0.2" transform="rotate(-20 12 28)"/>
      <ellipse cx="52" cy="28" rx="8" ry="5" fill="#0057FF" opacity="0.2" transform="rotate(20 52 28)"/>
      {/* "pd" badge */}
      <circle cx="32" cy="38" r="5" fill="#0057FF" opacity="0.7"/>
      <text x="32" y="40.5" textAnchor="middle" fontSize="6" fontWeight="bold" fill="white" fontFamily="sans-serif">pd</text>
    </svg>
  );
}
