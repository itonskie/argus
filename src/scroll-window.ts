export type ScrollWindowInput = {
	totalRows: number;
	focusedIndex: number;
	viewportHeight: number;
	previousScrollTop: number;
};

export type ScrollWindow = {
	startIndex: number;
	endIndex: number;
	scrollTop: number;
	topHidden: number;
	bottomHidden: number;
};

export function computeScrollWindow(input: ScrollWindowInput): ScrollWindow {
	const { totalRows, focusedIndex, viewportHeight, previousScrollTop } = input;

	if (viewportHeight <= 0 || totalRows === 0) {
		return {
			startIndex: 0,
			endIndex: 0,
			scrollTop: 0,
			topHidden: 0,
			bottomHidden: Math.max(0, totalRows),
		};
	}

	let scrollTop: number;
	if (focusedIndex >= 0 && focusedIndex < previousScrollTop) {
		scrollTop = focusedIndex;
	} else if (focusedIndex >= 0 && focusedIndex >= previousScrollTop + viewportHeight) {
		scrollTop = focusedIndex - viewportHeight + 1;
	} else {
		scrollTop = previousScrollTop;
	}

	const maxScrollTop = Math.max(0, totalRows - viewportHeight);
	scrollTop = Math.max(0, Math.min(scrollTop, maxScrollTop));

	const startIndex = scrollTop;
	const endIndex = Math.min(startIndex + viewportHeight, totalRows);
	const topHidden = startIndex;
	const bottomHidden = totalRows - endIndex;

	return { startIndex, endIndex, scrollTop, topHidden, bottomHidden };
}
