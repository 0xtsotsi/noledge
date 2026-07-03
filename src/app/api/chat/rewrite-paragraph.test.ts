import { describe, expect, it } from "vitest";
import { splitParagraphs } from "./split-paragraphs";

describe("splitParagraphs (rewrite-paragraph helper)", () => {
	it("splits on blank lines and trims whitespace", () => {
		const text = "First paragraph.\n\nSecond.\n\n\n  Third  ";
		expect(splitParagraphs(text)).toEqual([
			"First paragraph.",
			"Second.",
			"Third",
		]);
	});

	it("returns a single element when there are no blank lines", () => {
		expect(splitParagraphs("Just one paragraph.")).toEqual([
			"Just one paragraph.",
		]);
	});

	it("drops empty paragraphs", () => {
		const text = "A.\n\n\n\nB.";
		expect(splitParagraphs(text)).toEqual(["A.", "B."]);
	});
});
