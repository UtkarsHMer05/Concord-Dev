"use client";

/**
 * Concord editor toolbar.
 *
 * Every control here is an *imperative* command over the shared TipTap
 * instance published in `useEditorStore`. Concord's local-first pipeline
 * (DEC-016 collaboration seam) means each command the user fires must
 * eventually become a durable CRDT operation: marks, textStyle attributes
 * (font family/size/color), paragraph alignment, line-height and highlight
 * colors are all part of the reconciled attribute registry (DEC-025), which
 * is why these specific controls — and only these — exist.
 */

import {
  BoldIcon,
  ItalicIcon,
  UnderlineIcon,
  Undo2Icon,
  Redo2Icon,
  PrinterIcon,
  SpellCheckIcon,
  ListTodoIcon,
  RemoveFormattingIcon,
  AlignLeftIcon,
  AlignCenterIcon,
  AlignRightIcon,
  AlignJustifyIcon,
  ListIcon,
  ListOrderedIcon,
  ListCollapseIcon,
  Link2Icon,
  ImageIcon,
  HighlighterIcon,
  MinusIcon,
  PlusIcon,
  ChevronDownIcon,
  SearchIcon,
  UploadIcon,
  type LucideIcon,
} from "lucide-react";
import { useState } from "react";
import { SketchPicker, type ColorResult } from "react-color";
import { type Level } from "@tiptap/extension-heading";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Dialog,
} from "@/components/ui/dialog";
import {
  DropdownMenuItem,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenu,
} from "@/components/ui/dropdown-menu";
import { useEditorStore } from "@/store/use-editor-store";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";

/* ------------------------------------------------------------------------- */
/* Spell-check preference                                                     */
/* ------------------------------------------------------------------------- */

/** localStorage key for the persisted spell-check preference. */
const SPELLCHECK_STORAGE_KEY = "concord.editor.spellcheck";

/**
 * The browser spell checker is controlled by a DOM attribute on each
 * contenteditable host, so it cannot live in editor state. We mirror it in
 * React and persist the user's choice so reloads keep the same behavior.
 */
const useSpellCheckPreference = () => {
  const [enabled, setEnabled] = useState(() => {
    if (typeof window === "undefined") return true;
    try {
      // Absence of the key means "on by default" — only an explicit "false"
      // recorded by a previous session turns it off.
      return window.localStorage.getItem(SPELLCHECK_STORAGE_KEY) !== "false";
    } catch {
      return true;
    }
  });

  const toggle = () => {
    setEnabled((current) => {
      const next = !current;
      document.querySelectorAll("[contenteditable]").forEach((el) => {
        el.setAttribute("spellcheck", next ? "true" : "false");
      });
      try {
        window.localStorage.setItem(SPELLCHECK_STORAGE_KEY, String(next));
      } catch {
        // Private-browsing mode throws on write; keep the toggle session-only.
      }
      return next;
    });
  };

  return { enabled, toggle };
};

/* ------------------------------------------------------------------------- */
/* Shared toolbar styling                                                     */
/* ------------------------------------------------------------------------- */

/**
 * Focus ring + hover treatment shared by every toolbar control. Kept as a
 * constant so controls composed in different shapes (icon button, picker
 * trigger, menu row) still present one consistent keyboard focus target.
 */
const CONTROL_FOCUS_CLASSES =
  "hover:bg-neutral-200/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 rounded-sm";
const CONTROL_ACTIVE_CLASSES = "bg-neutral-200/80";
const MENU_ROW_CLASSES = `flex items-center gap-x-2 px-2 py-1 ${CONTROL_FOCUS_CLASSES}`;

/** Square icon-only control used for simple toggles (bold, undo, print…). */
const ToolbarIconButton = ({
  onClick,
  isActive,
  icon: Icon,
  "aria-label": accessibleName,
}: {
  onClick?: () => void;
  isActive?: boolean;
  icon: LucideIcon;
  "aria-label"?: string;
}) => (
  <button
    onClick={onClick}
    aria-label={accessibleName}
    aria-pressed={isActive ? true : undefined}
    title={accessibleName}
    className={cn(
      `text-sm h-7 min-w-7 flex items-center justify-center ${CONTROL_FOCUS_CLASSES}`,
      isActive && CONTROL_ACTIVE_CLASSES
    )}
  >
    <Icon className="size-4" />
  </button>
);

