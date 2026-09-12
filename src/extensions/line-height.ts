import { Extension } from "@tiptap/react";

/**
 * Line-height as a node attribute on paragraph/heading blocks.
 *
 * Block-level spacing is stored on the node (not a mark) so the CRDT
 * adapter treats it like the other delimiter attributes (align):
 * whole-block LWW register semantics, no per-character splitting.
 * "normal" is the default; the command rewrites the attribute over
 * every matching block inside the selection in a single transaction so
 * a multi-block selection is one undo step.
 */
declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    lineHeight: {
      setLineHeight: (lineHeight: string) => ReturnType;
      unsetLineHeight: () => ReturnType;
    };
  }
}

const BLOCK_TYPES = ["paragraph", "heading"] as const;

export const LineHeightExtension = Extension.create({
  name: "lineHeight",

  addOptions() {
    return {
      types: [...BLOCK_TYPES],
      defaultLineHeight: "normal",
    };
  },

  addGlobalAttributes() {
    return [
      {
        types: this.options.types,
        attributes: {
          lineHeight: {
            default: this.options.defaultLineHeight,
            parseHTML: (element) =>
              element.style.lineHeight || this.options.defaultLineHeight,
            renderHTML: (attributes) =>
              attributes.lineHeight
                ? { style: `line-height: ${attributes.lineHeight}` }
                : {},
          },
        },
      },
    ];
  },

  addCommands() {
    return {
      setLineHeight:
        (lineHeight: string) =>
        ({ tr, state, dispatch }) => {
          const { from, to } = state.selection;
          state.doc.nodesBetween(from, to, (node, pos) => {
            if (this.options.types.includes(node.type.name)) {
              tr.setNodeMarkup(pos, undefined, {
                ...node.attrs,
                lineHeight,
              });
            }
          });
          if (dispatch) dispatch(tr);
          return true;
        },

      unsetLineHeight:
        () =>
        ({ tr, state, dispatch }) => {
          const { from, to } = state.selection;
          state.doc.nodesBetween(from, to, (node, pos) => {
            if (this.options.types.includes(node.type.name)) {
              tr.setNodeMarkup(pos, undefined, {
                ...node.attrs,
                lineHeight: this.options.defaultLineHeight,
              });
            }
          });
          if (dispatch) dispatch(tr);
          return true;
        },
    };
  },
});
