// UI environment flags — parsed once at App root, threaded down to any
// component whose rendering depends on them. Kept intentionally small so the
// rest of the codebase doesn't have to touch `process.env` directly.

export type UiEnv = {
	noColor: boolean;
	reducedMotion: boolean;
	ascii: boolean;
};

// NO_COLOR: no-color.org spec — any non-empty value disables color.
// PREFERS_REDUCED_MOTION: any non-empty value degrades spinners.
// ARGUS_ASCII: explicit `1` opts into ASCII borders + spinner glyphs.
export function readUiEnv(env: NodeJS.ProcessEnv = process.env): UiEnv {
	return {
		noColor: typeof env.NO_COLOR === 'string' && env.NO_COLOR.length > 0,
		reducedMotion:
			typeof env.PREFERS_REDUCED_MOTION === 'string' && env.PREFERS_REDUCED_MOTION.length > 0,
		ascii: env.ARGUS_ASCII === '1',
	};
}
