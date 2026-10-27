import { css, type FC } from "dreamland/core";

export function TextField(
	this: FC<{
		"on:keydown"?: (event: KeyboardEvent) => void;
		"on:input"?: (event: Event) => void;
		value: string;
		placeholder?: string;
		class?: string;
		type?: string;
	}>,
) {
	return (
		<input
			type={use(this.type).map((type) => type || "text")}
			class={use(this.class).map(
				(className) => `component-textfield ${className || ""}`,
			)}
			placeholder={use(this.placeholder)}
			value={use(this.value)}
			on:keydown={this["on:keydown"] || (() => {})}
			on:input={this["on:input"] || (() => {})}
		/>
	);
}
TextField.style = css`
	:scope {
		min-width: 0;
		border: 0.1rem solid var(--surface1);
		border-radius: 4rem;
		background: var(--bg-sub);
		color: var(--fg);
		padding: 0.5em 0.5em 0.5em 0.75rem;
		font-family: var(--font-body);
		transition: border-color 0.1s ease;
	}
	:scope:hover {
		border-color: var(--surface2);
	}
	:scope:focus {
		border-color: var(--accent);
		outline: 2px solid var(--accent);
		outline-offset: 2px;
	}
	:scope::placeholder {
		color: var(--surface5);
	}
`;