/**
 * Trigger button that opens a dropdown picker. Identical affordance to
 * `ToolbarIconButton` but takes arbitrary children so it can host a label,
 * a swatch, or a chevron alongside the icon.
 */
const PickerTrigger = ({
  label,
  className,
  children,
}: {
  label: string;
  className?: string;
  children: React.ReactNode;
}) => (
  <DropdownMenuTrigger asChild>
    <button
      aria-label={label}
      title={label}
      className={cn(
        "h-7 min-w-7 shrink-0 flex items-center justify-center px-1.5 overflow-hidden text-sm",
        CONTROL_FOCUS_CLASSES,
        className
      )}
    >
      {children}
    </button>
  </DropdownMenuTrigger>
);

/* ------------------------------------------------------------------------- */
/* Text structure: font family, headings, font size                            */
/* ------------------------------------------------------------------------- */

/**
 * Shared "option list" menu: a trigger plus a vertical list of clickable
 * options. Centralizes row styling and the selected-state highlight so all
 * picker menus (font family, lists, alignment, line-height) look identical
 * while each call site carries only its own logic.
 */
const OptionListMenu = ({
  triggerLabel,
  triggerClassName,
  triggerIcon,
  triggerText,
  options,
}: {
  triggerLabel: string;
  /** Extra trigger classes (e.g. fixed width for label triggers). */
  triggerClassName?: string;
  /** Icon-only triggers pass their icon; label triggers pass text instead. */
  triggerIcon?: LucideIcon;
  /** Optional inline text (font family label) rendered with a chevron. */
  triggerText?: string;
  options: {
    key: string;
    label: string;
    /** Optional per-row icon (list/alignment pickers). */
    icon?: LucideIcon;
    /** Optional inline style (font previews its family; headings its size). */
    style?: React.CSSProperties;
    selected: boolean;
    onSelect: () => void;
  }[];
}) => {
  const TriggerIcon = triggerIcon;
  const rows = options.map(({ key, label, icon: RowIcon, style, selected, onSelect }) => (
    <button
      key={key}
      style={style}
      onClick={onSelect}
      aria-pressed={selected ? true : undefined}
      className={cn(MENU_ROW_CLASSES, selected && CONTROL_ACTIVE_CLASSES)}
    >
      {RowIcon && <RowIcon className="size-4" />}
      <span className="text-sm">{label}</span>
    </button>
  ));

  return (
    <DropdownMenu>
      <PickerTrigger label={triggerLabel} className={triggerClassName}>
        {TriggerIcon && <TriggerIcon className="size-4" />}
        {triggerText !== undefined && (
          <>
            <span className="truncate">{triggerText}</span>
            <ChevronDownIcon className="ml-2 size-4 shrink-0" />
          </>
        )}
      </PickerTrigger>
      {/* Rows are built above so the trigger markup stays scannable. */}
      <DropdownMenuContent className="p-1 flex flex-col gap-y-1">{rows}</DropdownMenuContent>
    </DropdownMenu>
  );
};

/**
 * Font stacks offered in the picker. Only families whose marks survive the
 * CRDT attribute registry round-trip are listed here (DEC-025 subset).
 */
const FONT_CHOICES = [
  "Arial",
  "Times New Roman",
  "Courier New",
  "Georgia",
  "Verdana",
] as const;

const FontFamilyPicker = () => {
  const { editor } = useEditorStore();
  const activeFamily = editor?.getAttributes("textStyle").fontFamily;

  return (
    <OptionListMenu
      triggerLabel="Font family"
      triggerClassName="w-[120px] justify-between"
      triggerText={activeFamily || "Arial"}
      options={FONT_CHOICES.map((family) => ({
        key: family,
        label: family,
        style: { fontFamily: family },
        selected: activeFamily === family,
        onSelect: () => editor?.chain().focus().setFontFamily(family).run(),
      }))}
    />
  );
};

