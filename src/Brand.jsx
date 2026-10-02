// Marque Akram Distribution.
// SVG inline et autonome : rendu identique dans l'application et sur les
// factures imprimées (aucune requête réseau, donc rien à charger à l'impression).

export function Logo({ size = 34, withWordmark = true, mono = false }) {
  const badge = mono ? '#0f2417' : '#16a34a';
  const glyph = '#ffffff';
  const accent = mono ? '#0f2417' : '#f59e0b';
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 10 }}>
      <svg width={size} height={size} viewBox="0 0 48 48" fill="none" aria-label="Akram Distribution">
        <rect x="2" y="2" width="44" height="44" rx="13" fill={badge} />
        {/* A */}
        <path d="M16 33.5 L24 14 L32 33.5" stroke={glyph} strokeWidth="3.2"
              strokeLinecap="round" strokeLinejoin="round" fill="none" />
        <path d="M19.6 26 H28.4" stroke={glyph} strokeWidth="3.2" strokeLinecap="round" />
        {/* trait de mouvement : la distribution */}
        <path d="M9.5 38.5 H38.5" stroke={accent} strokeWidth="3" strokeLinecap="round" />
      </svg>
      {withWordmark && (
        <span style={{ display: 'inline-flex', flexDirection: 'column', lineHeight: 1 }}>
          <span style={{ fontWeight: 800, fontSize: size * 0.52, letterSpacing: '-0.02em', color: mono ? '#0f2417' : '#14532d' }}>
            Akram
          </span>
          <span style={{ fontWeight: 600, fontSize: size * 0.22, letterSpacing: '0.18em', color: mono ? '#334155' : '#16a34a', marginTop: 3 }}>
            DISTRIBUTION
          </span>
        </span>
      )}
    </span>
  );
}

export const BRAND = {
  name: 'Akram Distribution',
  tagline: 'Distribution',
};
