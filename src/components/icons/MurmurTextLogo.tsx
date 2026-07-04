import React from "react";

// Brand wordmark, deliberately not translated (see CONTRIBUTING_TRANSLATIONS.md).
const WORDMARK = "murmur";

const MurmurTextLogo = ({
  width,
  height,
  className,
}: {
  width?: number;
  height?: number;
  className?: string;
}) => {
  return (
    <svg
      width={width}
      height={height}
      className={className}
      viewBox="0 0 930 328"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <text
        x="465"
        y="164"
        textAnchor="middle"
        dominantBaseline="central"
        fill="currentColor"
        fontFamily="sans-serif"
        fontSize="220"
        fontWeight="600"
      >
        {WORDMARK}
      </text>
    </svg>
  );
};

export default MurmurTextLogo;
