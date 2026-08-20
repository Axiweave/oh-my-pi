// @ts-nocheck — example file; install @oh-my-pi/pi-coding-agent before running
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { renderTopRule, type ComposerStyle } from "@oh-my-pi/pi-tui";

export default function claude3Footer(pi: ExtensionAPI) {
  // Replace the built-in `claude` shape's chip + bottom-rule layout with a
  // detached 3-line footer: model/context, git branch + cwd, then hints.
  pi.registerComposerShape({
    label: "Claude Code (3-line footer)",
    description: "Top rule with a 3-line model/context + git/cwd + hints footer",
    style: {
      id: "claude-footer",
      sideBorders: false,
      verticalChrome: 1,
      statusAttachment: "none",
      bottomBar: "full",
      footerMode: "claude3",
      bottomBarGap: false,
      defaultPromptGutter: "❯ ",
      defaultPaddingX: () => 0,
      sideChromeWidth: p => p,
      renderTop: ctx => renderTopRule(ctx),
      renderRow: ({ gutter, text, pad }) => [gutter + text + pad],
      renderBottom: () => undefined,
    } satisfies ComposerStyle,
  });
}
