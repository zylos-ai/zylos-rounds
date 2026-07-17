import { useEffect, useRef } from 'react';

/**
 * Subtle center-out bar visualization driven by an AnalyserNode on the mic
 * stream. Pure canvas + rAF — never re-renders React per frame.
 */
export default function Waveform({ analyser, active }) {
  const canvasRef = useRef(null);

  useEffect(() => {
    const cv = canvasRef.current;
    if (!cv || !analyser || !active) return;
    const c2d = cv.getContext('2d');
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const cssW = cv.clientWidth || 260;
    const cssH = cv.clientHeight || 36;
    cv.width = Math.round(cssW * dpr);
    cv.height = Math.round(cssH * dpr);

    const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#6366f1';
    const data = new Uint8Array(analyser.frequencyBinCount);
    const BARS = 27;
    const gap = 3 * dpr;
    const bw = (cv.width - gap * (BARS - 1)) / BARS;
    let raf = 0;

    const draw = () => {
      raf = requestAnimationFrame(draw);
      analyser.getByteFrequencyData(data);
      c2d.clearRect(0, 0, cv.width, cv.height);
      c2d.fillStyle = accent;
      for (let i = 0; i < BARS; i++) {
        // center-out: middle bars follow low-frequency (voice) energy
        const d = Math.abs(i - (BARS - 1) / 2);
        const bin = 1 + Math.floor((d * 44) / ((BARS - 1) / 2 || 1));
        const v = (data[bin] || 0) / 255;
        const h = Math.max(2.5 * dpr, v * cv.height * 0.92);
        const x = i * (bw + gap);
        const y = (cv.height - h) / 2;
        c2d.globalAlpha = 0.3 + 0.7 * v;
        const r = Math.min(bw / 2, 2 * dpr);
        c2d.beginPath();
        c2d.roundRect(x, y, bw, h, r);
        c2d.fill();
      }
    };
    draw();
    return () => cancelAnimationFrame(raf);
  }, [analyser, active]);

  return <canvas ref={canvasRef} className="h-9 w-[260px] max-w-full" aria-hidden="true" />;
}