/** Heading ladder with the on-page size each level previews in the menu. */
const HEADING_CHOICES = [
  { label: "Normal text", level: 0, preview: "16px" },
  { label: "Heading 1", level: 1, preview: "32px" },
  { label: "Heading 2", level: 2, preview: "24px" },
  { label: "Heading 3", level: 3, preview: "20px" },
  { label: "Heading 4", level: 4, preview: "18px" },
  { label: "Heading 5", level: 5, preview: "16px" },
] as const;

const HeadingLevelPicker = () => {
  const { editor } = useEditorStore();

  // Mirror the ladder order to resolve which level the cursor sits in.
  const activeLabel =
    HEADING_CHOICES.find(
      ({ level }) => level !== 0 && editor?.isActive("heading", { level }),
    )?.label ?? "Normal text";

  return (
    <OptionListMenu
      triggerLabel="Heading level"
      triggerText={activeLabel}
      options={HEADING_CHOICES.map(({ label, level, preview }) => ({
        key: label,
        label,
        style: { fontSize: preview },
        // Level 0 means body text: current when *no* heading is active.
        selected: level === 0 ? !editor?.isActive("heading") : !!editor?.isActive("heading", { level }),
        onSelect: () =>
          level === 0
            ? editor?.chain().focus().setParagraph().run()
            : editor?.chain().focus().toggleHeading({ level: level as Level }).run(),
      }))}
    />
  );
};

/** Fallback shown when the selection carries no explicit size yet. */
const DEFAULT_FONT_SIZE_PX = "16";

/**
 * Font size stepper: −/+ buttons flanking a value that turns into a numeric
 * input on click. Applied sizes become per-span textStyle attributes, which
 * the CRDT adapter stores as fractional marks (DEC-025).
 */
/** Icon-only −/+ step button for the stepper flanks. */
const StepButton = ({
  direction,
  label,
  icon: Icon,
  onStep,
}: {
  direction: -1 | 1;
  label: string;
  icon: LucideIcon;
  onStep: (direction: -1 | 1) => void;
}) => (
  <button
    onClick={() => onStep(direction)}
    aria-label={label}
    title={label}
    className={cn("h-7 w-7 shrink-0 flex items-center justify-center", CONTROL_FOCUS_CLASSES)}
  >
    <Icon className="size-4" />
  </button>
);

const FontSizeControl = () => {
  const { editor } = useEditorStore();
  const editorSize = editor?.getAttributes("textStyle").fontSize;
  const appliedSize = editorSize ? editorSize.replace("px", "") : DEFAULT_FONT_SIZE_PX;

  const [committedSize, setCommittedSize] = useState(appliedSize);
  const [draftSize, setDraftSize] = useState(appliedSize);
  const [editing, setEditing] = useState(false);

  /**
   * Apply a size if it parses to a positive pixel count; silently ignore
   * drafts that are mid-typing or invalid so the user never loses focus.
   */
  const applySize = (raw: string) => {
    const parsed = parseInt(raw, 10);
    if (!Number.isNaN(parsed) && parsed > 0) {
      editor?.chain().focus().setFontSize(`${parsed}px`).run();
      setCommittedSize(raw);
      setDraftSize(raw);
      setEditing(false);
    }
  };

  const shiftSize = (delta: number) => {
    applySize(String(parseInt(committedSize, 10) + delta));
  };

  return (
    <div className="flex items-center gap-x-0.5">
      <StepButton
        direction={-1}
        label="Decrease font size"
        icon={MinusIcon}
        onStep={(dir) => shiftSize(dir)}
      />
      {editing ? (
        <input
          type="text"
          inputMode="numeric"
          aria-label="Font size in pixels"
          value={draftSize}
          onChange={(e) => setDraftSize(e.target.value)}
          onBlur={() => applySize(draftSize)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              applySize(draftSize);
              editor?.commands.focus();
            }
          }}
          className="h-7 w-10 text-sm text-center border border-neutral-400 rounded-sm bg-transparent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
      ) : (
        <button
          onClick={() => {
            setDraftSize(appliedSize);
            setEditing(true);
          }}
          aria-label="Font size — click to edit"
          title="Font size (px)"
          className={cn(
            "h-7 w-10 text-sm text-center border border-neutral-400",
            CONTROL_FOCUS_CLASSES
          )}
        >
          {appliedSize}
        </button>
      )}
      {/* Stepper's + button mirrors the − button above. */}
      <StepButton
        direction={1}
        label="Increase font size"
        icon={PlusIcon}
        onStep={(dir) => shiftSize(dir)}
      />
    </div>
  );
};

