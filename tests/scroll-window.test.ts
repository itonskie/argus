import { describe, expect, it } from 'vitest';
import { computeScrollWindow } from '../src/scroll-window.js';

describe('computeScrollWindow', () => {
	it('focused row already inside the window — no scroll', () => {
		// TDD entry-point case from ticket #21.
		expect(
			computeScrollWindow({
				totalRows: 5,
				focusedIndex: 2,
				viewportHeight: 3,
				previousScrollTop: 0,
			}),
		).toEqual({
			startIndex: 0,
			endIndex: 3,
			scrollTop: 0,
			topHidden: 0,
			bottomHidden: 2,
		});
	});

	it('focused above window scrolls up so focused becomes the top row', () => {
		expect(
			computeScrollWindow({
				totalRows: 6,
				focusedIndex: 1,
				viewportHeight: 3,
				previousScrollTop: 3,
			}),
		).toEqual({
			startIndex: 1,
			endIndex: 4,
			scrollTop: 1,
			topHidden: 1,
			bottomHidden: 2,
		});
	});

	it('focused below window scrolls down so focused becomes the bottom row', () => {
		expect(
			computeScrollWindow({
				totalRows: 6,
				focusedIndex: 5,
				viewportHeight: 3,
				previousScrollTop: 0,
			}),
		).toEqual({
			startIndex: 3,
			endIndex: 6,
			scrollTop: 3,
			topHidden: 3,
			bottomHidden: 0,
		});
	});

	it('totalRows ≤ viewportHeight → single non-scrollable window', () => {
		expect(
			computeScrollWindow({
				totalRows: 3,
				focusedIndex: 1,
				viewportHeight: 5,
				previousScrollTop: 0,
			}),
		).toEqual({
			startIndex: 0,
			endIndex: 3,
			scrollTop: 0,
			topHidden: 0,
			bottomHidden: 0,
		});
	});

	it('focusedIndex === 0 with a previously scrolled-down window snaps back to top', () => {
		expect(
			computeScrollWindow({
				totalRows: 10,
				focusedIndex: 0,
				viewportHeight: 3,
				previousScrollTop: 5,
			}),
		).toEqual({
			startIndex: 0,
			endIndex: 3,
			scrollTop: 0,
			topHidden: 0,
			bottomHidden: 7,
		});
	});

	it('focusedIndex === totalRows − 1 with prevScrollTop=0 scrolls to bottom', () => {
		expect(
			computeScrollWindow({
				totalRows: 10,
				focusedIndex: 9,
				viewportHeight: 3,
				previousScrollTop: 0,
			}),
		).toEqual({
			startIndex: 7,
			endIndex: 10,
			scrollTop: 7,
			topHidden: 7,
			bottomHidden: 0,
		});
	});

	it('preserves previousScrollTop when focused stays inside the window', () => {
		// Selection moves 3→4 within a window already at scrollTop=3, viewport=3
		// (rows 3,4,5 visible). No scroll change.
		expect(
			computeScrollWindow({
				totalRows: 10,
				focusedIndex: 4,
				viewportHeight: 3,
				previousScrollTop: 3,
			}),
		).toEqual({
			startIndex: 3,
			endIndex: 6,
			scrollTop: 3,
			topHidden: 3,
			bottomHidden: 4,
		});
	});

	it('scrolls exactly one row when focus moves one past the bottom edge', () => {
		// prevScrollTop=0, viewport=3 shows rows 0,1,2. Moving to 3 scrolls down one.
		expect(
			computeScrollWindow({
				totalRows: 10,
				focusedIndex: 3,
				viewportHeight: 3,
				previousScrollTop: 0,
			}),
		).toEqual({
			startIndex: 1,
			endIndex: 4,
			scrollTop: 1,
			topHidden: 1,
			bottomHidden: 6,
		});
	});

	it('scrolls exactly one row when focus moves one past the top edge', () => {
		// prevScrollTop=3, viewport=3 shows rows 3,4,5. Moving to 2 scrolls up one.
		expect(
			computeScrollWindow({
				totalRows: 10,
				focusedIndex: 2,
				viewportHeight: 3,
				previousScrollTop: 3,
			}),
		).toEqual({
			startIndex: 2,
			endIndex: 5,
			scrollTop: 2,
			topHidden: 2,
			bottomHidden: 5,
		});
	});

	it('viewportHeight 1 keeps focused row alone in the window', () => {
		expect(
			computeScrollWindow({
				totalRows: 5,
				focusedIndex: 2,
				viewportHeight: 1,
				previousScrollTop: 0,
			}),
		).toEqual({
			startIndex: 2,
			endIndex: 3,
			scrollTop: 2,
			topHidden: 2,
			bottomHidden: 2,
		});
	});

	it('degenerate: viewportHeight ≤ 0 returns a zero-length window at the top', () => {
		expect(
			computeScrollWindow({
				totalRows: 5,
				focusedIndex: 2,
				viewportHeight: 0,
				previousScrollTop: 0,
			}),
		).toEqual({
			startIndex: 0,
			endIndex: 0,
			scrollTop: 0,
			topHidden: 0,
			bottomHidden: 5,
		});
		expect(
			computeScrollWindow({
				totalRows: 5,
				focusedIndex: 2,
				viewportHeight: -3,
				previousScrollTop: 0,
			}),
		).toEqual({
			startIndex: 0,
			endIndex: 0,
			scrollTop: 0,
			topHidden: 0,
			bottomHidden: 5,
		});
	});

	it('degenerate: totalRows === 0 returns a zero window and no negatives', () => {
		expect(
			computeScrollWindow({
				totalRows: 0,
				focusedIndex: -1,
				viewportHeight: 3,
				previousScrollTop: 0,
			}),
		).toEqual({
			startIndex: 0,
			endIndex: 0,
			scrollTop: 0,
			topHidden: 0,
			bottomHidden: 0,
		});
	});

	it('degenerate: focusedIndex === -1 uses previousScrollTop and does not clamp to focus', () => {
		expect(
			computeScrollWindow({
				totalRows: 10,
				focusedIndex: -1,
				viewportHeight: 3,
				previousScrollTop: 4,
			}),
		).toEqual({
			startIndex: 4,
			endIndex: 7,
			scrollTop: 4,
			topHidden: 4,
			bottomHidden: 3,
		});
	});

	it('clamps a previousScrollTop that is beyond the last valid position', () => {
		// prevScrollTop=99, totalRows=5, viewport=3 → maxScrollTop=2, clamps to 2.
		expect(
			computeScrollWindow({
				totalRows: 5,
				focusedIndex: -1,
				viewportHeight: 3,
				previousScrollTop: 99,
			}),
		).toEqual({
			startIndex: 2,
			endIndex: 5,
			scrollTop: 2,
			topHidden: 2,
			bottomHidden: 0,
		});
	});

	it('clamps a negative previousScrollTop to 0', () => {
		expect(
			computeScrollWindow({
				totalRows: 5,
				focusedIndex: -1,
				viewportHeight: 3,
				previousScrollTop: -4,
			}),
		).toEqual({
			startIndex: 0,
			endIndex: 3,
			scrollTop: 0,
			topHidden: 0,
			bottomHidden: 2,
		});
	});

	it('invariant: topHidden + (endIndex − startIndex) + bottomHidden === totalRows in every non-degenerate case', () => {
		const cases = [
			{ totalRows: 20, focusedIndex: 0, viewportHeight: 5, previousScrollTop: 10 },
			{ totalRows: 20, focusedIndex: 19, viewportHeight: 5, previousScrollTop: 0 },
			{ totalRows: 20, focusedIndex: 10, viewportHeight: 5, previousScrollTop: 8 },
			{ totalRows: 20, focusedIndex: 7, viewportHeight: 5, previousScrollTop: 4 },
			{ totalRows: 20, focusedIndex: -1, viewportHeight: 5, previousScrollTop: 12 },
			{ totalRows: 3, focusedIndex: 1, viewportHeight: 5, previousScrollTop: 0 },
			{ totalRows: 1, focusedIndex: 0, viewportHeight: 3, previousScrollTop: 0 },
		];
		for (const input of cases) {
			const w = computeScrollWindow(input);
			expect(w.topHidden).toBeGreaterThanOrEqual(0);
			expect(w.bottomHidden).toBeGreaterThanOrEqual(0);
			expect(w.startIndex).toBeGreaterThanOrEqual(0);
			expect(w.endIndex).toBeGreaterThanOrEqual(w.startIndex);
			expect(w.scrollTop).toBe(w.startIndex);
			expect(w.topHidden + (w.endIndex - w.startIndex) + w.bottomHidden).toBe(input.totalRows);
		}
	});
});
