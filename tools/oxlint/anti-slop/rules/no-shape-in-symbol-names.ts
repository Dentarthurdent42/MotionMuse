import { defineRule } from "@oxlint/plugins";
import type { ESTree } from "@oxlint/plugins";

const FORBIDDEN_SYMBOL_NAME = "shape";

function containsForbiddenSymbolName(
  name: string,
  allowedTerms: readonly string[],
): boolean {
  // Mask each allowed compound term so only occurrences of "shape" outside
  // those terms are judged; "handshapeCount" with allowedTerms ["handshape"]
  // passes while "shapeCount" still fails.
  let haystack = name.toLowerCase();
  for (const term of allowedTerms) {
    haystack = haystack.replaceAll(term.toLowerCase(), " ");
  }
  return haystack.includes(FORBIDDEN_SYMBOL_NAME);
}

function readAllowedTerms(option: unknown): readonly string[] {
  if (typeof option !== "object" || option === null || Array.isArray(option)) {
    return [];
  }
  const terms = (option as { allowedTerms?: unknown }).allowedTerms;
  if (!Array.isArray(terms)) return [];
  return terms.filter((term): term is string => typeof term === "string");
}

/**
 * Ban the case-insensitive substring "shape" in every JavaScript and TypeScript
 * symbol name, except inside compound domain terms listed in `allowedTerms`
 * (vendored extension: e.g. an ASL app's "handshape", MediaPipe's "blendshape").
 */
export const noForbiddenTermInSymbolNamesRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        'Disallow the case-insensitive substring "shape" in JavaScript, TypeScript, private, and JSX symbol names.',
    },
    messages: {
      forbiddenSymbolName:
        'Rename symbol "{{name}}" for its domain role; "shape" describes structure rather than ownership.',
    },
    schema: [
      {
        type: "object",
        properties: {
          allowedTerms: { type: "array", items: { type: "string" } },
        },
        additionalProperties: false,
      },
    ],
    defaultOptions: [{ allowedTerms: [] }],
  },
  createOnce(context) {
    const reportForbiddenSymbolName = (node: ESTree.Node & { name: string }) => {
      const allowedTerms = readAllowedTerms(context.options?.[0]);
      if (!containsForbiddenSymbolName(node.name, allowedTerms)) return;
      context.report({
        node,
        messageId: "forbiddenSymbolName",
        data: { name: node.name },
      });
    };

    return {
      Identifier: reportForbiddenSymbolName,
      PrivateIdentifier: reportForbiddenSymbolName,
      JSXIdentifier: reportForbiddenSymbolName,
    };
  },
});
