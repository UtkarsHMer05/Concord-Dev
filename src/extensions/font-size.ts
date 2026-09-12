import { Extension } from "@tiptap/react";
import "@tiptap/extension-text-style";

/**
 * Font-size as a textStyle-mark attribute.
 *
 * Concord's CRDT-backed attribute set is a fixed registry (DEC-027);
 * font-size rides the existing textStyle mark rather than a new mark
 * type, which keeps the serialized delta shape identical to the single
 * style-mark format the adapter diffs. Values are raw CSS lengths
 * (`"14px"`); validation happens in the toolbar before the command.
 */
declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    fontSize: {
      setFontSize: (size: string) => ReturnType;
      unsetFontSize: () => ReturnType;
    };
  }
}

export const FontSizeExtension = Extension.create({
  name: "fontSize",

  addOptions() {
    return {
      types: ["textStyle"],
    };
  },

  addGlobalAttributes() {
    return [
      {
        types: this.options.types,
        attributes: {
          fontSize: {
            default: null,
            parseHTML: (element) => element.style.fontSize,
            renderHTML: (attributes) =>
              attributes.fontSize
                ? { style: `font-size: ${attributes.fontSize}` }
                : {},
          },
        },
      },
    ];
  },

  addCommands() {
    return {
      setFontSize:
        (fontSize: string) =>
        ({ chain }) =>
          chain().setMark("textStyle", { fontSize }).run(),

      unsetFontSize:
        () =>
        ({ chain }) =>
          chain()
            .setMark("textStyle", { fontSize: null })
            .removeEmptyTextStyle()
            .run(),
    };
  },
});
