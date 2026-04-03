declare module "@clack/prompts" {
	export function cancel(message: string): void;
	export function confirm(options: {
		message: string;
		initialValue?: boolean;
	}): Promise<unknown>;
	export function intro(message: string): void;
	export function isCancel(value: unknown): boolean;
	export const log: {
		step(message: string): void;
		success(message: string): void;
		info(message: string): void;
		error(message: string): void;
	};
	export function outro(message: string): void;
	export function text(options: {
		message: string;
		initialValue?: string;
		placeholder?: string;
		validate?: (value: string) => string | undefined;
	}): Promise<unknown>;
}