import { useRef, useState } from "react";
import { FaCaretDown } from "react-icons/fa";

import { useDocumentSession } from "@/lib/collaboration/provider";
import { RIGHT_MARGIN_DEFAULT, LEFT_MARGIN_DEFAULT } from "@/constants/margins";

const markers = Array.from({ length: 83 }, (_, i) => i);

export const Ruler = () => {
  const { settings } = useDocumentSession();
  const leftMargin = settings.leftMargin;
  const setLeftMargin = settings.setLeftMargin;

  const rightMargin = settings.rightMargin;
  const setRightMargin = settings.setRightMargin;

  const [isDraggingLeft, setIsDraggingLeft] = useState(false);
  const [isDraggingRight, setIsDraggingRight] = useState(false);
  const rulerRef = useRef<HTMLDivElement>(null);

  const handleLeftMouseDown = () => {
    setIsDraggingLeft(true);
  };

  const handleRightMouseDown = () => {
    setIsDraggingRight(true);
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    const PAGE_WIDTH = 816;
    const MINIMUM_SPACE = 100;

    if ((isDraggingLeft || isDraggingRight) && rulerRef.current) {
      const container = rulerRef.current.querySelector("#ruler-container");
      if (container) {
        const containerRect = container.getBoundingClientRect();
        const relativeX = e.clientX - containerRect.left;
        const rawPosition = Math.max(0, Math.min(PAGE_WIDTH, relativeX));

        if (isDraggingLeft) {
          const maxLeftPosition = PAGE_WIDTH - rightMargin - MINIMUM_SPACE;
          const newLeftPosition = Math.min(rawPosition, maxLeftPosition);
          setLeftMargin(newLeftPosition);
        } else if (isDraggingRight) {
          const maxRightPosition = PAGE_WIDTH - (leftMargin + MINIMUM_SPACE);
          const newRightPosition = Math.max(PAGE_WIDTH - rawPosition, 0);
          const constrainedRightPosition = Math.min(newRightPosition, maxRightPosition);
          setRightMargin(constrainedRightPosition);
        }
      }
    }
  }

  const handleMouseUp = () => {
    setIsDraggingLeft(false);
    setIsDraggingRight(false);
  };

  const handleLeftDoubleClick = () => {
    setLeftMargin(LEFT_MARGIN_DEFAULT);
  };

  const handleRightDoubleClick = () => {
    setRightMargin(RIGHT_MARGIN_DEFAULT);
  };

  // Keyboard adjustments respect the same MINIMUM_SPACE constraint as drag.
  const adjustLeft = (delta: number) => {
    const PAGE_WIDTH = 816;
    const MINIMUM_SPACE = 100;
    const maxLeftPosition = PAGE_WIDTH - rightMargin - MINIMUM_SPACE;
    const next = Math.max(0, Math.min(leftMargin + delta, maxLeftPosition));
    setLeftMargin(next);
  };

  const adjustRight = (delta: number) => {
    // The right margin is stored as distance-from-right-edge.
    const PAGE_WIDTH = 816;
    const MINIMUM_SPACE = 100;
    const maxRightPosition = PAGE_WIDTH - (leftMargin + MINIMUM_SPACE);
    const nextRight = Math.max(0, Math.min(rightMargin - delta, maxRightPosition));
    setRightMargin(nextRight);
  };

  return (
    <div
      ref={rulerRef}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      onMouseLeave={handleMouseUp}
      className="w-[816px] min-w-max mx-auto h-6 border-b border-gray-300 flex items-end relative select-none print:hidden">
      <div
        id="ruler-container"
        className="w-full h-full relative"
      >
        <Marker
          position={leftMargin}
          isLeft={true}
          isDragging={isDraggingLeft}
          onMouseDown={handleLeftMouseDown}
          onDoubleClick={handleLeftDoubleClick}
          onKeyboardAdjust={adjustLeft}
        />
        <Marker
          position={rightMargin}
          isLeft={false}
          isDragging={isDraggingRight}
          onMouseDown={handleRightMouseDown}
          onDoubleClick={handleRightDoubleClick}
          onKeyboardAdjust={adjustRight}
        />
        <div className="absolute inset-x-0 bottom-0 h-full">
          <div className="relative h-full w-[816px]">
            {markers.map((marker) => {
              const position = (marker * 816) / 82;

              return (
                <div
                  key={marker}
                  className="absolute bottom-0"
                  style={{ left: `${position}px` }}
                >
                  {marker % 10 === 0 && (
                    <>
                      <div className="absolute bottom-0 w-[1px] h-2 bg-neutral-500" />
                      <span className="absolute bottom-2 text-[10px] text-neutral-500 transform -translate-x-1/2">
                        {marker / 10 + 1}
                      </span>
                    </>
                  )}
                  {marker % 5 === 0 && marker % 10 !== 0 && (
                    <div className="absolute bottom-0 w-[1px] h-1.5 bg-neutral-500" />
                  )}
                  {marker % 5 !== 0 && (
                    <div className="absolute bottom-0 w-[1px] h-1 bg-neutral-500" />
                  )}
                </div>
              )
            })}
          </div>
        </div>
      </div>
    </div>
  );
};

interface MarkerProps {
  position: number;
  isLeft: boolean;
  isDragging: boolean;
  onMouseDown: () => void;
  onDoubleClick: () => void;
  /** Keyboard adjust: positive moves right, negative moves left (px). */
  onKeyboardAdjust: (delta: number) => void;
};

const Marker = ({
  position,
  isLeft,
  isDragging,
  onMouseDown,
  onDoubleClick,
  onKeyboardAdjust,
}: MarkerProps) => {
  const label = isLeft
    ? "Left page margin — drag or use arrow keys to adjust, double-click to reset"
    : "Right page margin — drag or use arrow keys to adjust, double-click to reset";
  return (
    <div
      className="absolute top-0 w-4 h-full cursor-ew-resize z-[5] group -ml-2"
      style={{ [isLeft ? "left" : "right"]: `${position}px` }}
      onMouseDown={onMouseDown}
      onDoubleClick={onDoubleClick}
      role="slider"
      tabIndex={0}
      aria-label={label}
      aria-orientation="horizontal"
      aria-valuemin={0}
      aria-valuemax={816}
      aria-valuenow={Math.round(position)}
      onKeyDown={(e) => {
        // 1px steps; shift = 10px. Home/End go to the extremes.
        const step = e.shiftKey ? 10 : 1;
        if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
          e.preventDefault();
          onKeyboardAdjust(e.key === "ArrowRight" ? step : -step);
        } else if (e.key === "Home") {
          e.preventDefault();
          onKeyboardAdjust(-position);
        } else if (e.key === "End") {
          e.preventDefault();
          onKeyboardAdjust(816 - position);
        }
      }}
    >
      <FaCaretDown className="absolute left-1/2 top-0 h-full fill-blue-500 transform -translate-x-1/2" aria-hidden="true" />
      <div
        className="absolute left-1/2 top-4 transform -translate-x-1/2"
        style={{
          height: "100vh",
          width: "1px",
          transform: "scaleX(0.5)",
          backgroundColor: "#3b72f6",
          display: isDragging ? "block" : "none",
        }}
      />
    </div>
  );
};
