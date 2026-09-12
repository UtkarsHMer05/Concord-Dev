/**
 * Concord page ruler.
 *
 * Drag either caret to change the document's text column: the left and
 * right margins live in the document session (`useDocumentSession`), which
 * persists them to localStorage and applies them as padding on the TipTap
 * page element. They are page-layout settings, *not* document content —
 * so they intentionally stay out of the CRDT replica (DEC-016 seam) and
 * are rehydrated locally by the collaboration provider on each open.
 */

import { useRef, useState } from "react";
import { FaCaretDown } from "react-icons/fa";

import { useDocumentSession } from "@/lib/collaboration/provider";
import { RIGHT_MARGIN_DEFAULT, LEFT_MARGIN_DEFAULT } from "@/constants/margins";

/** Fixed page geometry: 816px mirrors a US-Letter sheet at 96dpi. */
const PAGE_WIDTH_PX = 816;

/** Text column must keep at least this much room between the two carets. */
const MIN_TEXT_COLUMN_PX = 100;

/**
 * Tick positions: 82 evenly spaced slots (plus origin) covering the page.
 * Every 10th slot renders a full tick + number, every 5th a mid tick, the
 * rest small ticks — the classic typographic ruler ladder.
 */
const TICK_SLOTS = Array.from({ length: 83 }, (_, index) => index);

/**
 * Clamp helper shared by drag and keyboard paths so both respect the
 * "margin cannot swallow the text column" invariant.
 */
const clamp = (value: number, floor: number, ceiling: number) =>
  Math.max(floor, Math.min(value, ceiling));

/**
 * Compute the highest the *left* margin may go given the current right
 * margin (drag + keyboard share this; the mirror-image rule applies to the
 * right side).
 */
const leftMarginCeiling = (rightMargin: number) =>
  PAGE_WIDTH_PX - rightMargin - MIN_TEXT_COLUMN_PX;

const rightMarginCeiling = (leftMargin: number) =>
  PAGE_WIDTH_PX - (leftMargin + MIN_TEXT_COLUMN_PX);

export const Ruler = () => {
  const { settings } = useDocumentSession();
  const { leftMargin, setLeftMargin, rightMargin, setRightMargin } = settings;

  // Only one caret is ever mid-drag; tracked as which side, not two flags.
  const [draggingSide, setDraggingSide] = useState<"left" | "right" | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  /** Shared pointer-move math: rawX is the cursor's x within the page. */
  const pointerXWithinPage = (clientX: number) => {
    const track = rootRef.current?.querySelector("#ruler-container");
    if (!track) return null;
    const trackBox = track.getBoundingClientRect();
    return clamp(clientX - trackBox.left, 0, PAGE_WIDTH_PX);
  };

  const startDrag = (side: "left" | "right") => () => setDraggingSide(side);

  const endDrag = () => setDraggingSide(null);

  const handleDrag = (event: React.MouseEvent) => {
    if (!draggingSide) return;
    const x = pointerXWithinPage(event.clientX);
    if (x === null) return;

    if (draggingSide === "left") {
      setLeftMargin(clamp(x, 0, leftMarginCeiling(rightMargin)));
    } else {
      // The right margin is stored as "distance from the page's right edge",
      // so invert the pointer coordinate before clamping to its ceiling.
      const distanceFromRightEdge = Math.max(PAGE_WIDTH_PX - x, 0);
      setRightMargin(
        clamp(distanceFromRightEdge, 0, rightMarginCeiling(leftMargin))
      );
    }
  };

  /** Nudge by keyboard. Left arrow always moves the caret toward the page edge. */
  const nudgeLeftMargin = (deltaPx: number) => {
    setLeftMargin(clamp(leftMargin + deltaPx, 0, leftMarginCeiling(rightMargin)));
  };

  const nudgeRightMargin = (deltaPx: number) => {
    // Right arrow (positive delta) shrinks the stored distance-from-edge.
    setRightMargin(clamp(rightMargin - deltaPx, 0, rightMarginCeiling(leftMargin)));
  };

  return (
    <div
      ref={rootRef}
      onMouseMove={handleDrag}
      onMouseUp={endDrag}
      onMouseLeave={endDrag}
      className="w-[816px] min-w-max mx-auto h-6 border-b border-gray-300 flex items-end relative select-none print:hidden"
    >
      <div id="ruler-container" className="w-full h-full relative">
        <MarginCaret
          side="left"
          offsetPx={leftMargin}
          dragging={draggingSide === "left"}
          beginDrag={startDrag("left")}
          resetDefault={() => setLeftMargin(LEFT_MARGIN_DEFAULT)}
          nudge={nudgeLeftMargin}
        />
        <MarginCaret
          side="right"
          offsetPx={rightMargin}
          dragging={draggingSide === "right"}
          beginDrag={startDrag("right")}
          resetDefault={() => setRightMargin(RIGHT_MARGIN_DEFAULT)}
          nudge={nudgeRightMargin}
        />
        {/* Tick ladder: marker height/labels depend on each slot's rank. */}
        <TickLadder />
      </div>
    </div>
  );
};