/* ------------------------------------------------------------------------- */
/* Color pickers (text + highlight)                                           */
/* ------------------------------------------------------------------------- */

/** Wrap `react-color`'s picker in our dropdown chrome. */
const ColorSwatchMenu = ({
  triggerLabel,
  currentColor,
  onPick,
  children,
}: {
  triggerLabel: string;
  currentColor: string;
  onPick: (hex: string) => void;
  children: React.ReactNode;
}) => (
  <DropdownMenu>
    <PickerTrigger label={triggerLabel}>{children}</PickerTrigger>
    <DropdownMenuContent className="p-0">
      <SketchPicker
        color={currentColor}
        onChange={(result: ColorResult) => onPick(result.hex)}
      />
    </DropdownMenuContent>
  </DropdownMenu>
);

/** Default highlight alpha matches TipTap's `#FFFFFFFF` sentinel. */
const HIGHLIGHT_FALLBACK = "#FFFFFFFF";
const TEXT_COLOR_FALLBACK = "#000000";

const HighlightColorPicker = () => {
  const { editor } = useEditorStore();
  const active = editor?.getAttributes("highlight").color || HIGHLIGHT_FALLBACK;

  return (
    <ColorSwatchMenu
      triggerLabel="Highlight color"
      currentColor={active}
      onPick={(hex) => editor?.chain().focus().setHighlight({ color: hex }).run()}
    >
      <HighlighterIcon className="size-4" />
    </ColorSwatchMenu>
  );
};

const TextColorPicker = () => {
  const { editor } = useEditorStore();
  const active = editor?.getAttributes("textStyle").color || TEXT_COLOR_FALLBACK;

  return (
    <ColorSwatchMenu
      triggerLabel="Text color"
      currentColor={active}
      onPick={(hex) => editor?.chain().focus().setColor(hex).run()}
    >
      <span className="text-xs">A</span>
      {/* Underline swatch previews the active color on the trigger itself. */}
      <div className="h-0.5 w-full" style={{ backgroundColor: active }} />
    </ColorSwatchMenu>
  );
};

/* ------------------------------------------------------------------------- */
/* Link + image insertion                                                     */
/* ------------------------------------------------------------------------- */

/**
 * Link editor inside a dropdown. Opening the menu re-seeds the input from
 * the link mark under the cursor so editing an existing link round-trips.
 */
const LinkEditor = () => {
  const { editor } = useEditorStore();
  const [href, setHref] = useState("");

  const applyLink = (target: string) => {
    editor?.chain().focus().extendMarkRange("link").setLink({ href: target }).run();
    setHref("");
  };

  return (
    <DropdownMenu
      onOpenChange={(open) => {
        if (open) setHref(editor?.getAttributes("link").href || "");
      }}
    >
      <PickerTrigger label="Insert link">
        <Link2Icon className="size-4" />
      </PickerTrigger>
      <DropdownMenuContent className="p-2.5 flex items-center gap-x-2">
        <label htmlFor="link-url-input" className="sr-only">
          Link URL
        </label>
        <Input
          id="link-url-input"
          type="url"
          placeholder="https://example.com"
          value={href}
          onChange={(e) => setHref(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") applyLink(href);
          }}
        />
        <Button onClick={() => applyLink(href)}>Apply</Button>
      </DropdownMenuContent>
    </DropdownMenu>
  );
};

/**
 * Image insertion with two entry points: a local file (kept as an object URL
 * — images are not yet part of the CRDT mirror) or any remote URL pasted
 * into a small dialog.
 */
