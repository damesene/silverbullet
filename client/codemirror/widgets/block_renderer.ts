import { syntaxTree } from "@codemirror/language";
import type { EditorState, Range } from "@codemirror/state";
import { Decoration, type EditorView, WidgetType } from "@codemirror/view";
import type { Client } from "../../client.ts";
import {
  decoratorStateField,
  hideBlockSource,
  isCursorInRange,
} from "../util.ts";

/** What a renderer is told of the block it draws */
export type BlockRenderContext = {
  // The page shown
  readonly pageName: string;
  // Where the block's source starts in the page, as of this call
  readonly from: number;
};

/**
 * A space's own renderer of one of the markdown's block nodes (a `Table`),
 * registered with `syntax.renderBlock`. It draws the block where its source is
 * not being edited; the source stays the page's text, which the renderer may
 * change through the editor's syscalls.
 */
export type BlockRenderer = {
  // The block's element for its source: an element, or a promise of one
  render: (
    source: string,
    ctx: BlockRenderContext,
  ) => HTMLElement | Promise<HTMLElement>;
  // The element drawn before brought up to the source changed; false (or
  // nothing): drawn anew by render. May finish later (a promise): the element
  // stays meanwhile.
  update?: (
    element: HTMLElement,
    source: string,
    ctx: BlockRenderContext,
  ) => boolean | undefined | Promise<boolean | undefined>;
  // The element is gone from the page
  destroy?: (element: HTMLElement) => void;
};

/** The renderer registered for a node, if any */
export function blockRendererFor(
  client: Client,
  nodeName: string,
): BlockRenderer | undefined {
  const renderer = client.config.get<BlockRenderer | undefined>(
    ["blockRenderers", nodeName],
    undefined,
  );
  return renderer && typeof renderer.render === "function"
    ? renderer
    : undefined;
}

class BlockRendererWidget extends WidgetType {
  constructor(
    readonly client: Client,
    readonly nodeName: string,
    readonly renderer: BlockRenderer,
    readonly source: string,
    readonly from: number,
  ) {
    super();
  }

  private get ctx(): BlockRenderContext {
    return { pageName: this.client.currentName(), from: this.from };
  }

  private cacheKey(source = this.source): string {
    return `block:${this.nodeName}:${source}`;
  }

  override get estimatedHeight(): number {
    return this.client.widgetCache.getCachedWidgetHeight(this.cacheKey());
  }

  toDOM(): HTMLElement {
    const host = document.createElement("div");
    host.className = "sb-block-renderer";
    host.dataset.node = this.nodeName;
    const height = this.estimatedHeight;
    if (height > 0) host.style.minHeight = `${height}px`;
    this.fill(host);
    return host;
  }

  private fill(host: HTMLElement): void {
    void Promise.resolve()
      .then(() => this.renderer.render(this.source, this.ctx))
      .then((element) => {
        if (!element) return;
        host.replaceChildren(element);
        host.style.minHeight = "";
        this.remember(host);
      })
      .catch((e) => {
        console.error(`Block renderer of ${this.nodeName} failed`, e);
        host.textContent = `Error rendering ${this.nodeName}: ${e?.message ?? e}`;
      });
  }

  private remember(host: HTMLElement): void {
    setTimeout(() => {
      if (!host.isConnected) return;
      this.client.widgetCache.setCachedWidgetMeta(this.cacheKey(), {
        height: host.clientHeight,
        block: true,
      });
    });
  }

  override eq(other: WidgetType): boolean {
    return (
      other instanceof BlockRendererWidget &&
      other.nodeName === this.nodeName &&
      other.renderer === this.renderer &&
      other.source === this.source
    );
  }

  // The source changed: the renderer brings its element up to it, where it can
  override updateDOM(host: HTMLElement, _view: EditorView, from?: WidgetType) {
    if (
      !(from instanceof BlockRendererWidget) ||
      from.nodeName !== this.nodeName ||
      from.renderer !== this.renderer ||
      !this.renderer.update
    ) {
      return false;
    }
    const element = host.firstElementChild as HTMLElement | null;
    if (!element) return false;
    let result: ReturnType<NonNullable<BlockRenderer["update"]>>;
    try {
      result = this.renderer.update(element, this.source, this.ctx);
    } catch (e) {
      console.error(`Block renderer of ${this.nodeName} failed`, e);
      return false;
    }
    if (result instanceof Promise) {
      // Kept meanwhile; drawn anew where the renderer could not bring it up to date
      void result.then(
        (updated) => {
          if (updated) this.remember(host);
          else this.fill(host);
        },
        () => this.fill(host),
      );
      return true;
    }
    if (!result) return false;
    this.remember(host);
    return true;
  }

  override destroy(host: HTMLElement): void {
    const element = host.firstElementChild as HTMLElement | null;
    if (element) this.renderer.destroy?.(element);
  }

  // Events in the block are the renderer's: CodeMirror neither moves the cursor nor selects on them
  override ignoreEvent(): boolean {
    return true;
  }
}

/** Blocks drawn by the space's renderers (`syntax.renderBlock`) where the cursor is not in them */
export function blockRendererPlugin(client: Client) {
  return decoratorStateField((state: EditorState) => {
    const renderers: Record<string, BlockRenderer> = client.config.get(
      "blockRenderers",
      {},
    );
    if (Object.keys(renderers).length === 0) return Decoration.none;
    const widgets: Range<Decoration>[] = [];
    syntaxTree(state).iterate({
      enter: (node) => {
        const renderer = blockRendererFor(client, node.name);
        if (!renderer) return;
        const { from, to } = node;
        if (isCursorInRange(state, [from, to])) return false;
        hideBlockSource(widgets, state, from, to, "start");
        widgets.push(
          Decoration.widget({
            widget: new BlockRendererWidget(
              client,
              node.name,
              renderer,
              state.sliceDoc(from, to),
              from,
            ),
            block: true,
          }).range(from),
        );
        return false;
      },
    });
    return Decoration.set(widgets, true);
  });
}
