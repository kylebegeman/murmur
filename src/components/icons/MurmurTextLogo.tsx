import React from "react";
import retroStageMicUrl from "@/assets/brand/retro-stage-mic.svg";

// Brand wordmark, deliberately not translated (see CONTRIBUTING_TRANSLATIONS.md).
const WORDMARK = "murmur";
const ACCESSIBLE_NAME = "Murmur";

const MurmurTextLogo = ({
  width,
  height,
  className,
}: {
  width?: number | string;
  height?: number | string;
  className?: string;
}) => {
  const numericWidth = typeof width === "number" ? width : undefined;
  const resolvedWidth = typeof width === "number" ? `${width}px` : width;
  const resolvedHeight = typeof height === "number" ? `${height}px` : height;
  const iconSize =
    numericWidth === undefined
      ? undefined
      : `${Math.max(28, Math.round(numericWidth * 0.28))}px`;
  const fontSize =
    numericWidth === undefined
      ? undefined
      : `${Math.max(24, Math.round(numericWidth * 0.2))}px`;

  return (
    <div
      aria-label={ACCESSIBLE_NAME}
      className={`inline-flex items-center justify-center gap-2 text-text ${className ?? ""}`}
      style={{
        width: resolvedWidth,
        height: resolvedHeight,
        fontSize,
      }}
    >
      <img
        src={retroStageMicUrl}
        alt=""
        aria-hidden="true"
        className="shrink-0 object-contain"
        style={{ width: iconSize, height: iconSize }}
      />
      <span aria-hidden="true" className="font-semibold leading-none">
        {WORDMARK}
      </span>
    </div>
  );
};

export default MurmurTextLogo;