const ImageInserter = () => {
  const { editor } = useEditorStore();
  const [urlDialogOpen, setUrlDialogOpen] = useState(false);
  const [pendingUrl, setPendingUrl] = useState("");

  const insertImage = (src: string) => {
    editor?.chain().focus().setImage({ src }).run();
  };

  /** Open the browser picker and convert the chosen file to an object URL. */
  const uploadLocalFile = () => {
    const filePicker = document.createElement("input");
    filePicker.type = "file";
    filePicker.accept = "image/*";
    filePicker.onchange = (e) => {
      const selected = (e.target as HTMLInputElement).files?.[0];
      if (selected) insertImage(URL.createObjectURL(selected));
    };
    filePicker.click();
  };

  const submitUrl = () => {
    if (!pendingUrl) return;
    insertImage(pendingUrl);
    setPendingUrl("");
    setUrlDialogOpen(false);
  };

  // Split render into the two entry points so each stays independently
  // readable: the dropdown menu and the URL-paste dialog.
  const sourceMenu = (
    <DropdownMenu>
      <PickerTrigger label="Insert image">
        <ImageIcon className="size-4" />
      </PickerTrigger>
      <DropdownMenuContent>
        {/* Two insertion paths: local file upload or remote URL paste. */}
        <DropdownMenuItem onClick={uploadLocalFile}>
          <UploadIcon className="size-4 mr-2" />
          Upload
        </DropdownMenuItem>
        <DropdownMenuItem
          key="by-url"
          onClick={() => {
            setUrlDialogOpen(true);
          }}
        >
          <SearchIcon className="size-4 mr-2" />
          Paste image url
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );

  const urlDialog = (
    <Dialog open={urlDialogOpen} onOpenChange={setUrlDialogOpen}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Insert image URL</DialogTitle>
        </DialogHeader>
        <label htmlFor="image-url-input" className="sr-only">
          Image URL
        </label>
        <Input
          id="image-url-input"
          type="url"
          placeholder="https://example.com/image.png"
          value={pendingUrl}
          onChange={(e) => setPendingUrl(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") submitUrl();
          }}
        />
        <DialogFooter>
          <Button onClick={submitUrl}>Insert</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );

  return (
    <>
      {sourceMenu}
      {urlDialog}
    </>
  );
};

/* --- list & alignment menus ---------------------------------------------- */

const ListPicker = () => {
  const { editor } = useEditorStore();

  return (
    <OptionListMenu
      triggerLabel="Lists"
      triggerIcon={ListIcon}
      options={[
        {
          key: "bullet",
          label: "Bullet List",
          icon: ListIcon,
          selected: !!editor?.isActive("bulletList"),
          onSelect: () => editor?.chain().focus().toggleBulletList().run(),
        },
        {
          key: "ordered",
          label: "Ordered List",
          icon: ListOrderedIcon,
          selected: !!editor?.isActive("orderedList"),
          onSelect: () => editor?.chain().focus().toggleOrderedList().run(),
        },
      ]}
    />
  );
};

const AlignmentPicker = () => {
  const { editor } = useEditorStore();

  /** value is the TextAlign command argument; name is the visible label. */
  const directions = [
    { name: "Align Left", value: "left", icon: AlignLeftIcon },
    { name: "Align Center", value: "center", icon: AlignCenterIcon },
    { name: "Align Right", value: "right", icon: AlignRightIcon },
    { name: "Align Justify", value: "justify", icon: AlignJustifyIcon },
  ];

  return (
    <OptionListMenu
      triggerLabel="Text alignment"
      triggerIcon={AlignLeftIcon}
      options={directions.map(({ name, value, icon }) => ({
        key: value,
        label: name,
        icon,
        selected: !!editor?.isActive({ textAlign: value }),
        onSelect: () => editor?.chain().focus().setTextAlign(value).run(),
      }))}
    />
  );
};

/** Line-height presets; stored per-paragraph by the CRDT adapter. */
const LINE_HEIGHT_PRESETS = [
  { label: "Default", value: "normal" },
  { label: "Single", value: "1" },
  { label: "1.15", value: "1.15" },
  { label: "1.5", value: "1.5" },
  { label: "Double", value: "2" },
] as const;

