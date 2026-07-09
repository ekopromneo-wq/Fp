import { useEffect, useRef } from 'react';

export default function Waveform({ analyserRef, isActive }) {
  const canvasRef = useRef(null);
  const frameRef = useRef(null);

  useEffect(() => {
    if (!isActive) {
      return undefined;
    }

    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');

    if (!canvas || !ctx) {
      return undefined;
    }

    const draw = () => {
      const analyser = analyserRef.current;
      const width = canvas.clientWidth;
      const height = canvas.clientHeight;

      if (canvas.width !== width) canvas.width = width;
      if (canvas.height !== height) canvas.height = height;

      ctx.clearRect(0, 0, width, height);

      if (analyser) {
        const bufferLength = analyser.fftSize;
        const data = new Uint8Array(bufferLength);
        analyser.getByteTimeDomainData(data);

        ctx.lineWidth = 2;
        ctx.strokeStyle = '#81d8d0';
        ctx.beginPath();

        const sliceWidth = width / bufferLength;
        let x = 0;

        for (let i = 0; i < bufferLength; i += 1) {
          const normalized = data[i] / 128 - 1;
          const y = height / 2 + (normalized * height) / 2;

          if (i === 0) {
            ctx.moveTo(x, y);
          } else {
            ctx.lineTo(x, y);
          }

          x += sliceWidth;
        }

        ctx.stroke();
      } else {
        ctx.strokeStyle = '#81d8d0';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(0, height / 2);
        ctx.lineTo(width, height / 2);
        ctx.stroke();
      }

      frameRef.current = requestAnimationFrame(draw);
    };

    frameRef.current = requestAnimationFrame(draw);

    return () => {
      if (frameRef.current !== null) {
        cancelAnimationFrame(frameRef.current);
        frameRef.current = null;
      }
    };
  }, [isActive, analyserRef]);

  return <canvas className="voice-panel-waveform" ref={canvasRef} />;
}
