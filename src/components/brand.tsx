export function BrandMark({ size = 30 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 40 40" fill="none" aria-hidden="true">
      <g stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
        <path d="m20 3.5 14.3 8.25v16.5L20 36.5 5.7 28.25v-16.5Z" />
        <path d="M5.7 11.75 20 20l14.3-8.25M20 20v16.5M12.85 7.625l14.3 8.25v8.25l-14.3 8.25M27.15 7.625l-14.3 8.25v8.25l14.3 8.25" />
      </g>
    </svg>
  );
}