const LineHeightPicker = () => {
  const { editor } = useEditorStore();
  const active = editor?.getAttributes("paragraph").lineHeight;

  return (
    <OptionListMenu
      triggerLabel="Line height"
      triggerIcon={ListCollapseIcon}
      options={LINE_HEIGHT_PRESETS.map(({ label, value }) => ({
        key: value,
        label,
        selected: active === value,
        onSelect: () => editor?.chain().focus().setLineHeight(value).run(),
      }))}
    />
  );
};

/* ------------------------------------------------------------------------- */
/* Toolbar assembly                                                           */
/* ------------------------------------------------------------------------- */

/** Thin vertical rule separating toolbar groups at a glance. */
const GroupDivider = () => (
  <Separator orientation="vertical" className="h-6 bg-neutral-300" />
);

export const Toolbar = () => {
  const { editor } = useEditorStore();
  const spellCheck = useSpellCheckPreference();

  /** History/print/spell group — everything that acts on the document as a whole. */
  const documentActions = [
    {
      label: "Undo",
      icon: Undo2Icon,
      run: () => editor?.chain().focus().undo().run(),
    },
    {
      label: "Redo",
      icon: Redo2Icon,
      run: () => editor?.chain().focus().redo().run(),
    },
    {
      label: "Print",
      icon: PrinterIcon,
      run: () => window.print(),
    },
    {
      label: spellCheck.enabled ? "Disable spell check" : "Enable spell check",
      icon: SpellCheckIcon,
      engaged: spellCheck.enabled,
      run: spellCheck.toggle,
    },
  ];

  /** Inline-mark group (TipTap marks → CRDT mark items). */
  const markActions = [
    {
      label: "Bold",
      icon: BoldIcon,
      engaged: editor?.isActive("bold"),
      run: () => editor?.chain().focus().toggleBold().run(),
    },
    {
      label: "Italic",
      icon: ItalicIcon,
      engaged: editor?.isActive("italic"),
      run: () => editor?.chain().focus().toggleItalic().run(),
    },
    {
      label: "Underline",
      icon: UnderlineIcon,
      engaged: editor?.isActive("underline"),
      run: () => editor?.chain().focus().toggleUnderline().run(),
    },
  ];

  /** Structural extras that complete the format group. */
  const extraActions = [
    {
      label: "List Todo",
      icon: ListTodoIcon,
      engaged: editor?.isActive("taskList"),
      run: () => editor?.chain().focus().toggleTaskList().run(),
    },
    {
      label: "Remove Formatting",
      icon: RemoveFormattingIcon,
      run: () => editor?.chain().focus().unsetAllMarks().run(),
    },
  ];

  return (
    <div className="bg-[#F1F4F9] px-2.5 py-0.5 rounded-[24px] min-h-[40px] flex items-center gap-x-0.5 overflow-x-auto">
      {documentActions.map(({ label, icon, engaged, run }) => (
        <ToolbarIconButton
          key={label}
          aria-label={label}
          icon={icon}
          isActive={engaged}
          onClick={run}
        />
      ))}
      <GroupDivider />
      <FontFamilyPicker />
      <GroupDivider />
      <HeadingLevelPicker />
      <GroupDivider />
      <FontSizeControl />
      <GroupDivider />
      {markActions.map(({ label, icon, engaged, run }) => (
        <ToolbarIconButton
          key={label}
          aria-label={label}
          icon={icon}
          isActive={engaged}
          onClick={run}
        />
      ))}
      <TextColorPicker />
      <HighlightColorPicker />
      <GroupDivider />
      <LinkEditor />
      <ImageInserter />
      <AlignmentPicker />
      <LineHeightPicker />
      <ListPicker />
      {extraActions.map(({ label, icon, engaged, run }) => (
        <ToolbarIconButton
          key={label}
          aria-label={label}
          icon={icon}
          isActive={engaged}
          onClick={run}
        />
      ))}
    </div>
  );
};
