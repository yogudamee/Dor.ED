import React from 'react';

interface MiterOverlay45Props {
  visible: boolean;
  sharedY: number | null;
}

/**
 * Renders the 45° Width-Equal (宽相等) Auxiliary Projection Overlay in Quadrant 4
 * showing how the front-back width Y in Top View (H) reflects at 45° into Left View (W).
 */
export const MiterOverlay45: React.FC<MiterOverlay45Props> = ({ visible, sharedY }) => {
  if (!visible) return null;

  const sampleYs = [30, 48, 60, 72, 90];
  const activeY = sharedY !== null && sharedY >= 10 && sharedY <= 110 ? sharedY : null;

  // Map engineering Y [0..120] into SVG percentage [8%..88%]
  const mapCoord = (val: number) => 26 + val * 2.2;

  return (
    <div className="absolute inset-0 z-20 pointer-events-none overflow-hidden">
      <svg className="w-full h-full" viewBox="0 0 360 320" preserveAspectRatio="none">
        {/* Semi-transparent CAD drafting overlay backdrop */}
        <rect x="0" y="0" width="360" height="320" fill="rgba(11, 15, 23, 0.58)" />

        {/* 45-Degree Miter Line from Top-Left origin (26, 26) to Bottom-Right */}
        <line
          x1="26"
          y1="26"
          x2="310"
          y2="310"
          stroke="#10B981"
          strokeWidth="2.2"
        />
        <text
          x="195"
          y="182"
          fill="#10B981"
          fontSize="11"
          fontFamily="JetBrains Mono, monospace"
          fontWeight="bold"
        >
          45° 宽相等转折线 (Y_俯 = Y_左)
        </text>

        {/* Reference Width-Equal Turning Rays */}
        {sampleYs.map((yVal) => {
          const p = mapCoord(yVal);
          return (
            <g key={yVal} opacity="0.65">
              {/* Horizontal ray coming from Top View (left edge -> 45° line) */}
              <line
                x1="0"
                y1={p}
                x2={p}
                y2={p}
                stroke="#10B981"
                strokeWidth="1"
                strokeDasharray="4,4"
              />
              {/* Vertical ray going up to Left View (45° line -> top edge) */}
              <line
                x1={p}
                y1={p}
                x2={p}
                y2="0"
                stroke="#10B981"
                strokeWidth="1"
                strokeDasharray="4,4"
              />
              <circle cx={p} cy={p} r="3" fill="#10B981" />
              <text
                x={p + 5}
                y={p - 4}
                fill="#A7F3D0"
                fontSize="9.5"
                fontFamily="JetBrains Mono, monospace"
              >
                Y={yVal}
              </text>
            </g>
          );
        })}

        {/* Live Cursor Dynamic 45° Width-Equal Ray */}
        {activeY !== null && (
          <g>
            <line
              x1="0"
              y1={mapCoord(activeY)}
              x2={mapCoord(activeY)}
              y2={mapCoord(activeY)}
              stroke="#34D399"
              strokeWidth="2"
              strokeDasharray="6,3"
            />
            <line
              x1={mapCoord(activeY)}
              y1={mapCoord(activeY)}
              x2={mapCoord(activeY)}
              y2="0"
              stroke="#34D399"
              strokeWidth="2"
              strokeDasharray="6,3"
            />
            <circle cx={mapCoord(activeY)} cy={mapCoord(activeY)} r="5" fill="#34D399" />
            <rect
              x={mapCoord(activeY) + 8}
              y={mapCoord(activeY) - 18}
              width="98"
              height="18"
              rx="3"
              fill="#064E3B"
              stroke="#10B981"
            />
            <text
              x={mapCoord(activeY) + 13}
              y={mapCoord(activeY) - 6}
              fill="#ECFDF5"
              fontSize="10"
              fontFamily="JetBrains Mono, monospace"
              fontWeight="bold"
            >
              实时宽 Y={activeY.toFixed(1)}
            </text>
          </g>
        )}
      </svg>
    </div>
  );
};
