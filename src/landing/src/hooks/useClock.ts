import { useEffect, useState } from 'react';

export function useClock(): number {
  const [e, setE] = useState(0);

  useEffect(() => {
    const t0 = performance.now();
    const clock = setInterval(() => {
      setE((performance.now() - t0) / 1000);
    }, 80);
    return () => clearInterval(clock);
  }, []);

  return e;
}
