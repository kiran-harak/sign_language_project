import { motion } from 'framer-motion'

// The 21 MediaPipe hand landmarks (open palm), in a 200×220 box.
const POINTS = [
  [100, 204],                                       // 0 wrist
  [70, 182], [50, 156], [38, 131], [30, 108],       // thumb
  [75, 122], [70, 86], [67, 62], [65, 39],          // index
  [100, 116], [100, 76], [100, 50], [100, 24],      // middle
  [124, 121], [129, 86], [132, 63], [134, 42],      // ring
  [144, 133], [153, 107], [159, 89], [164, 71],     // pinky
]
const BONES = [
  [0, 1], [1, 2], [2, 3], [3, 4],
  [0, 5], [5, 6], [6, 7], [7, 8],
  [5, 9], [9, 10], [10, 11], [11, 12],
  [9, 13], [13, 14], [14, 15], [15, 16],
  [13, 17], [0, 17], [17, 18], [18, 19], [19, 20],
]
const TIPS = new Set([4, 8, 12, 16, 20])

/**
 * Animated hand-skeleton illustration.
 * color — stroke/point colour (CSS value); accent — fingertip colour.
 * live  — fingertips pulse continuously.
 */
export default function HandLandmarks({ size = 200, color = 'var(--text-primary)', accent = 'var(--accent)', live = true, delay = 0, style }) {
  return (
    <svg width={size} height={size * 1.1} viewBox="0 0 200 220" fill="none" aria-hidden="true" style={{ overflow: 'visible', ...style }}>
      {BONES.map(([a, b], i) => (
        <motion.line
          key={`b${i}`}
          x1={POINTS[a][0]} y1={POINTS[a][1]} x2={POINTS[b][0]} y2={POINTS[b][1]}
          stroke={color} strokeOpacity={0.4} strokeWidth={1.4} strokeLinecap="round"
          initial={{ pathLength: 0 }}
          animate={{ pathLength: 1 }}
          transition={{ duration: 0.5, delay: delay + i * 0.035, ease: [0.16, 1, 0.3, 1] }}
        />
      ))}
      {POINTS.map(([x, y], i) => {
        const tip = TIPS.has(i)
        return (
          <g key={`p${i}`}>
            {tip && live && (
              <motion.circle
                cx={x} cy={y} r={4} fill="none" stroke={accent} strokeWidth={1}
                initial={{ opacity: 0, r: 4 }}
                animate={{ r: [4, 13], opacity: [0.7, 0] }}
                transition={{ duration: 2.2, repeat: Infinity, delay: delay + 0.9 + i * 0.07, ease: 'easeOut' }}
              />
            )}
            <motion.circle
              cx={x} cy={y} r={tip ? 4 : 2.6}
              fill={tip ? accent : 'var(--bg-base)'}
              stroke={tip ? accent : color} strokeWidth={1.4}
              initial={{ scale: 0, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              transition={{ type: 'spring', stiffness: 400, damping: 18, delay: delay + 0.15 + i * 0.03 }}
              style={{ transformOrigin: `${x}px ${y}px` }}
            />
          </g>
        )
      })}
    </svg>
  )
}