/**
 * The printed ruler itself: 82 evenly spaced slots across the page width,
 * numbered every 10th. Purely visual — it never participates in the drag
 * math, which measures the `#ruler-container` box directly.
 */
const TickLadder = () => (
  <div className="absolute inset-x-0 bottom-0 h-full">
    <div className="relative h-full w-[816px]">
      {TICK_SLOTS.map((slot) => {
        const slotPx = (slot * PAGE_WIDTH_PX) / 82;

        return (
          <div
            key={slot}
            className="absolute bottom-0"
            style={{ left: `${slotPx}px` }}
          >
            {slot % 10 === 0 ? (
              <>
                <div className="absolute bottom-0 w-[1px] h-2 bg-neutral-500" />
                <span className="absolute bottom-2 text-[10px] text-neutral-500 transform -translate-x-1/2">
                  {slot / 10 + 1}
                </span>
              </>
            ) : slot % 5 === 0 ? (
              <div className="absolute bottom-0 w-[1px] h-1.5 bg-neutral-500" />
            ) : (
              <div className="absolute bottom-0 w-[1px] h-1 bg-neutral-500" />
            )}
          </div>
        );
      })}
    </div>
  </div>
);

/**
 * A draggable margin caret. Rendered as an ARIA slider so the margins are
 * keyboard-reachable: arrows nudge (Shift = 10px steps), Home/End jump to
 * the page extremes, double-click restores the default margin.
 */
const MarginCaret = ({
  side,
  offsetPx,
  dragging,
  beginDrag,
  resetDefault,
  nudge,
}: {
  side: "left" | "right";
  offsetPx: number;
  dragging: boolean;
  beginDrag: () => void;
  resetDefault: () => void;
  /** Keyboard nudge: positive pixels move toward the page's inner edge. */
  nudge: (deltaPx: number) => void;
}) => {
  const accessibleName = `${side === "left" ? "Left" : "Right"} page margin — drag or use arrow keys to adjust, double-click to reset`;

  return (
    <div
      className="absolute top-0 w-4 h-full cursor-ew-resize z-[5] group -ml-2"
      style={{ [side === "left" ? "left" : "right"]: `${offsetPx}px` }}
      onMouseDown={beginDrag}
      onDoubleClick={resetDefault}
      role="slider"
      tabIndex={0}
      aria-label={accessibleName}
      aria-orientation="horizontal"
      aria-valuemin={0}
      aria-valuemax={PAGE_WIDTH_PX}
      aria-valuenow={Math.round(offsetPx)}
      onKeyDown={(event) => {
        const stepPx = event.shiftKey ? 10 : 1;
        if (event.key === "ArrowLeft") {
          event.preventDefault();
          nudge(-stepPx);
        } else if (event.key === "ArrowRight") {
          event.preventDefault();
          nudge(stepPx);
        } else if (event.key === "Home") {
          event.preventDefault();
          nudge(-offsetPx);
        } else if (event.key === "End") {
          event.preventDefault();
          nudge(PAGE_WIDTH_PX - offsetPx);
        }
      }}
    >
      <FaCaretDown className="absolute left-1/2 top-0 h-full fill-blue-500 transform -translate-x-1/2" aria-hidden="true" />
      {/* Drag guide: hairline column previewing where the text edge lands. */}
      <DragGuide visible={dragging} />
    </div>
  );
};

/**
 * Full-viewport hairline shown while dragging. Rendered (rather than
 * toggled by class) so it costs nothing when idle.
 */
const DragGuide = ({ visible }: { visible: boolean }) =>
  visible ? (
    <div
      className="absolute left-1/2 top-4 transform -translate-x-1/2"
      style={{ height: "100vh", width: "1px", backgroundColor: "#3b72f6", transform: "scaleX(0.5)" }}
    />
  ) : null;
