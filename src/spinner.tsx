import { Text } from 'ink';
import type React from 'react';
import { useEffect, useState } from 'react';
import type { UiEnv } from './env.js';

// design-spec §5.2: braille dot rotation at 80ms/frame. ASCII fallback is the
// classic `|/-\` cycle. Under PREFERS_REDUCED_MOTION we render a static `…`.
const BRAILLE_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const ASCII_FRAMES = ['|', '/', '-', '\\'];
const FRAME_MS = 80;

export function Spinner({ env }: { env: UiEnv }): React.ReactElement {
	const frames = env.ascii ? ASCII_FRAMES : BRAILLE_FRAMES;
	const [i, setI] = useState(0);

	useEffect(() => {
		// design-spec §6: under reduced motion the glyph stays `…` but we still
		// re-render once per second as a heartbeat so the app doesn't look frozen.
		const period = env.reducedMotion ? 1000 : FRAME_MS;
		const t = setInterval(() => setI((n) => n + 1), period);
		return () => clearInterval(t);
	}, [env.reducedMotion]);

	if (env.reducedMotion) return <Text>…</Text>;
	return <Text>{frames[i % frames.length]}</Text>;
}
