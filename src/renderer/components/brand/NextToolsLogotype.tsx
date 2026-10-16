interface NextToolsLogotypeProps {
  variant?: 'display' | 'compact';
  className?: string;
  /** Omit when the surrounding control already names the brand. */
  title?: string;
}

export function NextToolsLogotype({ variant = 'display', className, title }: NextToolsLogotypeProps) {
  return (
    <svg
      viewBox="0 0 304 56"
      className={className}
      role={title ? 'img' : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
      focusable="false"
      data-nexttools-logotype
    >
      <text
        x="0"
        y="44"
        fill="currentColor"
        fontFamily="Inter, Arial, sans-serif"
        fontSize="52"
        fontWeight={variant === 'compact' ? 750 : 650}
        letterSpacing="-2"
        textLength="302"
        lengthAdjust="spacingAndGlyphs"
      >
        NextTools
      </text>
    </svg>
  );
}
