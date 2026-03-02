/**
 * Pep premium dark theme. Shared by Home, Library, and Profile for visual consistency.
 */
export const pepTheme = {
  background: '#0D0F14',
  backgroundTop: '#151821',
  surface: '#1E2230',
  surfaceSoft: '#262B3A',
  border: 'rgba(255,255,255,0.06)',
  borderSelected: 'rgba(255,255,255,0.15)',
  /** Darker outline for Play/Resume/Stop and Save buttons so they’re easy to see */
  buttonBorder: 'rgba(255,255,255,0.38)',
  text: '#FFFFFF',
  mutedText: '#A8ADB5',
  accent: '#E6E8EB',
  accentWarm: '#C8A46A',
  accentWarmMuted: 'rgba(200,164,106,0.25)',
  error: '#FF4444',
  shadow: 'rgba(0, 0, 0, 0.3)',
} as const;

export type PepTheme = typeof pepTheme;
