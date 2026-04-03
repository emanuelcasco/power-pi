/**
 * ReviewerComponent — Interactive TUI for reviewing code review comments
 */

import type { Theme } from "@mariozechner/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@mariozechner/pi-tui";
import type { KeyId } from "@mariozechner/pi-tui";
import type { CommentSeverity, CommentStatus, ReviewAction, ReviewComment } from "./common.js";

function severityColor(severity: CommentSeverity): "error" | "warning" | "accent" | "muted" {
	switch (severity) {
		case "error":
			return "error";
		case "warning":
			return "warning";
		case "suggestion":
			return "accent";
		case "info":
			return "muted";
	}
}

function severityLabel(severity: CommentSeverity): string {
	switch (severity) {
		case "error":
			return "!! error";
		case "warning":
			return "!  warning";
		case "suggestion":
			return "*  suggestion";
		case "info":
			return "i  info";
	}
}

function statusIcon(status: CommentStatus): string {
	switch (status) {
		case "approved":
			return "✓";
		case "dismissed":
			return "✗";
		case "edited":
			return "✎";
		case "pending":
			return "○";
	}
}

function statusColor(status: CommentStatus): "success" | "error" | "accent" | "warning" {
	switch (status) {
		case "approved":
			return "success";
		case "dismissed":
			return "error";
		case "edited":
			return "accent";
		case "pending":
			return "warning";
	}
}

export class ReviewerComponent {
	private comments: ReviewComment[];
	private currentIndex: number;
	private theme: Theme;
	private onDone: (action: ReviewAction) => void;
	private cachedWidth?: number;
	private cachedLines?: string[];

	constructor(comments: ReviewComment[], startIndex: number, theme: Theme, onDone: (action: ReviewAction) => void) {
		this.comments = comments;
		this.currentIndex = Math.max(0, Math.min(startIndex, comments.length - 1));
		this.theme = theme;
		this.onDone = onDone;
	}

