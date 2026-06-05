/**
 * Minimal, dependency-free ANSI styling helper.
 *
 * Provides a `chalk`-compatible subset (the styles the mqlti-config CLI uses)
 * without pulling in the ESM-only `chalk` package. Each style is a chainable
 * callable: `style.red("x")` and `style.red.bold("x")` both work.
 *
 * Colour output is disabled when `NO_COLOR` is set, when `FORCE_COLOR=0`, or
 * when stdout is not a TTY — matching common CLI conventions.
 */

type StyleName =
  | "bold"
  | "dim"
  | "red"
  | "green"
  | "yellow"
  | "blue"
  | "cyan"
  | "white";

/** ASCII escape (0x1b); built from charCode to avoid literal-encoding issues. */
const ESC = String.fromCharCode(27);

const CODES: Readonly<Record<StyleName, readonly [number, number]>> = {
  bold: [1, 22],
  dim: [2, 22],
  red: [31, 39],
  green: [32, 39],
  yellow: [33, 39],
  blue: [34, 39],
  cyan: [36, 39],
  white: [37, 39],
} as const;

const STYLE_NAMES = Object.keys(CODES) as readonly StyleName[];

/** A callable styler that is also chainable across every supported style. */
export type Styler = ((text: string) => string) & {
  readonly [K in StyleName]: Styler;
};

function colorEnabled(): boolean {
  if (process.env.NO_COLOR !== undefined) return false;
  if (process.env.FORCE_COLOR === "0") return false;
  if (process.env.FORCE_COLOR !== undefined) return true;
  return Boolean(process.stdout.isTTY);
}

function code(value: number): string {
  return `${ESC}[${value}m`;
}

function wrap(text: string, applied: readonly StyleName[]): string {
  if (!colorEnabled() || applied.length === 0) return text;
  const open = applied.map((name) => code(CODES[name][0])).join("");
  const close = applied
    .map((name) => code(CODES[name][1]))
    .reverse()
    .join("");
  return `${open}${text}${close}`;
}

function makeStyler(applied: readonly StyleName[]): Styler {
  const fn = ((text: string): string => wrap(text, applied)) as Styler;
  for (const name of STYLE_NAMES) {
    Object.defineProperty(fn, name, {
      get: () => makeStyler([...applied, name]),
      enumerable: true,
    });
  }
  return fn;
}

/** Chalk-compatible default styler (subset of methods). */
const style: Styler = makeStyler([]);

export default style;
