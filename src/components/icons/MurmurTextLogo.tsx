import React from "react";

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
      {/* eslint-disable-next-line i18next/no-literal-string */}
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
        murmur
      </text>
    </svg>
  );
};

export default MurmurTextLogo;