	handleInput(data: string): void {
		if (this.comments.length === 0) {
			if (matchesKey(data, Key.escape) || data === "q") this.onDone({ type: "cancel" });
			return;
		}

		const comment = this.comments[this.currentIndex]!;
		if (matchesKey(data, Key.up) || matchesKey(data, Key.ctrl("k"))) {
			if (this.currentIndex > 0) {
				this.currentIndex--;
				this.invalidate();
			}
			return;
		}
		if (matchesKey(data, Key.down) || matchesKey(data, Key.ctrl("j"))) {
			if (this.currentIndex < this.comments.length - 1) {
				this.currentIndex++;
				this.invalidate();
			}
			return;
		}
		if (data === "[") {
			for (let i = this.currentIndex - 1; i >= 0; i--) {
				if (this.comments[i]!.file !== comment.file) {
					this.currentIndex = i;
					this.invalidate();
					return;
				}
			}
			return;
		}
		if (data === "]") {
			for (let i = this.currentIndex + 1; i < this.comments.length; i++) {
				if (this.comments[i]!.file !== comment.file) {
					this.currentIndex = i;
					this.invalidate();
					return;
				}
			}
			return;
		}
		if (matchesKey(data, Key.ctrl("a"))) {
			comment.status = comment.status === "approved" ? "pending" : "approved";
			this.invalidate();
			return;
		}
		if (matchesKey(data, Key.ctrl("d"))) {
			comment.status = comment.status === "dismissed" ? "pending" : "dismissed";
			this.invalidate();
			return;
		}
		if (matchesKey(data, Key.ctrl("e")) || matchesKey(data, Key.enter)) {
			this.onDone({ type: "edit", index: this.currentIndex });
			return;
		}
		if (matchesKey(data, Key.ctrl("p"))) {
			for (const c of this.comments) if (c.status === "pending") c.status = "approved";
			this.invalidate();
			return;
		}
		if (matchesKey(data, Key.ctrl("s"))) {
			this.onDone({ type: "submit" });
			return;
		}
		if (matchesKey(data, Key.escape) || data === "q") {
			this.onDone({ type: "cancel" });
		}
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;
		const th = this.theme;
		const lines: string[] = [];
		const maxW = Math.max(40, Math.min(width, 120));
		const innerW = Math.max(20, maxW - 2);

		const row = (content = "") => {
			const fitted = visibleWidth(content) > innerW ? truncateToWidth(content, innerW) : content;
			const padding = Math.max(0, innerW - visibleWidth(fitted));
			lines.push(th.fg("border", "│") + fitted + " ".repeat(padding) + th.fg("border", "│"));
		};

		const addWrapped = (content: string, prefix = "") => {
			const available = Math.max(8, innerW - visibleWidth(prefix));
			for (const part of wrapTextWithAnsi(content, available)) {
				row(prefix + part);
			}
		};

		const divider = () => row(th.fg("dim", "─".repeat(innerW)));
		const top = () => lines.push(th.fg("border", `╭${"─".repeat(innerW)}╮`));
		const bottom = () => lines.push(th.fg("border", `╰${"─".repeat(innerW)}╯`));

		const approved = this.comments.filter((c) => c.status === "approved" || c.status === "edited").length;
		const dismissed = this.comments.filter((c) => c.status === "dismissed").length;
		const pending = this.comments.filter((c) => c.status === "pending").length;

		top();
		row(
			th.fg("accent", th.bold(" Code Review ")) +
				th.fg("muted", ` ${this.currentIndex + 1}/${this.comments.length} `) +
				th.fg("dim", "│ ") +
				[th.fg("success", `✓${approved}`), th.fg("error", `✗${dismissed}`), th.fg("warning", `○${pending}`)].join(
					th.fg("dim", " │ "),
				),
		);
		divider();

		if (this.comments.length === 0) {
			row("");
			addWrapped(th.fg("dim", "No comments to review"), "  ");
			row("");
			addWrapped(th.fg("dim", "Esc/q close"), "  ");
			bottom();
			this.cachedLines = lines;
			this.cachedWidth = width;
			return lines;
		}

		const comment = this.comments[this.currentIndex]!;
		row("");
		const lineInfo = comment.endLine
			? `${th.fg("warning", String(comment.line))}${th.fg("dim", "-")}${th.fg("warning", String(comment.endLine))}`
			: th.fg("warning", String(comment.line));
		addWrapped(`${th.fg("accent", comment.file)}${th.fg("dim", ":")}${lineInfo}`, "  ");
		row("");

		if (comment.codeContext) {
			const ctxLines = comment.codeContext.split("\n");
			for (const cl of ctxLines.slice(0, 12)) {
				const styled = cl.startsWith("+")
					? th.fg("toolDiffAdded", cl)
					: cl.startsWith("-")
						? th.fg("toolDiffRemoved", cl)
						: th.fg("toolDiffContext", cl);
				addWrapped(styled, `  ${th.fg("dim", "┃")} `);
			}
			if (ctxLines.length > 12) addWrapped(th.fg("dim", `... ${ctxLines.length - 12} more lines`), `  ${th.fg("dim", "┃ ")}`);
			row("");
		}

		addWrapped(th.fg(severityColor(comment.severity), severityLabel(comment.severity)), "  ");
		divider();
		row("");
		for (const bl of comment.body.split("\n").slice(0, 20)) addWrapped(th.fg("text", bl), "  ");
		if (comment.body.split("\n").length > 20) addWrapped(th.fg("dim", `... ${comment.body.split("\n").length - 20} more lines`), "  ");
		if (comment.status === "edited" && comment.originalBody) {
			row("");
			addWrapped(th.fg("dim", "original: " + comment.originalBody), "  ");
		}
		row("");
		addWrapped(th.fg(statusColor(comment.status), `${statusIcon(comment.status)} ${comment.status.charAt(0).toUpperCase() + comment.status.slice(1)}`), "  ");
		divider();
		row("");

		const maxDots = 40;
		let dotsSlice = this.comments;
		let dotsOffset = 0;
		let prefixEllipsis = false;
		let suffixEllipsis = false;
		if (this.comments.length > maxDots) {
			const half = Math.floor(maxDots / 2);
			let start = Math.max(0, this.currentIndex - half);
			let end = start + maxDots;
			if (end > this.comments.length) {
				end = this.comments.length;
				start = Math.max(0, end - maxDots);
			}
			dotsSlice = this.comments.slice(start, end);
			dotsOffset = start;
			prefixEllipsis = start > 0;
			suffixEllipsis = end < this.comments.length;
		}
		const dots = dotsSlice
			.map((c, i) => {
				const idx = dotsOffset + i;
				return th.fg(idx === this.currentIndex ? "accent" : statusColor(c.status), idx === this.currentIndex ? "●" : statusIcon(c.status));
			})
			.join(" ");
		addWrapped(`${prefixEllipsis ? th.fg("dim", "… ") : ""}${dots}${suffixEllipsis ? th.fg("dim", " …") : ""}`, "  ");
		row("");
		addWrapped(th.fg("dim", "↑↓/^j^k navigate  [/] prev/next file  ^a approve  ^d dismiss  ^e/Enter edit"), "  ");
		addWrapped(th.fg("dim", "^p approve pending  ^s submit  Esc/q cancel"), "  ");
		bottom();
		this.cachedLines = lines;
		this.cachedWidth = width;
		return lines;
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}
}
