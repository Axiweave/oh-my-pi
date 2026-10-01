import { type Document, isMap, isNode, isScalar, type Node, parse, parseDocument, stringify, type YAMLMap } from "yaml";
import { isRecord } from "./type-guards";

/**
 * Parse options matching Bun's YAML parser on config files: a repeated key keeps
 * the last value instead of failing the whole file, and `<<` merge keys apply.
 */
const PARSE_OPTIONS = { merge: true, uniqueKeys: false } as const;
/** Never fold long scalars (model selectors, URLs, prompts) across lines. */
const STRINGIFY_OPTIONS = { lineWidth: 0 } as const;

/** Parse a YAML config file. Throws on invalid YAML. */
export function parseYamlConfig(source: string): unknown {
	return parse(source, PARSE_OPTIONS);
}

/**
 * Serialize config YAML. With `source` (the file's current text), only the nodes
 * whose values changed are rewritten, so comments, blank lines, key order, and
 * scalar styles of the rest survive. The library still re-prints the document,
 * so spacing before inline comments may normalize; a write with no value change
 * returns `source` byte for byte. A replaced node keeps its own comments, but a
 * replaced subtree loses the comments inside it. Falls back to a fresh dump when
 * `source` is not a parseable mapping.
 */
export function stringifyYamlConfig(value: unknown, source?: string): string {
	if (source !== undefined && isRecord(value)) {
		const doc: Document = parseDocument(source, PARSE_OPTIONS);
		if (doc.errors.length === 0 && Bun.deepEquals(doc.toJS(), value)) return source;
		if (doc.errors.length === 0) {
			if (isMap(doc.contents)) {
				mergeMap(doc, doc.contents, value);
				return doc.toString(STRINGIFY_OPTIONS);
			}
			if (doc.contents === null || (isScalar(doc.contents) && doc.contents.value === null)) {
				// Empty or comment-only file: keep its comments above the new content.
				doc.contents = doc.createNode(value);
				return doc.toString(STRINGIFY_OPTIONS);
			}
		}
	}
	return stringify(value, STRINGIFY_OPTIONS);
}

function mergeMap(doc: Document, map: YAMLMap, value: Record<string, unknown>): void {
	const keyOf = (key: unknown): string => String(isScalar(key) ? key.value : key);
	// Parsing keeps the last of repeated keys, so only that pair is live; drop the earlier ones.
	const lastIndex = new Map<string, number>();
	map.items.forEach((pair, index) => lastIndex.set(keyOf(pair.key), index));
	// A deleted key's leading comment (often the file's header) moves to the next kept key.
	let orphanComment: string | undefined;
	map.items = map.items.filter((pair, index) => {
		const key = keyOf(pair.key);
		const keep = lastIndex.get(key) === index && Object.hasOwn(value, key) && value[key] !== undefined;
		const keyNode = isNode(pair.key) ? pair.key : undefined;
		if (!keep) {
			if (keyNode?.commentBefore) {
				orphanComment = orphanComment ? `${orphanComment}\n${keyNode.commentBefore}` : keyNode.commentBefore;
			}
		} else if (orphanComment && keyNode) {
			keyNode.commentBefore = keyNode.commentBefore ? `${orphanComment}\n${keyNode.commentBefore}` : orphanComment;
			orphanComment = undefined;
		}
		return keep;
	});
	// No later key took it: keep it at the end of the map.
	if (orphanComment) map.comment = map.comment ? `${map.comment}\n${orphanComment}` : orphanComment;
	for (const [key, next] of Object.entries(value)) {
		if (next === undefined) continue;
		const pair = map.items.find(item => keyOf(item.key) === key);
		if (!pair) {
			map.items.push(doc.createPair(key, next));
			continue;
		}
		const current = pair.value;
		if (isMap(current) && isRecord(next)) {
			mergeMap(doc, current, next);
			continue;
		}
		const currentJs = isNode(current) ? current.toJS(doc) : current;
		if (Bun.deepEquals(currentJs, next)) continue;
		const replacement = doc.createNode(next) as Node;
		if (isNode(current)) {
			// An inline comment stays inline only on a scalar; a block value would print it below.
			if (isScalar(replacement)) replacement.comment = current.comment;
			replacement.commentBefore = current.commentBefore;
			replacement.spaceBefore = current.spaceBefore;
		}
		pair.value = replacement;
	}
}
